import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ANSWER_PATH, parseChildMessage } from '../../shared/protocol.ts'
import type { CallAnswer, ChildMessage, RunRequest } from '../../shared/protocol.ts'

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
