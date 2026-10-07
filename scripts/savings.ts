/**
 * Measures what the same task costs with and without the plugin: the same
 * prompt, permission rules and fixture repository on both sides, run headless
 * through `claude -p --output-format stream-json`, reporting input, output and
 * cache tokens, the characters of tool output that reached the model (ctxOut),
 * turns, cost, wall time and whether the final answer is correct. A
 * wrong or missing answer is reported apart, never averaged in.
 *
 *   node scripts/savings.ts --runs 5
 *   node scripts/savings.ts --runs 5 --task todos
 *   node scripts/savings.ts --runs 3 --task write-three --trace
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import { codeDescription, describeCodemode } from '../hooks/describe.ts'
import { median } from './overhead.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = 'mcp__codemode__codemode'
const RUN_TIMEOUT_MS = 300_000
/** The tool schema's own size, stated in the report: the with side pays it on every turn. */
const CHARS_PER_TOKEN = 4

const SIDES = ['with', 'without'] as const

export type Side = (typeof SIDES)[number]

export type SavingsMetrics = {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  turns: number
  cost: number
  ms: number
  ctxOut?: number
}

export type SavingsSample = { task: string; side: Side; correct: boolean; usedCodemode: boolean } & SavingsMetrics

export type SavingsRow = {
  task: string
  side: Side
  runs: number
  correct: number
  wrong: number
  usedCodemode: number
  median: SavingsMetrics | undefined
  inputRange: [number, number] | undefined
  turnsRange: [number, number] | undefined
  ctxOutRange?: [number, number]
}

export type ParsedResult = {
  isError: boolean
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  turns: number
  costUsd: number
  ms: number
  resultText: string
  tools: string[]
  model: string | undefined
  claudeVersion: string | undefined
}

export type SpawnOutcome = { error?: Error; status: number | null; stdout: string }

export type RunOutcome = { ok: false; reason: string } | { ok: true; run: ParsedResult }

type Json = Record<string, unknown>

function asJson(value: unknown): Json | undefined {
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value)
  return isObject ? (value as Json) : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The `result` record at the stream's end, as far as the parser reads it. */
function resultRecord(events: readonly unknown[]): Json | undefined {
  return events.map(asJson).find(record => record?.type === 'result')
}

function toolNames(events: readonly unknown[]): string[] {
  return events
    .map(asJson)
    .filter(record => record?.type === 'assistant')
    .flatMap(record => {
      const content = asJson(record?.message)?.content
      return Array.isArray(content) ? content : []
    })
    .map(asJson)
    .flatMap(block => (block?.type === 'tool_use' ? asString(block?.name) ?? [] : []))
}

function tryParse(text: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return undefined
  }
}

/** The events of a run: a whole JSON document, or one event per line with any malformed line skipped. */
function parseEvents(stdout: string): unknown[] {
  return tryParse(stdout) ?? stdout.split('\n').flatMap(line => tryParse(line) ?? [])
}

export function parseRunResult(stdout: string): ParsedResult | undefined {
  const events = parseEvents(stdout)
  const result = resultRecord(events)
  if (result === undefined) return undefined
  const usage = asJson(result.usage)
  const input = asNumber(usage?.input_tokens)
  const output = asNumber(usage?.output_tokens)
  const cacheWrite = asNumber(usage?.cache_creation_input_tokens)
  const cacheRead = asNumber(usage?.cache_read_input_tokens)
  const turns = asNumber(result.num_turns)
  const cost = asNumber(result.total_cost_usd)
  const ms = asNumber(result.duration_ms)
  const resultText = asString(result.result)
  if (
    input === undefined || output === undefined || cacheWrite === undefined || cacheRead === undefined ||
    turns === undefined || cost === undefined || ms === undefined || resultText === undefined
  ) return undefined
  const init = events.map(asJson).find(record => record?.type === 'system' && record.subtype === 'init')
  return {
    isError: result.is_error === true,
    inputTokens: input,
    outputTokens: output,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    turns,
    costUsd: cost,
    ms,
    resultText,
    tools: toolNames(events),
    model: asString(asJson(init)?.model),
    claudeVersion: asString(asJson(init)?.claude_code_version),
  }
}

export type StreamMeasure = { ctxOut: number; trace: string[] }

type Turn = { id: string | undefined; tools: string[]; toolIds: string[] }

function contentBlocks(record: Json | undefined): Json[] {
  const content = asJson(record?.message)?.content
  if (!Array.isArray(content)) return []
  return content.map(asJson).filter((block): block is Json => block !== undefined)
}

/** The characters of text a tool result put in front of the model; other block kinds count nothing. */
function resultChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return content.map(asJson).reduce((sum, block) => sum + (block?.type === 'text' ? asString(block.text)?.length ?? 0 : 0), 0)
}

/** One turn per model message: the stream splits a message into an event per content block, all sharing its id. */
function turnsOf(events: readonly unknown[]): Turn[] {
  const turns: Turn[] = []
  for (const record of events.map(asJson).filter(event => event?.type === 'assistant')) {
    const id = asString(asJson(record?.message)?.id)
    const last = turns.at(-1)
    const turn = last !== undefined && id !== undefined && last.id === id ? last : { id, tools: [], toolIds: [] }
    if (turn !== last) turns.push(turn)
    for (const block of contentBlocks(record).filter(item => item.type === 'tool_use')) {
      turn.tools.push(asString(block.name) ?? '?')
      turn.toolIds.push(asString(block.id) ?? '')
    }
  }
  return turns
}

export function measureStream(stdout: string): StreamMeasure {
  const events = parseEvents(stdout)
  const charsById = new Map<string, number>()
  let ctxOut = 0
  for (const record of events.map(asJson).filter(event => event?.type === 'user')) {
    for (const block of contentBlocks(record).filter(item => item.type === 'tool_result')) {
      const chars = resultChars(block.content)
      ctxOut += chars
      const id = asString(block.tool_use_id)
      if (id !== undefined) charsById.set(id, (charsById.get(id) ?? 0) + chars)
    }
  }
  const trace = turnsOf(events).map((turn, index) => {
    if (turn.tools.length === 0) return `turn ${index + 1}: (answer)`
    const chars = turn.toolIds.reduce((sum, id) => sum + (charsById.get(id) ?? 0), 0)
    return `turn ${index + 1}: ${turn.tools.join(', ')} -> ${chars} chars`
  })
  return { ctxOut, trace }
}

export function classifySavingsRun(spawn: SpawnOutcome): RunOutcome {
  if (spawn.error !== undefined) return { ok: false, reason: `spawn failed: ${spawn.error.message}` }
  if (spawn.status !== 0) return { ok: false, reason: `exit status ${spawn.status}` }
  const run = parseRunResult(spawn.stdout)
  if (run === undefined) return { ok: false, reason: 'the output holds no result record' }
  if (run.isError) return { ok: false, reason: 'claude ended the run with an error' }
  return { ok: true, run }
}

function mediansOf(runs: readonly SavingsSample[]): SavingsMetrics | undefined {
  if (runs.length === 0) return undefined
  const pick = (metric: Exclude<keyof SavingsMetrics, 'ctxOut'>): number => {
    const value = median(runs.map(run => run[metric]))
    if (value === undefined) throw new Error(`no median for ${metric} over ${runs.length} runs`)
    return value
  }
  const ctxOuts = runs.flatMap(run => run.ctxOut ?? [])
  const ctxOut = ctxOuts.length === runs.length ? median(ctxOuts) : undefined
  return {
    ...(ctxOut === undefined ? {} : { ctxOut }),
    input: pick('input'),
    output: pick('output'),
    cacheWrite: pick('cacheWrite'),
    cacheRead: pick('cacheRead'),
    turns: pick('turns'),
    cost: pick('cost'),
    ms: pick('ms'),
  }
}

export function summarizeSavings(samples: readonly SavingsSample[]): SavingsRow[] {
  const tasks = [...new Set(samples.map(sample => sample.task))]
  return tasks.flatMap(task =>
    SIDES.flatMap(side => {
      const ofSide = samples.filter(sample => sample.task === task && sample.side === side)
      if (ofSide.length === 0) return []
      const correct = ofSide.filter(sample => sample.correct)
      const inputs = correct.map(sample => sample.input)
      const turns = correct.map(sample => sample.turns)
      const ctxOuts = correct.flatMap(sample => sample.ctxOut ?? [])
      const measured = ctxOuts.length > 0 && ctxOuts.length === correct.length
      return [{
        task,
        side,
        runs: ofSide.length,
        correct: correct.length,
        wrong: ofSide.length - correct.length,
        usedCodemode: correct.filter(sample => sample.usedCodemode).length,
        median: mediansOf(correct),
        inputRange: inputs.length === 0 ? undefined : [Math.min(...inputs), Math.max(...inputs)] as [number, number],
        turnsRange: turns.length === 0 ? undefined : [Math.min(...turns), Math.max(...turns)] as [number, number],
        ...(measured ? { ctxOutRange: [Math.min(...ctxOuts), Math.max(...ctxOuts)] as [number, number] } : {}),
      }]
    }),
  )
}

type Task = {
  name: string
  prompt: string
  commits: Record<string, string>[]
  /** What the answer must hold, or why it does not; `undefined` means correct. */
  correct: (text: string, repo: string) => string | undefined
}

const TODO_LINES = ['read the port from the environment', 'handle overflow', 'add subtract', 'wire the logger']

const SOURCES: Record<string, string> = {
  'src/config.ts': 'export const PORT = 8080\n// TODO: read the port from the environment\n',
  'src/greet.ts': 'export const greet = (name: string): string => `hello ${name}`\n',
  'src/math.ts': 'export const add = (a: number, b: number): number => a + b\n// TODO: handle overflow\n// TODO: add subtract\n',
  'src/logger.ts': 'export const log = (line: string): void => console.log(line)\n',
  'src/index.ts': "import { greet } from './greet.ts'\n// TODO: wire the logger\nconsole.log(greet('world'))\n",
}

const missingWords = (text: string, words: readonly string[]): string | undefined => {
  const lower = text.toLowerCase()
  const missing = words.filter(word => !lower.includes(word))
  return missing.length === 0 ? undefined : `the answer leaves out: ${missing.join('; ')}`
}

const FAILING_TESTS = ['rounds invoice totals to cents', 'rejects an expired coupon']

/** A `node --test` suite of 160 passing tests that each print a few lines, plus two that fail with distinct messages. */
export function failingSuite(): Record<string, string> {
  const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'suite', type: 'module', scripts: { test: 'node --test' } }) + '\n' }
  for (let file = 1; file <= 16; file++) {
    const cases = Array.from({ length: 10 }, (_, index) => {
      const name = `module ${file} case ${index + 1} holds`
      return `  it('${name}', () => {\n    console.log('checking ${name}: input ${file * 100 + index}, expecting ${file + index}')\n    console.log('step 2 of ${name}: validated fixture ${file}-${index}')\n    assert.equal(${file} + ${index}, ${file + index})\n  })`
    })
    files[`tests/module-${file}.test.js`] = `import assert from 'node:assert/strict'\nimport { describe, it } from 'node:test'\n\ndescribe('module ${file}', () => {\n${cases.join('\n')}\n})\n`
  }
  files['tests/billing.test.js'] =
    "import assert from 'node:assert/strict'\nimport { describe, it } from 'node:test'\n\n" +
    "describe('billing', () => {\n" +
    "  it('rounds invoice totals to cents', () => {\n    const cents = Math.trunc(1000.9)\n    assert.equal(cents, 1001, 'invoice total 10.009 was cut to 1000 cents instead of 1001')\n  })\n" +
    "  it('rejects an expired coupon', () => {\n    const accepted = ['spring-promo', 'lapsed-promo'].includes('lapsed-promo')\n    assert.equal(accepted, false, 'coupon lapsed-promo was accepted after its end date')\n  })\n" +
    '})\n'
  return files
}

const LOG_ERRORS: readonly { message: string; count: number }[] = [
  { message: 'database connection refused', count: 5 },
  { message: 'payment gateway timeout', count: 12 },
  { message: 'disk quota exceeded', count: 1 },
]

/** A 3,200 line log of info lines with the three errors spread through it at fixed positions. */
function errorLog(): Record<string, string> {
  const total = 3200
  const errorAt = new Map<number, string>()
  let slot = 0
  for (const { message, count } of LOG_ERRORS) {
    for (let index = 0; index < count; index++) errorAt.set(97 + slot++ * 151, message)
  }
  const rows = Array.from({ length: total }, (_, line) => {
    const second = String(line % 60).padStart(2, '0')
    const minute = String(Math.floor(line / 60) % 60).padStart(2, '0')
    const hour = String(Math.floor(line / 3600) % 24).padStart(2, '0')
    const stamp = `2026-03-01T${hour}:${minute}:${second}Z`
    const id = ((line * 2654435761) >>> 0).toString(16).padStart(8, '0')
    const error = errorAt.get(line)
    return error === undefined ? `${stamp} INFO request served id=${id} status=200` : `${stamp} ERROR ${error} id=${id}`
  })
  return { 'logs/app.log': `${rows.join('\n')}\n` }
}

const TASKS: Task[] = [
  {
    name: 'todos',
    prompt: "List the TypeScript files tracked by git, read them all, and report each file's TODOs.",
    commits: [SOURCES],
    correct: text => missingWords(text, TODO_LINES),
  },
  {
    name: 'last-commit',
    prompt: 'Show which files the most recent commit changed, read each changed file, and give one line per file saying what the file does.',
    commits: [
      {
        'README.md': '# config service\nA small service that reads its configuration and reports it.\n',
        'src/config.ts': 'export const PORT = 8080\n',
      },
      {
        'src/report.ts': "export const report = (): string => 'daily report'\n",
        'src/legacy.ts': 'export const legacy = (): number => 1\n',
      },
    ],
    correct: text => missingWords(text, ['report.ts', 'legacy.ts']),
  },
  {
    name: 'write-three',
    prompt: 'Create three files in this folder: notes.md with one sentence on what this project is, team.md with one sentence on who it is for, and usage.md with one sentence on how to run it.',
    commits: [{ 'README.md': '# scratch project\nA fixture repository for measuring.\n' }],
    correct: (text, repo) => {
      void text
      const problems = ['notes.md', 'team.md', 'usage.md'].flatMap(name => {
        const file = join(repo, name)
        if (!existsSync(file)) return [`${name} is missing`]
        return readFileSync(file, 'utf8').trim().length < 20 ? [`${name} is too short`] : []
      })
      return problems.length === 0 ? undefined : problems.join('; ')
    },
  },
  {
    name: 'grep-port',
    prompt: 'Using git grep, find where the TCP port is configured and report the exact line.',
    commits: [{ 'src/config.ts': 'export const PORT = 8080\n' }],
    correct: text => (text.includes('8080') ? undefined : 'the answer does not name the port'),
  },
  {
    name: 'test-failures',
    prompt: 'Run the test suite of this project and tell me which tests fail and why.',
    commits: [failingSuite()],
    correct: text => missingWords(text, FAILING_TESTS),
  },
  {
    name: 'log-errors',
    prompt: 'List the distinct errors in logs/app.log and how many times each occurs.',
    commits: [errorLog()],
    correct: text => {
      const rows = text.toLowerCase().split('\n')
      const missing = LOG_ERRORS.filter(({ message, count }) =>
        !rows.some(row => row.includes(message) && new RegExp(`(^|\\D)${count}(\\D|$)`).test(row.replace(message, ''))),
      )
      return missing.length === 0 ? undefined : `the answer leaves out: ${missing.map(({ message, count }) => `${message} x${count}`).join('; ')}`
    },
  },
]

const RULES = {
  permissions: {
    allow: [
      'Read', 'Write', 'Edit',
      'Bash(git ls-files:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git grep:*)', 'Bash(git status:*)',
      'Bash(cat:*)',
      'Bash(node --test:*)', 'Bash(npm test:*)', 'Bash(grep:*)', 'Bash(wc:*)', 'Bash(sort:*)', 'Bash(uniq:*)',
      TOOL,
    ],
  },
}

function buildTaskRepo(directory: string, commits: Record<string, string>[]): void {
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=savings', '-c', 'user.email=savings@example.invalid', ...args], {
      cwd: directory,
      stdio: 'ignore',
    })
  }
  git('init', '--quiet')
  for (const files of commits) {
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true })
      writeFileSync(join(directory, path), source)
    }
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture')
  }
}

type MeasuredRun = { outcome: RunOutcome } & StreamMeasure

function runOnce(side: Side, task: Task, repo: string, settingsFile: string): MeasuredRun {
  const run = spawnSync(
    'claude',
    [
      '-p',
      ...(side === 'with' ? ['--plugin-dir', ROOT] : []),
      '--setting-sources', 'project',
      '--settings', settingsFile,
      '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence',
      task.prompt,
    ],
    { cwd: repo, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 },
  )
  const stdout = run.stdout ?? ''
  return { outcome: classifySavingsRun({ error: run.error, status: run.status, stdout }), ...measureStream(stdout) }
}

const COLUMN_WIDTHS = [10, 7, 8, 7, 9, 18, 7, 7, 7, 18, 11, 7, 7] as const

function printLine(cells: readonly string[]): void {
  console.log(cells.map((cell, index) => cell[index === 0 ? 'padEnd' : 'padStart'](COLUMN_WIDTHS[index] ?? 0)).join(''))
}

function printTaskTable(task: string, rows: readonly SavingsRow[]): void {
  console.log(`\ntask ${task}`)
  printLine(['side', 'runs', 'correct', 'wrong', 'codemode', 'input', 'output', 'cacheW', 'cacheR', 'ctxOut', 'turns', 'cost$', 'time'])
  for (const row of rows) {
    const range = (value: number | undefined, bounds: [number, number] | undefined): string =>
      value === undefined || bounds === undefined ? '-' : `${value} (${bounds[0]}-${bounds[1]})`
    printLine([
      row.side,
      String(row.runs),
      String(row.correct),
      String(row.wrong),
      row.side === 'with' ? String(row.usedCodemode) : '-',
      range(row.median?.input, row.inputRange),
      String(row.median?.output ?? '-'),
      String(row.median?.cacheWrite ?? '-'),
      String(row.median?.cacheRead ?? '-'),
      range(row.median?.ctxOut, row.ctxOutRange),
      range(row.median?.turns, row.turnsRange),
      row.median === undefined ? '-' : row.median.cost.toFixed(3),
      row.median === undefined ? '-' : `${(row.median.ms / 1000).toFixed(1)}s`,
    ])
  }
}

function printFixedCost(): void {
  const description = describeCodemode().length
  const codeParameter = codeDescription().length
  const tokens = Math.ceil((description + codeParameter) / CHARS_PER_TOKEN)
  console.log(
    `\nthe codemode tool's declaration adds ~${tokens} tokens (description ${description} chars + code parameter ${codeParameter} chars, at ${CHARS_PER_TOKEN} chars a token) to every turn on the with side; those tokens are inside the with side's totals above`,
  )
}

/** Prints one run's line, and its trace when asked; a failed run prints why and yields nothing. */
function recordRun(
  task: Task,
  side: Side,
  run: number,
  measured: MeasuredRun,
  repo: string,
  showTrace: boolean,
): { sample: SavingsSample; parsed: ParsedResult } | undefined {
  const { outcome, ctxOut, trace } = measured
  if (!outcome.ok) {
    console.log(`${task.name} ${side} run ${run}: failed (${outcome.reason})`)
    return undefined
  }
  const { run: parsed } = outcome
  const problem = task.correct(parsed.resultText, repo)
  const used = parsed.tools.includes(TOOL)
  const sample: SavingsSample = {
    task: task.name,
    side,
    correct: problem === undefined,
    usedCodemode: used,
    input: parsed.inputTokens,
    output: parsed.outputTokens,
    cacheWrite: parsed.cacheWriteTokens,
    cacheRead: parsed.cacheReadTokens,
    turns: parsed.turns,
    cost: parsed.costUsd,
    ms: parsed.ms,
    ctxOut,
  }
  console.log(
    `${task.name} ${side} run ${run}: ${sample.correct ? 'correct' : `wrong (${problem})`}${used ? ' [codemode]' : ''}, ` +
      `in ${parsed.inputTokens} out ${parsed.outputTokens} cacheW ${parsed.cacheWriteTokens} cacheR ${parsed.cacheReadTokens} ctxOut ${ctxOut}, ` +
      `${parsed.turns} turns, $${parsed.costUsd.toFixed(3)}, ${(parsed.ms / 1000).toFixed(1)}s`,
  )
  if (showTrace) trace.forEach(line => console.log(`  ${line}`))
  return { sample, parsed }
}

type Options = { runs: number; tasks: Task[]; trace: boolean }

type Recorded = { sample: SavingsSample; parsed: ParsedResult }

/** The options, or the message that says why they are wrong. */
function readOptions(): Options | string {
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '5' }, task: { type: 'string' }, trace: { type: 'boolean', default: false } } })
  const runs = Number(values.runs)
  if (!Number.isInteger(runs) || runs < 1) return '--runs needs a positive integer'
  const tasks = values.task === undefined ? TASKS : TASKS.filter(task => task.name === values.task)
  if (tasks.length === 0) return `no task named ${values.task}`
  return { runs, tasks, trace: values.trace === true }
}

function measureTask(task: Task, options: Options, scratch: string, settingsFile: string): Recorded[] {
  const repo = join(scratch, `${task.name}-repo`)
  mkdirSync(repo)
  buildTaskRepo(repo, task.commits)
  for (const side of SIDES) {
    const { outcome: warmUp } = runOnce(side, task, repo, settingsFile)
    if (!warmUp.ok) console.log(`${task.name} ${side} warm-up failed: ${warmUp.reason}`)
  }
  const recorded: Recorded[] = []
  for (let run = 1; run <= options.runs; run++) {
    for (const side of SIDES) {
      const one = recordRun(task, side, run, runOnce(side, task, repo, settingsFile), repo, options.trace)
      if (one !== undefined) recorded.push(one)
    }
  }
  return recorded
}

function main(): number {
  const options = readOptions()
  if (typeof options === 'string') {
    console.error(options)
    return 2
  }
  const scratch = mkdtempSync(join(tmpdir(), 'codemode-savings-'))
  try {
    const settingsFile = join(scratch, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify(RULES))
    const all: Recorded[] = []
    for (const task of options.tasks) {
      const recorded = measureTask(task, options, scratch, settingsFile)
      all.push(...recorded)
      printTaskTable(task.name, summarizeSavings(recorded.map(one => one.sample)))
    }
    const model = all.find(one => one.parsed.model !== undefined)?.parsed.model
    const claudeVersion = all.find(one => one.parsed.claudeVersion !== undefined)?.parsed.claudeVersion
    console.log(`\nclaude ${claudeVersion ?? '?'}, model ${model ?? '?'}, ${new Date().toISOString().slice(0, 10)}, ${options.runs} runs per side after one discarded warm-up per side`)
    printFixedCost()
    return 0
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main()
