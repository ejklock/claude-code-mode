import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import { classifySavingsRun, failingSuite, measureStream, parseRunResult, summarizeSavings } from '../../scripts/savings.ts'
import type { SavingsSample } from '../../scripts/savings.ts'

const answer = 'the answer text'

/** A stand-in result stream shaped as the real one: an event array ending in the result record. */
const standInStream = (result: Record<string, unknown>): string =>
  JSON.stringify([
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5', claude_code_version: '2.1.292' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__codemode__codemode' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 4, output_tokens: 217, cache_creation_input_tokens: 19284, cache_read_input_tokens: 17174 },
      num_turns: 2,
      total_cost_usd: 0.162,
      duration_ms: 4609,
      result: answer,
      ...result,
    },
  ])

const parsed = {
  isError: false,
  inputTokens: 4,
  outputTokens: 217,
  cacheWriteTokens: 19284,
  cacheReadTokens: 17174,
  turns: 2,
  costUsd: 0.162,
  ms: 4609,
  resultText: answer,
  tools: ['mcp__codemode__codemode', 'Read'],
  model: 'claude-opus-5-5',
  claudeVersion: '2.1.292',
}

describe('the result stream parser', () => {
  it('Proves C2: a stream as the tool writes it parses into its numbers, answer and tool names', () => {
    assert.deepEqual(parseRunResult(standInStream({})), parsed)
  })

  it('Proves C2: a stream that is not JSON gives no result', () => {
    assert.equal(parseRunResult('not json'), undefined)
  })

  it('Proves C2: a stream with no result record gives no result', () => {
    assert.equal(parseRunResult(JSON.stringify([{ type: 'assistant', message: { content: [] } }])), undefined)
  })

  it('Proves C2: a result record missing a usage number gives no result', () => {
    const broken = standInStream({ usage: { input_tokens: 4, output_tokens: 217, cache_creation_input_tokens: 19284 } })
    assert.equal(parseRunResult(broken), undefined)
  })

  it('Proves C2: a result record missing the turn count gives no result', () => {
    assert.equal(parseRunResult(standInStream({ num_turns: 'two' })), undefined)
  })

  it('Proves C2: an error result keeps its shape, for the classifier to refuse', () => {
    const outcome = parseRunResult(standInStream({ is_error: true, subtype: 'error_during_execution' }))
    assert.equal(outcome?.isError, true)
  })
})

describe('the run classifier', () => {
  it('Proves C2: a spawn error fails the run', () => {
    const outcome = classifySavingsRun({ error: new Error('spawnSync claude ENOENT'), status: null, stdout: '' })
    assert.deepEqual(outcome, { ok: false, reason: 'spawn failed: spawnSync claude ENOENT' })
  })

  it('Proves C2: a non-zero status fails the run', () => {
    const outcome = classifySavingsRun({ status: 1, stdout: standInStream({}) })
    assert.deepEqual(outcome, { ok: false, reason: 'exit status 1' })
  })

  it('Proves C2: a stream without a result record fails the run', () => {
    const outcome = classifySavingsRun({ status: 0, stdout: 'not json' })
    assert.deepEqual(outcome, { ok: false, reason: 'the output holds no result record' })
  })

  it('Proves C2: a stream that ended in error fails the run with the reason', () => {
    const outcome = classifySavingsRun({ status: 0, stdout: standInStream({ is_error: true }) })
    assert.deepEqual(outcome, { ok: false, reason: 'claude ended the run with an error' })
  })

  it('Proves C2: a well-ended run hands back its parsed result', () => {
    const outcome = classifySavingsRun({ status: 0, stdout: standInStream({}) })
    assert.deepEqual(outcome, { ok: true, run: parsed })
  })
})

const sample = (task: string, side: 'with' | 'without', correct: boolean, usedCodemode: boolean, input: number, turns: number): SavingsSample => ({
  task,
  side,
  correct,
  usedCodemode,
  input,
  output: 200,
  cacheWrite: 17000,
  cacheRead: 171,
  turns,
  cost: 0.05,
  ms: 5000,
})

describe('the summary of one task and side', () => {
  it('Proves C2: a wrong answer is left out of every median and range and counted apart, its codemode use with it', () => {
    const rows = summarizeSavings([
      sample('todos', 'with', true, true, 100, 2),
      sample('todos', 'with', true, true, 300, 4),
      sample('todos', 'with', false, true, 50, 9),
    ])
    assert.deepEqual(rows, [
      {
        task: 'todos',
        side: 'with',
        runs: 3,
        correct: 2,
        wrong: 1,
        usedCodemode: 2,
        median: { input: 200, output: 200, cacheWrite: 17000, cacheRead: 171, turns: 3, cost: 0.05, ms: 5000 },
        inputRange: [100, 300],
        turnsRange: [2, 4],
      },
    ])
  })

  it('Proves C2: a task whose every answer is wrong has no medians and no ranges, only the counts', () => {
    const rows = summarizeSavings([sample('todos', 'without', false, false, 50, 9)])
    assert.deepEqual(rows, [
      { task: 'todos', side: 'without', runs: 1, correct: 0, wrong: 1, usedCodemode: 0, median: undefined, inputRange: undefined, turnsRange: undefined },
    ])
  })

  it('Proves C2: the rows come as the tasks were given, the with side before the without', () => {
    const rows = summarizeSavings([
      sample('todos', 'without', true, false, 100, 8),
      sample('grep', 'with', true, true, 100, 1),
      sample('todos', 'with', true, true, 100, 2),
    ])
    assert.deepEqual(rows.map(row => [row.task, row.side]), [
      ['todos', 'with'],
      ['todos', 'without'],
      ['grep', 'with'],
    ])
  })
})

const resultEvent = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  usage: { input_tokens: 4, output_tokens: 217, cache_creation_input_tokens: 19284, cache_read_input_tokens: 17174 },
  num_turns: 2,
  total_cost_usd: 0.162,
  duration_ms: 4609,
  result: answer,
}

const initEvent = { type: 'system', subtype: 'init', model: 'claude-opus-5-5', claude_code_version: '2.1.292' }

const toolUse = (messageId: string, toolId: string, name: string): Record<string, unknown> => ({
  type: 'assistant',
  message: { id: messageId, content: [{ type: 'tool_use', id: toolId, name }] },
})

const textTurn = (messageId: string): Record<string, unknown> => ({
  type: 'assistant',
  message: { id: messageId, content: [{ type: 'text', text: 'the answer' }] },
})

const toolResult = (toolId: string, content: unknown): Record<string, unknown> => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: toolId, content }] },
})

/** Stream-json as the tool writes it: one event per line. */
const lines = (...events: unknown[]): string => events.map(event => JSON.stringify(event)).join('\n')

describe('the stream-json parser', () => {
  it('Proves C1: a line stream parses into the same numbers as the final result event holds', () => {
    const stream = lines(initEvent, toolUse('m1', 't1', 'Read'), toolResult('t1', 'x'), textTurn('m2'), resultEvent)
    assert.deepEqual(parseRunResult(stream), { ...parsed, tools: ['Read'] })
  })

  it('Proves C1: a run with no tool calls reports no context output', () => {
    assert.equal(measureStream(lines(initEvent, textTurn('m1'), resultEvent)).ctxOut, 0)
  })

  it('Proves C1: two tool results of 100 and 250 characters give 350', () => {
    const stream = lines(
      toolUse('m1', 't1', 'Bash'),
      toolResult('t1', 'a'.repeat(100)),
      toolUse('m2', 't2', 'Bash'),
      toolResult('t2', 'b'.repeat(250)),
      resultEvent,
    )
    assert.equal(measureStream(stream).ctxOut, 350)
  })

  it('Proves C1: a tool result made of blocks sums its text blocks and ignores the others', () => {
    const blocks = [{ type: 'text', text: 'a'.repeat(30) }, { type: 'image', source: 'z'.repeat(999) }, { type: 'text', text: 'b'.repeat(12) }]
    const stream = lines(toolUse('m1', 't1', 'Read'), toolResult('t1', blocks), resultEvent)
    assert.equal(measureStream(stream).ctxOut, 42)
  })

  it('Proves C1: a malformed line is skipped and the run is still parsed', () => {
    const stream = [JSON.stringify(initEvent), '{"type": "assist', JSON.stringify(resultEvent)].join('\n')
    assert.equal(parseRunResult(stream)?.turns, 2)
  })

  it('Proves C1: a stream with no result event is an error outcome', () => {
    const outcome = classifySavingsRun({ status: 0, stdout: lines(initEvent, textTurn('m1')) })
    assert.deepEqual(outcome, { ok: false, reason: 'the output holds no result record' })
  })

  it('Proves C1: the init event is found past the hook events that precede it', () => {
    const hook = { type: 'system', subtype: 'hook_started' }
    assert.equal(parseRunResult(lines(hook, initEvent, resultEvent))?.model, 'claude-opus-5-5')
  })
})

describe('the turn trace', () => {
  it('Proves C2: a three-turn stream prints three lines in order', () => {
    const stream = lines(
      toolUse('m1', 't1', 'Bash'),
      toolResult('t1', 'a'.repeat(120)),
      toolUse('m2', 't2', 'Read'),
      toolResult('t2', 'b'.repeat(30)),
      textTurn('m3'),
      resultEvent,
    )
    assert.deepEqual(measureStream(stream).trace, [
      'turn 1: Bash -> 120 chars',
      'turn 2: Read -> 30 chars',
      'turn 3: (answer)',
    ])
  })

  it('Proves C2: a turn with two tool calls lists both and the sum of their results', () => {
    const stream = lines(
      toolUse('m1', 't1', 'Write'),
      toolUse('m1', 't2', 'Write'),
      toolResult('t1', 'ok'),
      toolResult('t2', 'done!'),
      textTurn('m2'),
      resultEvent,
    )
    assert.deepEqual(measureStream(stream).trace, ['turn 1: Write, Write -> 7 chars', 'turn 2: (answer)'])
  })

  it('Proves C2: a thinking-only block before the tool call stays one turn', () => {
    const thinking = { type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '' }] } }
    const stream = lines(thinking, toolUse('m1', 't1', 'Read'), toolResult('t1', 'abc'), textTurn('m2'), resultEvent)
    assert.deepEqual(measureStream(stream).trace, ['turn 1: Read -> 3 chars', 'turn 2: (answer)'])
  })
})

describe('the context-output column', () => {
  it('Proves C2: the median and the range come from the correct runs only', () => {
    const withCtx = (ctxOut: number, correct: boolean): SavingsSample => ({ ...sample('todos', 'with', correct, true, 100, 2), ctxOut })
    const [row] = summarizeSavings([withCtx(100, true), withCtx(300, true), withCtx(9, false)])
    assert.equal(row?.median?.ctxOut, 200)
    assert.deepEqual(row?.ctxOutRange, [100, 300])
  })
})

describe('the test-failures fixture', () => {
  it('Proves C1: node --test reports exactly the two named failures and at least 150 passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'failing-suite-'))
    try {
      for (const [path, content] of Object.entries(failingSuite())) {
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        writeFileSync(join(dir, path), content)
      }
      const { NODE_TEST_CONTEXT: _inherited, ...env } = process.env
      const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: dir, encoding: 'utf8', env })
      const failed = [...run.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)]
        .map(match => match[1] ?? '')
        .filter(name => !name.startsWith('module ') && name !== 'billing' && !name.endsWith('.js'))
      const passed = [...run.stdout.matchAll(/^\s*ok \d+ - /gm)].length
      assert.deepEqual(failed.sort(), ['rejects an expired coupon', 'rounds invoice totals to cents'])
      assert.ok(passed >= 150, `only ${passed} passed`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
