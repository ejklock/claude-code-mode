import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodemodeBridge } from '../../hooks/bridge.ts'
import type { BridgeHost, CodemodeOutcome } from '../../hooks/bridge.ts'
import { ANSWER_PATH, EXPOSED_TOOLS, parseChildMessage, parseRunRequest } from '../../shared/protocol.ts'
import type { CallAnswer, ChildMessage, McpTool, RunRequest } from '../../shared/protocol.ts'

const CHILD = join(dirname(fileURLToPath(import.meta.url)), '../../child/main.ts')

type CallMessage = Extract<ChildMessage, { type: 'call' }>
type DoneMessage = Extract<ChildMessage, { type: 'done' }>
type Answerer = (call: CallMessage) => Omit<CallAnswer, 'id'>

type Outcome = {
  done: DoneMessage
  calls: CallMessage[]
  postedIds: number[]
  socketPath: string
  exitCode: number | null
}

function post(socketPath: string, answer: CallAnswer): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: ANSWER_PATH, method: 'POST' }, res => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
    req.end(JSON.stringify(answer))
  })
}

/** With `holdCalls` set, the answers wait for that many calls, then go out newest first. */
async function runChild(code: string, answerer: Answerer, holdCalls = 0): Promise<Outcome> {
  const child = spawn('node', [CHILD], { stdio: ['pipe', 'pipe', 'inherit'] })
  const exited = new Promise<number | null>(resolve => child.on('close', resolve))
  const run: RunRequest = { code, timeoutMs: 20_000 }
  child.stdin.end(JSON.stringify(run))

  const calls: CallMessage[] = []
  const answers: Promise<void>[] = []
  const postedIds: number[] = []
  let socketPath = ''
  let done: DoneMessage | undefined
  for await (const line of createInterface({ input: child.stdout })) {
    const message = parseChildMessage(line)
    assert.ok(message, `child wrote a line outside the protocol: ${line}`)
    if (message.type === 'listening') socketPath = message.socketPath
    if (message.type === 'call') {
      calls.push(message)
      if (holdCalls === 0) {
        answers.push(post(socketPath, { id: message.id, ...answerer(message) } as CallAnswer))
        postedIds.push(message.id)
      } else if (calls.length === holdCalls) {
        answers.push(postNewestFirst(socketPath, calls, answerer, postedIds))
      }
    }
    if (message.type === 'done') done = message
  }
  await Promise.all(answers)
  const exitCode = await exited
  assert.ok(done, 'child closed its output without a closing line')
  return { done, calls, postedIds, socketPath, exitCode }
}

async function postNewestFirst(
  socketPath: string,
  calls: CallMessage[],
  answerer: Answerer,
  postedIds: number[],
): Promise<void> {
  for (const call of [...calls].reverse()) {
    await post(socketPath, { id: call.id, ...answerer(call) } as CallAnswer)
    postedIds.push(call.id)
  }
}

function assertCleanExit(outcome: Outcome): void {
  assert.equal(outcome.exitCode, 0)
  assert.ok(outcome.socketPath.length > 0, 'the child never announced its socket')
  assert.equal(existsSync(outcome.socketPath), false, 'the socket file is left behind')
}

const answerByTool: Answerer = call =>
  call.tool === 'Read'
    ? { ok: true, text: 'FILE-BODY' }
    : { ok: true, text: 'codemode-ok' }

const denyBash: Answerer = call =>
  call.tool === 'Bash'
    ? { ok: false, error: 'Bash was denied by a permission rule' }
    : { ok: true, text: 'FILE-BODY' }

describe('the codemode child on a real socket', () => {
  it('Proves C4: Read and Bash answers both reach the script output', async () => {
    const outcome = await runChild(
      `text(await tools.Read({ file_path: '/a' })); text(await tools.Bash({ command: 'echo x' }))`,
      answerByTool,
    )
    assert.equal(outcome.done.ok, true)
    assert.match(outcome.done.output, /FILE-BODY/)
    assert.match(outcome.done.output, /codemode-ok/)
    assert.deepEqual(
      outcome.calls.map(call => [call.tool, call.input]),
      [
        ['Read', { file_path: '/a' }],
        ['Bash', { command: 'echo x' }],
      ],
    )
    assertCleanExit(outcome)
  })

  it('Proves C4: a denial answer is caught by the script and printed', async () => {
    const outcome = await runChild(
      `try { await tools.Bash({ command: 'echo denied' }) } catch (e) { text('caught: ' + e.message) }`,
      denyBash,
    )
    assert.equal(outcome.done.ok, true)
    assert.match(outcome.done.output, /caught: Bash was denied by a permission rule/)
    assertCleanExit(outcome)
  })

  it('Proves C4: an uncaught denial ends with an error that names it', async () => {
    const outcome = await runChild(`await tools.Bash({ command: 'echo denied' })`, denyBash)
    assert.equal(outcome.done.ok, false)
    assert.match(outcome.done.ok ? '' : outcome.done.error, /Bash was denied by a permission rule/)
    assertCleanExit(outcome)
  })

  it('Proves C4: a script that throws ends with its message', async () => {
    const outcome = await runChild(`throw new Error('boom from script')`, answerByTool)
    assert.equal(outcome.done.ok, false)
    assert.match(outcome.done.ok ? '' : outcome.done.error, /boom from script/)
    assertCleanExit(outcome)
  })

  it('Proves C4: a syntax error ends as an error', async () => {
    const outcome = await runChild(`const = ;`, answerByTool)
    assert.equal(outcome.done.ok, false)
    assertCleanExit(outcome)
  })

  it('Proves C4: a tool that is not exposed never reaches the mod', async () => {
    const outcome = await runChild(`await tools.NotebookEdit({ notebook_path: '/a' })`, answerByTool)
    assert.equal(outcome.done.ok, false)
    assert.match(outcome.done.ok ? '' : outcome.done.error, /NotebookEdit/)
    assert.deepEqual(outcome.calls, [])
    assertCleanExit(outcome)
  })

  it('Proves C1: Write then Edit reach the answer server with their inputs and their text comes back', async () => {
    const outcome = await runChild(
      `text(await tools.Write({ file_path: '/a', content: 'one' }))
       text(await tools.Edit({ file_path: '/a', old_string: 'one', new_string: 'two', replace_all: true }))`,
      call => ({ ok: true, text: `${call.tool}-done` }),
    )
    assert.equal(outcome.done.ok, true)
    assert.equal(outcome.done.output, 'Write-done\nEdit-done')
    assert.deepEqual(
      outcome.calls.map(call => [call.tool, call.input]),
      [
        ['Write', { file_path: '/a', content: 'one' }],
        ['Edit', { file_path: '/a', old_string: 'one', new_string: 'two', replace_all: true }],
      ],
    )
    assertCleanExit(outcome)
  })

  it('Proves concurrency: two calls in flight are answered newest first and each lands in its own slot', async () => {
    const outcome = await runChild(
      `const [file, shell] = await Promise.all([tools.Read({ file_path: '/a' }), tools.Bash({ command: 'echo x' })])
       text('read=' + file); text('bash=' + shell)`,
      answerByTool,
      2,
    )
    assert.equal(outcome.done.ok, true)
    assert.equal(outcome.done.output, 'read=FILE-BODY\nbash=codemode-ok')
    assert.deepEqual(outcome.calls.map(call => call.tool), ['Read', 'Bash'])
    assert.deepEqual(outcome.postedIds, [outcome.calls[1]?.id, outcome.calls[0]?.id])
    assertCleanExit(outcome)
  })
})

const FAKE_TOOLS: McpTool[] = [
  { name: 'mcp__fake__echo', description: 'Echoes text.' },
  { name: 'mcp__fake-srv__ping', description: 'Pings.' },
]

/** Runs a script against a child whose run request names `mcpTools`; every call answers `<tool>-answered`. */
async function runWithMcpTools(code: string, mcpTools: McpTool[]): Promise<Outcome> {
  const child = spawn('node', [CHILD], { stdio: ['pipe', 'pipe', 'inherit'] })
  const exited = new Promise<number | null>(resolve => child.on('close', resolve))
  child.stdin.end(JSON.stringify({ code, timeoutMs: 20_000, mcpTools }))
  const calls: CallMessage[] = []
  const answers: Promise<void>[] = []
  let socketPath = ''
  let done: DoneMessage | undefined
  for await (const line of createInterface({ input: child.stdout })) {
    const message = parseChildMessage(line)
    if (message?.type === 'listening') socketPath = message.socketPath
    if (message?.type === 'done') done = message
    if (message?.type === 'call') {
      calls.push(message)
      answers.push(post(socketPath, { id: message.id, ok: true, text: `${message.tool}-answered` }))
    }
  }
  await Promise.all(answers)
  const exitCode = await exited
  assert.ok(done, 'child closed its output without a closing line')
  return { done, calls, postedIds: calls.map(call => call.id), socketPath, exitCode }
}

describe("the codemode child declares the run request's MCP tools", () => {
  it('Proves C1: both flat forms reach the answer server with their names and inputs', async () => {
    const outcome = await runWithMcpTools(
      `text(await tools.mcp__fake__echo({ text: 'hi' }))
       text(await tools["mcp__fake-srv__ping"]({}))`,
      FAKE_TOOLS,
    )
    assert.equal(outcome.done.ok, true)
    assert.equal(outcome.done.output, 'mcp__fake__echo-answered\nmcp__fake-srv__ping-answered')
    assert.deepEqual(
      outcome.calls.map(call => [call.tool, call.input]),
      [
        ['mcp__fake__echo', { text: 'hi' }],
        ['mcp__fake-srv__ping', {}],
      ],
    )
    assertCleanExit(outcome)
  })

  it('Proves C1: ALL_TOOLS lists the MCP tools beside the seven built-ins', async () => {
    const outcome = await runWithMcpTools(`text(JSON.stringify(ALL_TOOLS.map(tool => tool.name)))`, FAKE_TOOLS)
    assert.deepEqual(JSON.parse(outcome.done.output), [...EXPOSED_TOOLS, 'mcp__fake__echo', 'mcp__fake_srv__ping'])
    assertCleanExit(outcome)
  })

  it('Proves C1: a run request with no MCP tools declares the seven built-ins only', async () => {
    const outcome = await runChild(`text(JSON.stringify(ALL_TOOLS.map(tool => tool.name)))`, answerByTool)
    assert.deepEqual(JSON.parse(outcome.done.output), [...EXPOSED_TOOLS])
    assertCleanExit(outcome)
  })

  it('Proves C1: an MCP tool the request does not name is not callable', async () => {
    const outcome = await runChild(`await tools.mcp__fake__echo({})`, answerByTool)
    assert.equal(outcome.done.ok, false)
    assert.deepEqual(outcome.calls, [])
    assertCleanExit(outcome)
  })
})

describe('the run request parser reads MCP tools defensively', () => {
  const request = (mcpTools: unknown): string => JSON.stringify({ code: 'x', timeoutMs: 5, mcpTools })

  it('Proves C1: a well-formed list is kept as is', () => {
    assert.deepEqual(parseRunRequest(request(FAKE_TOOLS)), { code: 'x', timeoutMs: 5, mcpTools: FAKE_TOOLS })
  })

  it('Proves C1: a request without the list has no MCP tools', () => {
    assert.deepEqual(parseRunRequest(JSON.stringify({ code: 'x', timeoutMs: 5 })), { code: 'x', timeoutMs: 5, mcpTools: [] })
  })

  const malformed: [string, unknown][] = [
    ['a non-array list', { name: 'mcp__a__b', description: 'd' }],
    ['an entry with no name', [{ description: 'd' }]],
    ['an entry with an empty name', [{ name: '', description: 'd' }]],
    ['an entry with a non-string description', [{ name: 'mcp__a__b', description: 3 }]],
    ['an entry that is not an object', ['mcp__a__b']],
  ]
  it('Proves C1: a non-array list and each malformed entry are rejected', () => {
    const accepted = malformed.filter(([, list]) => parseRunRequest(request(list)) !== undefined)
    assert.deepEqual(accepted.map(([title]) => title), [])
  })

  it('Proves C1: the child ends a malformed request as it always did', async () => {
    const child = spawn('node', [CHILD], { stdio: ['pipe', 'pipe', 'inherit'] })
    child.stdin.end(request('not a list'))
    const lines: string[] = []
    for await (const line of createInterface({ input: child.stdout })) lines.push(line)
    assert.deepEqual(
      lines.map(line => parseChildMessage(line)),
      [{ type: 'done', ok: false, error: 'the run request on standard input is malformed', output: '' }],
    )
  })
})

describe('the codemode child keeps its output within the budget', () => {
  const marked = /whole output is in (\S+output\.txt)/

  /** Reads the file a marker names, then removes its folder so the run leaves nothing behind. */
  function spilledText(output: string): string {
    const path = marked.exec(output)?.[1]
    assert.ok(path, `no marker in the output: ${output.slice(0, 200)}`)
    const text = readFileSync(path, 'utf8')
    rmSync(dirname(path), { recursive: true })
    return text
  }

  it('Proves C3: an ok run printing 30,000 characters is cut and the whole output is in the named file', async () => {
    const outcome = await runChild(`text('x'.repeat(30000))`, answerByTool)
    assert.equal(outcome.done.ok, true)
    assert.ok(outcome.done.output.length < 21_000)
    assert.equal(spilledText(outcome.done.output), 'x'.repeat(30_000))
  })

  it('Proves C3: a failed run printing 30,000 characters is cut the same way', async () => {
    const outcome = await runChild(`text('y'.repeat(30000)); throw new Error('after the output')`, answerByTool)
    assert.equal(outcome.done.ok, false)
    assert.ok(outcome.done.output.length < 21_000)
    assert.equal(spilledText(outcome.done.output), 'y'.repeat(30_000))
  })

  it('Proves C3: a run printing 100 characters returns them unchanged and names no file', async () => {
    const outcome = await runChild(`text('z'.repeat(100))`, answerByTool)
    assert.equal(outcome.done.output, 'z'.repeat(100))
    assert.doesNotMatch(outcome.done.output, marked)
  })
})

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

/** A host with inert defaults; a test overrides the parts it drives. */
const makeHost = (overrides: Partial<BridgeHost>): BridgeHost => ({
  pluginRoot: PLUGIN_ROOT,
  spawn: () => {
    throw new Error('this test gave the host no spawn')
  },
  callTool: async () => ({ result: 'unused', text: 'FILE-BODY' }) as Awaited<ReturnType<BridgeHost['callTool']>>,
  listTools: async () => [],
  post: async () => {
    throw new Error('this test gave the host no post')
  },
  publish: async () => {},
  now: async () => 1_000,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  ...overrides,
})

/** Runs the bridge over the real child; nested calls answer after `answerDelayMs`, by which time a failed script has taken the child down. */
async function runBridge(code: string, answerDelayMs: number): Promise<CodemodeOutcome> {
  const host = makeHost({
    spawn: spawnRequest => {
      const child = spawn(spawnRequest.argv[0] ?? 'node', spawnRequest.argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdin.end(spawnRequest.input ?? '')
      const exited = new Promise<number | null>(resolve => child.on('close', resolve))
      return (async function* () {
        for await (const text of child.stdout) yield { stream: 'stdout' as const, text: String(text) }
        return { code: await exited, signal: null }
      })() as ReturnType<BridgeHost['spawn']>
    },
    callTool: async () => {
      await new Promise(resolve => setTimeout(resolve, answerDelayMs))
      return { result: 'unused', text: 'FILE-BODY' } as Awaited<ReturnType<BridgeHost['callTool']>>
    },
    post: (url, init) =>
      new Promise((resolve, reject) => {
        const req = request({ socketPath: init.socketPath, path: new URL(url).pathname, method: 'POST' }, res => {
          res.resume()
          res.on('end', () => resolve({ status: 204, ok: true, headers: {}, text: '' }))
        })
        req.on('error', reject)
        req.end(init.body)
      }),
  })
  return new CodemodeBridge(host, 20_000).run(code, 'run-1')
}

const failureOf = (outcome: CodemodeOutcome): string => {
  assert.equal(outcome.ok, false)
  return outcome.ok ? '' : outcome.error
}

describe('a script error with nested calls pending', () => {
  const reads = (count: number): string =>
    Array.from({ length: count }, (_, index) => `tools.Read({ file_path: '/f${index}' })`).join('; ')

  for (const count of [1, 3]) {
    it(`Proves C2: a ReferenceError after ${count} started call(s) leads the failure and the ledger lists every call`, async () => {
      const failure = failureOf(await runBridge(`${reads(count)}; missingIdentifier`, 800))
      const first = failure.split('\n')[0] ?? ''
      assert.match(first, /ReferenceError/)
      assert.match(first, /missingIdentifier/)
      for (let id = 1; id <= count; id++) assert.match(failure, new RegExp(`#${id} Read`))
      const late = failure.indexOf('could not reach the child')
      assert.ok(late === -1 || late > failure.indexOf('ReferenceError'), 'a late answer led the failure')
    })
  }

  it('Proves C2: a script that throws with no nested call ends with its message alone', async () => {
    const failure = failureOf(await runBridge(`throw new Error('boom from script')`, 0))
    assert.match(failure.split('\n')[0] ?? '', /boom from script/)
    assert.doesNotMatch(failure, /could not reach the child/)
  })

  it('Proves C2: a script whose nested call succeeds on its own is unchanged', async () => {
    const outcome = await runBridge(`text(await tools.Read({ file_path: '/f' }))`, 0)
    assert.equal(outcome.ok, true)
  })
})

type ScriptedEnd = 'closing-after-failure' | 'silent-alive' | 'exit-without-closing' | 'malformed-silent'

const jsonLine = (message: ChildMessage): string => `${JSON.stringify(message)}\n`

/**
 * A bridge over a scripted child: it announces a socket and asks for one tool, and the
 * answer POST always fails. Only after that failure is recorded does the child end as `end` says.
 */
async function runScripted(end: ScriptedEnd): Promise<{ outcome: CodemodeOutcome; elapsedMs: number }> {
  let postFailed!: () => void
  const failureRecorded = new Promise<void>(resolve => {
    postFailed = resolve
  })
  const never = new Promise<never>(() => {})
  const chunks = (async function* () {
    yield { stream: 'stdout' as const, text: jsonLine({ type: 'listening', socketPath: '/scripted.sock' }) }
    if (end !== 'malformed-silent') {
      yield { stream: 'stdout' as const, text: jsonLine({ type: 'call', id: 1, tool: 'Read', input: { file_path: '/f' } }) }
    }
    if (end === 'malformed-silent') {
      yield { stream: 'stdout' as const, text: 'this is not a protocol line\n' }
      await never
    }
    await failureRecorded
    await new Promise(resolve => setTimeout(resolve, 50))
    if (end === 'silent-alive') await never
    if (end === 'closing-after-failure') {
      yield { stream: 'stdout' as const, text: jsonLine({ type: 'done', ok: false, error: 'ReferenceError: nope is not defined', output: '' }) }
    }
    return { code: 1, signal: null }
  })()
  const host = makeHost({
    spawn: () => chunks as unknown as ReturnType<BridgeHost['spawn']>,
    post: async () => {
      postFailed()
      throw new Error('socket hung up')
    },
  })
  const started = Date.now()
  const outcome = await new CodemodeBridge(host, 20_000).run('unused', 'run-1')
  return { outcome, elapsedMs: Date.now() - started }
}

describe('a late-answer failure recorded before the closing line is read', () => {
  it('Proves C3: the closing line that follows leads, and the delivery problem follows it', async () => {
    const failure = failureOf((await runScripted('closing-after-failure')).outcome)
    assert.match(failure.split('\n')[0] ?? '', /ReferenceError: nope is not defined/)
    assert.ok(
      failure.indexOf('could not reach the child') > failure.indexOf('ReferenceError'),
      'the delivery problem did not follow the script error',
    )
  })

  it('Proves C3: a child that stays silent and alive returns the delivery problem within the bound, not at the script timeout', async () => {
    const { outcome, elapsedMs } = await runScripted('silent-alive')
    assert.match(failureOf(outcome).split('\n')[0] ?? '', /could not reach the child: socket hung up/)
    assert.ok(elapsedMs < 5_000, `waited ${elapsedMs} ms for a closing line that never came`)
  })

  it('Proves C3: a malformed child line stops the read at once, without the closing-line grace', async () => {
    const { outcome, elapsedMs } = await runScripted('malformed-silent')
    assert.match(failureOf(outcome).split('\n')[0] ?? '', /sent a malformed line: this is not a protocol line/)
    assert.ok(elapsedMs < 1_000, `waited ${elapsedMs} ms after a malformed line`)
  })

  it('Proves C3: a child that exits with no closing line reports the delivery problem alone', async () => {
    const failure = failureOf((await runScripted('exit-without-closing')).outcome)
    assert.match(failure.split('\n')[0] ?? '', /could not reach the child: socket hung up/)
    assert.doesNotMatch(failure, /ReferenceError/)
  })
})
