/**
 * Measures whether the model picks codemode on its own: it runs a headless
 * `claude -p` task that never names the tool, N times, and counts the runs
 * that called it. It spends model tokens, so run it once per measurement.
 *
 *   node scripts/adoption.ts --runs 5
 *   node scripts/adoption.ts --runs 5 --baseline   (against HEAD's committed tree)
 *   node scripts/adoption.ts --runs 5 --mcp-mode codemode|none   (an MCP task on the stand-in server)
 *   node scripts/adoption.ts --runs 5 --mcp-mode none --echoes 1   (the MCP task asks for one echo, not three; default 3)
 *   node scripts/adoption.ts --runs 5 --task data   (a data task: codemode versus an inline script in Bash)
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { inlineScriptKind } from './inline-script.ts'
import type { InlineKind } from './inline-script.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = 'mcp__codemode__codemode'
const RUN_TIMEOUT_MS = 300_000
const PROMPT = 'List the TypeScript files tracked by git, read them all, and report each file\'s TODOs.'

const ECHO_TOOL = 'mcp__fake__echo'
const ECHO_ANSWER = 'fake-echo:'
const MCP_SERVER = join(ROOT, 'test/fixtures/fake-mcp-server.mjs')
const MCP_PROMPT = 'Get the fake server\'s echo of each of these three texts: "alpha", "beta", "gamma". Then report the three answers.'
const MCP_PROMPT_ONE = 'Get the fake server\'s echo of the text "alpha". Then report the answer.'
const MCP_ECHOES = ['1', '3']
const MCP_MODES = ['codemode', 'none']

const DATA_PROMPT =
  'The orders folder holds one JSON file per order, each with a customer and a total. Report the total per customer and the three customers with the highest totals.'
const DATA_TASKS = ['data']
const DATA_RULES = { permissions: { allow: ['Read', 'Glob', 'Bash', TOOL] } }
/** Totals: Carla 350, Bruno 275.5, Alice 200, Diego 150, Elena 40, Frida 10. */
const DATA_ORDERS: Array<[string, number]> = [
  ['Alice', 120], ['Bruno', 45.5], ['Carla', 300], ['Alice', 80], ['Diego', 60], ['Bruno', 200],
  ['Elena', 15], ['Carla', 50], ['Diego', 90], ['Elena', 25], ['Frida', 10], ['Bruno', 30],
]
const DATA_TOP_THREE = ['Carla', 'Bruno', 'Alice']

const RULES = {
  permissions: { allow: ['Read', 'Bash(git ls-files:*)', 'Bash(cat:*)', TOOL] },
}

const SOURCES: Record<string, string> = {
  'src/config.ts': 'export const PORT = 8080\n// TODO: read the port from the environment\n',
  'src/greet.ts': 'export const greet = (name: string): string => `hello ${name}`\n',
  'src/math.ts': 'export const add = (a: number, b: number): number => a + b\n// TODO: handle overflow\n// TODO: add subtract\n',
  'src/logger.ts': 'export const log = (line: string): void => console.log(line)\n',
  'src/index.ts': 'import { greet } from \'./greet.ts\'\n// TODO: wire the logger\nconsole.log(greet(\'world\'))\n',
}

type Block = {
  type?: string
  name?: string
  id?: string
  tool_use_id?: string
  content?: unknown
  input?: { command?: unknown }
}
type Event = { type?: string; result?: unknown; message?: { content?: unknown } }

function parseEvents(stdout: string): Event[] {
  return stdout.split('\n').flatMap(line => {
    try {
      return [JSON.parse(line) as Event]
    } catch {
      return []
    }
  })
}

function toolNames(events: Event[]): string[] {
  return events.flatMap(event => {
    const content = event.type === 'assistant' ? event.message?.content : undefined
    const blocks = Array.isArray(content) ? (content as Block[]) : []
    return blocks.flatMap(block => (block.type === 'tool_use' && block.name !== undefined ? [block.name] : []))
  })
}

/** What `spawnSync` gave back for one run, as far as the classifier reads it. */
export type SpawnOutcome = {
  error?: Error
  status: number | null
  stdout: string
}

export type RunOutcome =
  | { ok: true; tools: string[]; usedCodemode: boolean }
  | { ok: false; reason: string }

type Inspected = { outcome: RunOutcome; events: Event[] }

function inspectRun(run: SpawnOutcome): Inspected {
  if (run.error !== undefined) return { outcome: { ok: false, reason: `spawn failed: ${run.error.message}` }, events: [] }
  if (run.status !== 0) return { outcome: { ok: false, reason: `exit status ${run.status}` }, events: [] }
  const events = parseEvents(run.stdout)
  if (!events.some(event => event.type === 'result')) {
    return { outcome: { ok: false, reason: 'the stream has no result event' }, events }
  }
  const tools = toolNames(events)
  return { outcome: { ok: true, tools, usedCodemode: tools.includes(TOOL) }, events }
}

export type DataOutcome =
  | {
      ok: true
      tools: string[]
      usedCodemode: boolean
      inlineKinds: InlineKind[]
      bashCalls: number
      namesTopThree: boolean
    }
  | { ok: false; reason: string }

function bashCommands(events: Event[]): string[] {
  return events
    .flatMap(contentBlocks)
    .flatMap(block => (block.type === 'tool_use' && block.name === 'Bash' ? [block.input?.command] : []))
    .map(command => (typeof command === 'string' ? command : ''))
}

function finalAnswer(events: Event[]): string {
  const answer = events.find(event => event.type === 'result')?.result
  return typeof answer === 'string' ? answer : ''
}

/** Whether the model processed the order files with codemode, with an inline script in Bash, or neither, and whether it answered right. */
export function classifyDataRun(run: SpawnOutcome): DataOutcome {
  const { outcome: base, events } = inspectRun(run)
  if (!base.ok) return base
  const commands = bashCommands(events)
  const answer = finalAnswer(events).toLowerCase()
  return {
    ok: true,
    tools: base.tools,
    usedCodemode: base.usedCodemode,
    inlineKinds: commands.flatMap(command => inlineScriptKind(command) ?? []),
    bashCalls: commands.length,
    namesTopThree: DATA_TOP_THREE.every(customer => answer.includes(customer.toLowerCase())),
  }
}

/** A run is valid only when claude spawned, exited 0 and the stream ended with a result event. */
export function classifyRun(run: SpawnOutcome): RunOutcome {
  return inspectRun(run).outcome
}

export type McpKind = 'script' | 'direct' | 'neither'

export type McpOutcome =
  | { ok: true; tools: string[]; kind: McpKind }
  | { ok: false; reason: string }

function contentBlocks(event: Event): Block[] {
  const content = event.message?.content
  return Array.isArray(content) ? (content as Block[]) : []
}

function resultText(content: unknown): string {
  return typeof content === 'string' ? content : (JSON.stringify(content) ?? '')
}

function codemodeAnswered(events: Event[]): boolean {
  const blocks = events.flatMap(contentBlocks)
  const ids = new Set(blocks.flatMap(block => (block.type === 'tool_use' && block.name === TOOL && block.id ? [block.id] : [])))
  return blocks.some(
    block =>
      block.type === 'tool_result' &&
      block.tool_use_id !== undefined &&
      ids.has(block.tool_use_id) &&
      resultText(block.content).includes(ECHO_ANSWER),
  )
}

/** Whether the model reached the echo tool from a codemode script, by a direct call, or not at all. */
export function classifyMcpRun(run: SpawnOutcome): McpOutcome {
  const { outcome: base, events } = inspectRun(run)
  if (!base.ok) return base
  if (base.tools.includes(ECHO_TOOL)) return { ok: true, tools: base.tools, kind: 'direct' }
  const script = base.usedCodemode && codemodeAnswered(events)
  return { ok: true, tools: base.tools, kind: script ? 'script' : 'neither' }
}

function buildTaskRepo(directory: string, files: Record<string, string>): void {
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), source)
  }
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=adoption', '-c', 'user.email=adoption@example.invalid', ...args], {
      cwd: directory,
      stdio: 'ignore',
    })
  }
  git('init', '--quiet')
  git('add', '.')
  git('commit', '--quiet', '-m', 'fixture')
}

function exportHead(directory: string): void {
  const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  execFileSync('tar', ['-x', '-C', directory], { input: archive })
  symlinkSync(join(ROOT, 'node_modules'), join(directory, 'node_modules'))
}

/** What one measurement runs: the prompt, the extra claude flags, and the settings file's content. */
type Task = { prompt: string; flags: string[]; settings: object }

function runOnce(pluginDir: string, repo: string, settingsFile: string, task: Task): SpawnOutcome {
  const run = spawnSync(
    'claude',
    [
      '-p',
      '--plugin-dir', pluginDir,
      '--setting-sources', 'project',
      '--settings', settingsFile,
      ...task.flags,
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      task.prompt,
    ],
    { cwd: repo, encoding: 'utf8', timeout: RUN_TIMEOUT_MS },
  )
  return { error: run.error, status: run.status, stdout: run.stdout ?? '' }
}

function mcpTask(mode: string, scratch: string, echoes: string): Task {
  const mcpConfig = join(scratch, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fake: { command: 'node', args: [MCP_SERVER] } } }))
  const permissions = { allow: [TOOL, ECHO_TOOL] }
  const pluginConfigs = mode === 'codemode' ? { pluginConfigs: { codemode: { options: { mcpCodemode: 'fake' } } } } : {}
  return {
    prompt: echoes === '1' ? MCP_PROMPT_ONE : MCP_PROMPT,
    flags: ['--mcp-config', mcpConfig, '--strict-mcp-config'],
    settings: { permissions, ...pluginConfigs },
  }
}

function tsTask(repo: string): Task {
  buildTaskRepo(repo, SOURCES)
  return { prompt: PROMPT, flags: [], settings: RULES }
}

function dataTask(repo: string): Task {
  const files = Object.fromEntries(
    DATA_ORDERS.map(([customer, total], index) => [`orders/order-${index + 1}.json`, JSON.stringify({ customer, total })]),
  )
  buildTaskRepo(repo, files)
  return { prompt: DATA_PROMPT, flags: [], settings: DATA_RULES }
}

/** Prints one data run's line and returns whether it counted: a codemode use. */
function reportData(run: number, outcome: DataOutcome): boolean {
  if (!outcome.ok) {
    console.log(`run ${run}: failed (${outcome.reason})`)
    return false
  }
  const inline = outcome.inlineKinds.length > 0 ? outcome.inlineKinds.join(',') : 'none'
  const answer = outcome.namesTopThree ? 'top three named' : 'top three missing'
  console.log(`run ${run}: codemode ${outcome.usedCodemode}, inline ${inline}, bash calls ${outcome.bashCalls}, ${answer}`)
  return outcome.usedCodemode
}

function measureData(runs: number, once: () => DataOutcome): number {
  let codemode = 0
  let inline = 0
  let failed = 0
  for (let run = 1; run <= runs; run++) {
    const outcome = once()
    if (!outcome.ok) failed++
    else if (outcome.inlineKinds.length > 0) inline++
    if (reportData(run, outcome)) codemode++
  }
  console.log(`codemode ${codemode}, inline script in Bash ${inline} of ${runs - failed} valid runs (${failed} failed)`)
  return failed
}

/** Prints one run's line and returns whether it counted: a codemode use, or a script for an mcp task. */
function report(run: number, outcome: RunOutcome | McpOutcome): boolean {
  if (!outcome.ok) {
    console.log(`run ${run}: failed (${outcome.reason})`)
    return false
  }
  const sequence = outcome.tools.length > 0 ? outcome.tools.join(' > ') : '(no tool called)'
  const kind = 'kind' in outcome ? `${outcome.kind}: ` : ''
  console.log(`run ${run}: ${kind}${sequence}`)
  return 'kind' in outcome ? outcome.kind === 'script' : outcome.usedCodemode
}

function measure(runs: number, once: () => RunOutcome | McpOutcome, mcp: boolean): number {
  const counts: Record<McpKind, number> = { script: 0, direct: 0, neither: 0 }
  let used = 0
  let failed = 0
  for (let run = 1; run <= runs; run++) {
    const outcome = once()
    if (!outcome.ok) failed++
    else if ('kind' in outcome) counts[outcome.kind]++
    if (report(run, outcome)) used++
  }
  if (mcp) {
    console.log(`script ${counts.script}, direct ${counts.direct}, neither ${counts.neither} of ${runs - failed} valid runs (${failed} failed)`)
  } else {
    console.log(`codemode used in ${used} of ${runs - failed} valid runs (${failed} failed)`)
  }
  return failed
}

/** The message for a bad flag combination, or undefined when the flags are usable. */
export function flagError(runs: number, mode: string | undefined, echoes: string | undefined, task?: string): string | undefined {
  if (!Number.isInteger(runs) || runs < 1) return '--runs needs a positive integer'
  if (task !== undefined && !DATA_TASKS.includes(task)) return `--task needs one of: ${DATA_TASKS.join(', ')}`
  if (task !== undefined && mode !== undefined) return '--task and --mcp-mode exclude each other'
  if (mode !== undefined && !MCP_MODES.includes(mode)) return `--mcp-mode needs one of: ${MCP_MODES.join(', ')}`
  if (echoes !== undefined && mode === undefined) return '--echoes only applies with --mcp-mode'
  if (echoes !== undefined && !MCP_ECHOES.includes(echoes)) return `--echoes needs one of: ${MCP_ECHOES.join(', ')}`
  return undefined
}

function main(): number {
  const { values } = parseArgs({
    options: {
      runs: { type: 'string', default: '5' },
      baseline: { type: 'boolean' },
      'mcp-mode': { type: 'string' },
      echoes: { type: 'string' },
      task: { type: 'string' },
    },
  })
  const runs = Number(values.runs)
  const mode = values['mcp-mode']
  const error = flagError(runs, mode, values.echoes, values.task)
  if (error !== undefined) {
    console.error(error)
    return 2
  }
  const scratch = mkdtempSync(join(tmpdir(), 'codemode-adoption-'))
  try {
    const repo = join(scratch, 'task')
    mkdirSync(repo)
    let task: Task
    if (mode !== undefined) task = mcpTask(mode, scratch, values.echoes ?? '3')
    else if (values.task === 'data') task = dataTask(repo)
    else task = tsTask(repo)
    const settingsFile = join(scratch, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify(task.settings))
    let pluginDir = ROOT
    if (values.baseline === true) {
      pluginDir = join(scratch, 'baseline')
      mkdirSync(pluginDir)
      exportHead(pluginDir)
    }
    console.log(`plugin: ${values.baseline === true ? 'baseline (HEAD)' : 'working tree'}`)
    if (values.task === 'data') {
      return measureData(runs, () => classifyDataRun(runOnce(pluginDir, repo, settingsFile, task))) === 0 ? 0 : 1
    }
    const classify = mode === undefined ? classifyRun : classifyMcpRun
    const failed = measure(runs, () => classify(runOnce(pluginDir, repo, settingsFile, task)), mode !== undefined)
    return failed === 0 ? 0 : 1
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main()
