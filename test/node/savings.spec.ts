import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifySavingsRun, parseRunResult, summarizeSavings } from '../../scripts/savings.ts'
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
