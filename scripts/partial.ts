/**
 * Measures what a failed script costs in duplicated writes: a headless
 * `claude -p` session with the plugin and a fake store whose `create_record`
 * tool fails once, on its fourth call, asked to create six records. The store
 * logs every call to a ledger file; a record created more than once is a
 * duplicated write. A run that never used codemode is reported apart.
 *
 *   node scripts/partial.ts --runs 3
 *
 * `--task ambiguous` runs the same prompt against a store whose fourth create
 * takes effect but never answers (the call times out), and also reports whether
 * the model listed the store before redoing that record.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import { median } from './overhead.ts'
import { classifySavingsRun } from './savings.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = 'mcp__codemode__codemode'
const CREATE_TOOL = 'mcp__fake__create_record'
const SERVER = join(ROOT, 'test/fixtures/fake-mcp-server.mjs')
const LIST_TOOL = 'mcp__fake__list_records'
const RUN_TIMEOUT_MS = 300_000
const LOST_ANSWER_TIMEOUT_MS = 5_000
const RECORDS = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']
const PROMPT = `Using the fake store's create_record tool, create the records ${RECORDS.join(', ')}, and make sure each one exists when you are done.`

export type LedgerMeasure = { attempted: number; distinct: number; duplicates: number; complete: boolean }

export type PartialSample = {
  usedCodemode: boolean
  attempted: number
  distinct: number
  duplicates: number
  complete: boolean
  /** Only the ambiguous task has a verdict: whether the lost record was listed before it was redone. */
  checked?: boolean
  turns: number
  output: number
  cost: number
  ms: number
}

type Metric = 'attempted' | 'distinct' | 'duplicates' | 'turns' | 'output' | 'cost' | 'ms'

const METRICS: readonly Metric[] = ['attempted', 'distinct', 'duplicates', 'turns', 'output', 'cost', 'ms']

export type PartialSummary = {
  runs: number
  counted: number
  withoutCodemode: number
  incomplete: number
  median: Record<Metric, number> | undefined
}

/** The ledger holds one `ok` or `fail` line per create call; duplicates are successes beyond the distinct names. */
export function measureLedger(ledger: string, expected: readonly string[]): LedgerMeasure {
  const calls = ledger.split('\n').filter(line => line.startsWith('ok\t') || line.startsWith('fail\t'))
  const created = calls.flatMap(line => (line.startsWith('ok\t') ? [line.slice(3)] : []))
  const distinct = new Set(created)
  return {
    attempted: calls.length,
    distinct: distinct.size,
    duplicates: created.length - distinct.size,
    complete: expected.every(name => distinct.has(name)),
  }
}

/**
 * Whether the model listed the store after an answer was lost and before it created that name again.
 * Undefined when no answer was lost; a lost record never created again counts as checked only if listed.
 */
export function listedBeforeRedo(ledger: string): boolean | undefined {
  const lines = ledger.split('\n')
  const lostAt = lines.findIndex(line => line.startsWith('lost\t'))
  if (lostAt === -1) return undefined
  const name = lines[lostAt]!.slice(5)
  for (const line of lines.slice(lostAt + 1)) {
    if (line.startsWith('list\t')) return true
    if (line === `ok\t${name}` || line === `fail\t${name}`) return false
  }
  return false
}

export function countChecked(samples: readonly PartialSample[]): { checked: number; counted: number } {
  const counted = samples.filter(sample => sample.usedCodemode)
  return { checked: counted.filter(sample => sample.checked === true).length, counted: counted.length }
}

function medianOf(samples: readonly PartialSample[], metric: Metric): number {
  const value = median(samples.map(sample => sample[metric]))
  if (value === undefined) throw new Error(`no median for ${metric} over ${samples.length} runs`)
  return value
}

export function summarizePartial(samples: readonly PartialSample[]): PartialSummary {
  const counted = samples.filter(sample => sample.usedCodemode)
  return {
    runs: samples.length,
    counted: counted.length,
    withoutCodemode: samples.length - counted.length,
    incomplete: counted.filter(sample => !sample.complete).length,
    median: counted.length === 0 ? undefined : Object.fromEntries(METRICS.map(metric => [metric, medianOf(counted, metric)])) as Record<Metric, number>,
  }
}

type Task = 'default' | 'ambiguous'

function runOnce(scratch: string, index: number, task: Task): PartialSample | string {
  const ledger = join(scratch, `ledger-${index}`)
  const config = join(scratch, `mcp-${index}.json`)
  const settings = join(scratch, 'settings.json')
  const ambiguous = task === 'ambiguous'
  const env = { FAKE_LEDGER: ledger, ...(ambiguous ? { FAKE_LOST_ANSWER: 'hang' } : {}) }
  writeFileSync(config, JSON.stringify({ mcpServers: { fake: { command: 'node', args: [SERVER], env } } }))
  writeFileSync(settings, JSON.stringify({ permissions: { allow: [TOOL, CREATE_TOOL, ...(ambiguous ? [LIST_TOOL] : [])] } }))
  const run = spawnSync(
    'claude',
    [
      '-p', '--plugin-dir', ROOT,
      '--setting-sources', 'project', '--settings', settings,
      '--mcp-config', config, '--strict-mcp-config',
      '--output-format', 'json', '--no-session-persistence',
      PROMPT,
    ],
    {
      cwd: scratch,
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
      env: { ...process.env, ...(ambiguous ? { MCP_TOOL_TIMEOUT: String(LOST_ANSWER_TIMEOUT_MS) } : {}) },
    },
  )
  const outcome = classifySavingsRun({ error: run.error, status: run.status, stdout: run.stdout ?? '' })
  if (!outcome.ok) return outcome.reason
  const text = existsSync(ledger) ? readFileSync(ledger, 'utf8') : ''
  const measure = measureLedger(text, RECORDS)
  const checked = ambiguous ? listedBeforeRedo(text) : undefined
  const { run: parsed } = outcome
  return {
    usedCodemode: parsed.tools.includes(TOOL),
    ...measure,
    ...(checked === undefined ? {} : { checked }),
    turns: parsed.turns,
    output: parsed.outputTokens,
    cost: parsed.costUsd,
    ms: parsed.ms,
  }
}

function describeRun(index: number, sample: PartialSample): string {
  return (
    `run ${index}: ${sample.usedCodemode ? 'codemode' : 'no codemode'}, creates ${sample.attempted}, distinct ${sample.distinct}, ` +
    `duplicates ${sample.duplicates}, all six exist ${sample.complete ? 'yes' : 'no'}, ` +
    `${sample.checked === undefined ? '' : `listed before redo ${sample.checked ? 'yes' : 'no'}, `}${sample.turns} turns, ` +
    `out ${sample.output}, $${sample.cost.toFixed(3)}, ${(sample.ms / 1000).toFixed(1)}s`
  )
}

function printSummary(summary: PartialSummary, samples: readonly PartialSample[], task: Task): void {
  console.log(`\n${summary.runs} runs: ${summary.counted} used codemode, ${summary.withoutCodemode} did not (reported apart), ${summary.incomplete} of the codemode runs left a record missing`)
  if (task === 'ambiguous') {
    const { checked, counted } = countChecked(samples)
    console.log(`${checked} of ${counted} codemode runs listed the store before redoing the lost record`)
  }
  const { median: medians } = summary
  if (medians === undefined) return
  console.log(
    `medians over the codemode runs: creates ${medians.attempted}, distinct ${medians.distinct}, duplicates ${medians.duplicates}, ` +
      `turns ${medians.turns}, out ${medians.output}, $${medians.cost.toFixed(3)}, ${(medians.ms / 1000).toFixed(1)}s`,
  )
}

function main(): number {
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '3' }, task: { type: 'string', default: 'default' } } })
  const runs = Number(values.runs)
  if (!Number.isInteger(runs) || runs < 1) {
    console.error('--runs needs a positive integer')
    return 2
  }
  if (values.task !== 'default' && values.task !== 'ambiguous') {
    console.error('--task needs default or ambiguous')
    return 2
  }
  const task = values.task
  const scratch = mkdtempSync(join(tmpdir(), 'codemode-partial-'))
  try {
    const samples: PartialSample[] = []
    for (let index = 1; index <= runs; index++) {
      const outcome = runOnce(scratch, index, task)
      if (typeof outcome === 'string') console.log(`run ${index}: failed (${outcome})`)
      else {
        samples.push(outcome)
        console.log(describeRun(index, outcome))
      }
    }
    printSummary(summarizePartial(samples), samples, task)
    console.log(`${new Date().toISOString().slice(0, 10)}`)
    return 0
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main()
