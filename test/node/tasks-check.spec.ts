import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as check from '../../scripts/tasks-check.ts'
import * as fixture from '../fixtures/tasks-mcp-server.ts'

const { classifyLog } = check

const TASKS = 'io.modelcontextprotocol/tasks'
const CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'

const logOf = (...requests: unknown[]): string => requests.map(request => JSON.stringify(request)).join('\n')

const discover = (capabilities: unknown) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'server/discover',
  params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', [CAPABILITIES]: capabilities } },
})

describe('classifyLog', () => {
  it('declared when the meta client capabilities carry the tasks extension', () => {
    const capabilities = { roots: {}, extensions: { [TASKS]: {} } }
    const verdict = classifyLog(logOf(discover(capabilities)))
    assert.deepEqual(verdict, { kind: 'declared', protocol: '2026-07-28', capabilities })
  })

  it('not declared when the meta client capabilities carry no tasks extension', () => {
    const capabilities = { roots: {}, elicitation: {} }
    const verdict = classifyLog(logOf(discover(capabilities)))
    assert.deepEqual(verdict, { kind: 'not declared', protocol: '2026-07-28', capabilities })
  })

  it('not declared, protocol named, when only an initialize without capabilities extensions was sent', () => {
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { roots: {} } } }
    const verdict = classifyLog(logOf(initialize, { jsonrpc: '2.0', method: 'notifications/initialized' }))
    assert.deepEqual(verdict, { kind: 'not declared', protocol: '2025-11-25', capabilities: { roots: {} } })
  })

  it('not declared when an initialize request names no capabilities at all', () => {
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }
    assert.deepEqual(classifyLog(logOf(initialize)), { kind: 'not declared', protocol: '2025-11-25' })
  })

  it('declared when an initialize request declares the tasks extension in its capabilities', () => {
    const capabilities = { extensions: { [TASKS]: {} } }
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities } }
    assert.deepEqual(classifyLog(logOf(initialize)), { kind: 'declared', protocol: '2025-11-25', capabilities })
  })

  it('declared when a later request declares the tasks extension after an earlier one did not', () => {
    const later = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: { [CAPABILITIES]: { extensions: { [TASKS]: {} } } } } }
    const verdict = classifyLog(logOf(discover({ roots: {} }), later))
    assert.equal(verdict.kind, 'declared')
  })

  it('cannot tell from an empty log', () => {
    assert.deepEqual(classifyLog(''), { kind: 'cannot tell' })
  })

  it('cannot tell from a log with a malformed line', () => {
    assert.deepEqual(classifyLog(`${logOf(discover({ roots: {} }))}\n{not json`), { kind: 'cannot tell' })
  })

  it('cannot tell from a log whose requests carry no capabilities and no initialize', () => {
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    assert.deepEqual(classifyLog(logOf(request)), { kind: 'cannot tell' })
  })

  it('names the protocol of the request that declared the extension, not of the first request', () => {
    const capabilities = { extensions: { [TASKS]: {} } }
    const later = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-09-01', [CAPABILITIES]: capabilities } },
    }
    const verdict = classifyLog(logOf(discover({ roots: {} }), later))
    assert.deepEqual(verdict, { kind: 'declared', protocol: '2026-09-01', capabilities })
  })

  it('skips a log line that is valid JSON but not an object', () => {
    const capabilities = { extensions: { [TASKS]: {} } }
    const verdict = classifyLog(`42\n[1,2]\nnull\n${logOf(discover(capabilities))}`)
    assert.deepEqual(verdict, { kind: 'declared', protocol: '2026-07-28', capabilities })
  })
})

describe('fixture answers', () => {
  const isTimestamp = (value: unknown): boolean => typeof value === 'string' && new Date(value).toISOString() === value

  const assertTaskFields = (answer: Record<string, unknown>, status: string): void => {
    assert.equal(answer['taskId'], 'task-1')
    assert.equal(answer['status'], status)
    assert.ok(isTimestamp(answer['createdAt']), 'createdAt is an ISO 8601 timestamp')
    assert.ok(isTimestamp(answer['lastUpdatedAt']), 'lastUpdatedAt is an ISO 8601 timestamp')
    assert.ok(answer['ttlMs'] === null || Number.isInteger(answer['ttlMs']), 'ttlMs is an integer or null')
    assert.ok(Number.isInteger(answer['pollIntervalMs']), 'pollIntervalMs is an integer')
  }

  it('answers tools/call with a task handle carrying the task fields', () => {
    const answer = fixture.createTaskResult()
    assert.equal(answer.resultType, 'task')
    assertTaskFields(answer, 'working')
  })

  it('answers the first tasks/get with a complete result for a working task', () => {
    const answer = fixture.taskAnswer(1)
    assert.equal(answer.resultType, 'complete')
    assertTaskFields(answer, 'working')
  })

  it('answers a later tasks/get with the call result nested under result, not inline', () => {
    const answer = fixture.taskAnswer(2)
    assert.equal(answer.resultType, 'complete')
    assertTaskFields(answer, 'completed')
    assert.deepEqual(answer.result?.content, [{ type: 'text', text: 'long-job-finished' }])
    assert.equal('content' in answer, false)
  })

  it('answers server/discover with a complete result advertising the tasks extension', () => {
    const answer = fixture.discoverResult()
    assert.equal(answer.resultType, 'complete')
    assert.notEqual(answer.capabilities.extensions[TASKS], undefined)
  })

  it('answers server/discover with the cache fields and the server info under the result meta', () => {
    const answer = fixture.discoverResult() as Record<string, unknown>
    assert.ok(Number.isInteger(answer['ttlMs']) && (answer['ttlMs'] as number) >= 0, 'ttlMs is a non-negative integer')
    assert.ok(answer['cacheScope'] === 'public' || answer['cacheScope'] === 'private', 'cacheScope is public or private')
    assert.deepEqual(answer['_meta'], { 'io.modelcontextprotocol/serverInfo': { name: 'tasks', version: '1.0.0' } })
    assert.equal('serverInfo' in answer, false)
  })

  it('answers a completed task with a call result that names its result type', () => {
    const answer = fixture.taskAnswer(2)
    assert.deepEqual(answer.result, { resultType: 'complete', content: [{ type: 'text', text: 'long-job-finished' }] })
  })

  it('answers tools/list with a complete result carrying the cache fields', () => {
    const answer = fixture.toolsListResult() as Record<string, unknown>
    assert.equal(answer['resultType'], 'complete')
    assert.ok(Number.isInteger(answer['ttlMs']) && (answer['ttlMs'] as number) >= 0, 'ttlMs is a non-negative integer')
    assert.ok(answer['cacheScope'] === 'public' || answer['cacheScope'] === 'private', 'cacheScope is public or private')
    assert.equal((answer['tools'] as { name: string }[])[0]?.name, 'long_job')
  })

  it('creates a task stamped with the given clock time and not yet past its time to live', () => {
    const now = new Date('2031-05-06T07:08:09.000Z')
    const answer = fixture.createTaskResult(now)
    assert.equal(answer.createdAt, now.toISOString())
    assert.equal(answer.lastUpdatedAt, now.toISOString())
    assert.ok(answer.ttlMs === null || now.getTime() <= new Date(answer.createdAt).getTime() + answer.ttlMs)
  })

  it('keeps the creation time on later answers and moves the last update to the clock', () => {
    const created = new Date('2031-05-06T07:08:09.000Z')
    const later = new Date('2031-05-06T07:08:10.000Z')
    fixture.createTaskResult(created)
    const answer = fixture.taskAnswer(2, later)
    assert.equal(answer.createdAt, created.toISOString())
    assert.equal(answer.lastUpdatedAt, later.toISOString())
  })
})

describe('report', () => {
  const declared = { kind: 'declared', protocol: '2026-07-28', capabilities: { extensions: { [TASKS]: {} } } } as const
  const resultStream = (text: string): string =>
    [
      JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'u1', name: 'mcp__codemode__codemode' }] } }),
      JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: text }] } }),
    ].join('\n')

  it('prints the verdict and the script result and exits zero when both are known', () => {
    const outcome = check.report(declared, { status: 0, stdout: resultStream('RECEIVED: done'), stderr: '' })
    assert.equal(outcome.code, 0)
    assert.match(outcome.out, /tasks extension: declared/)
    assert.match(outcome.out, /protocol: 2026-07-28/)
    assert.match(outcome.out, /script received: "RECEIVED: done"/)
  })

  it('prints the verdict and a separate missing-result line, exiting non-zero, when the script result is missing', () => {
    const outcome = check.report(declared, { status: 0, stdout: '', stderr: '' })
    assert.notEqual(outcome.code, 0)
    assert.match(outcome.out, /tasks extension: declared/)
    assert.doesNotMatch(outcome.out, /script received/)
    assert.match(outcome.err, /script result missing/)
  })

  it('reports cannot tell with the reason when the log is unusable', () => {
    const outcome = check.report({ kind: 'cannot tell' }, { status: 0, stdout: '', stderr: '' })
    assert.notEqual(outcome.code, 0)
    assert.doesNotMatch(outcome.out, /tasks extension/)
    assert.match(outcome.err, /cannot tell/)
  })

  it('names the error code and message when claude cannot be spawned, without throwing', () => {
    const error = Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' })
    const outcome = check.report({ kind: 'cannot tell' }, { error, status: null, stdout: null, stderr: null })
    assert.notEqual(outcome.code, 0)
    assert.match(outcome.err, /ENOENT.*spawnSync claude ENOENT/)
    assert.doesNotMatch(outcome.err, /TypeError/)
  })

  it('names the error code and message when the run times out, keeping a known verdict', () => {
    const error = Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT' })
    const outcome = check.report(declared, { error, status: null, stdout: '', stderr: '' })
    assert.notEqual(outcome.code, 0)
    assert.match(outcome.err, /ETIMEDOUT.*spawnSync claude ETIMEDOUT/)
    assert.match(outcome.out, /tasks extension: declared/)
  })
})

describe('the server the check spawns', () => {
  // A claude stand-in that starts the server named in --mcp-config exactly as given, asks it server/discover
  // over stdio and writes the first answer line to FAKE_ANSWER.
  const fakeClaude = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--mcp-config') + 1], 'utf8'))
const { command, args, env } = Object.values(config.mcpServers)[0]
const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
process.on('exit', () => child.kill())
process.on('SIGTERM', () => process.exit(1))
setTimeout(() => process.exit(1), 20000).unref()
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }) + '\\n')
for await (const line of createInterface({ input: child.stdout })) {
  writeFileSync(process.env.FAKE_ANSWER, line)
  break
}
child.kill()
`

  it('answers server/discover over stdio in the shape a declaring client parses', t => {
    const scratch = mkdtempSync(join(tmpdir(), 'tasks-check-spec-'))
    try {
      const bin = join(scratch, 'bin')
      mkdirSync(bin)
      const standIn = join(bin, 'claude')
      writeFileSync(standIn, fakeClaude, { mode: 0o755 })
      try {
        accessSync(standIn, constants.X_OK)
      } catch {
        t.skip(`the stand-in claude in ${bin} is not executable (noexec mount?); a PATH search would fall through to another claude`)
        return
      }
      symlinkSync(process.execPath, join(bin, 'node'))
      const answerFile = join(scratch, 'answer.json')
      const script = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/tasks-check.ts')
      const env = { ...process.env, PATH: bin, FAKE_ANSWER: answerFile }
      assert.deepEqual(env.PATH.split(delimiter), [bin])
      const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000, env })
      assert.ok(existsSync(answerFile), `no answer written: status ${run.status}, signal ${run.signal}, error ${run.error?.message}, stderr ${run.stderr}`)
      const answer = JSON.parse(readFileSync(answerFile, 'utf8')) as { result: Record<string, unknown> }
      assert.equal(answer.result['resultType'], 'complete')
      assert.deepEqual(answer.result['_meta'], { 'io.modelcontextprotocol/serverInfo': { name: 'tasks', version: '1.0.0' } })
      assert.equal(answer.result['cacheScope'], 'public')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
