/**
 * Measures whether the model picks codemode on its own: it runs a headless
 * `claude -p` task that never names the tool, N times, and counts the runs
 * that called it. It spends model tokens, so run it once per measurement.
 *
 *   node scripts/adoption.ts --runs 5
 *   node scripts/adoption.ts --runs 5 --baseline   (against HEAD's committed tree)
 *   node scripts/adoption.ts --runs 5 --mcp-mode codemode|none   (an MCP task on the stand-in server)
 *   node scripts/adoption.ts --runs 5 --mcp-mode none --echoes 1   (the MCP task asks for one echo, not three; default 3)
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

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

type Block = { type?: string; name?: string; id?: string; tool_use_id?: string; content?: unknown }
type Event = { type?: string; message?: { content?: unknown } }

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

function buildTaskRepo(directory: string): void {
  for (const [path, source] of Object.entries(SOURCES)) {
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
  buildTaskRepo(repo)
  return { prompt: PROMPT, flags: [], settings: RULES }
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
export function flagError(runs: number, mode: string | undefined, echoes: string | undefined): string | undefined {
  if (!Number.isInteger(runs) || runs < 1) return '--runs needs a positive integer'
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
    },
  })
  const runs = Number(values.runs)
  const mode = values['mcp-mode']
  const error = flagError(runs, mode, values.echoes)
  if (error !== undefined) {
    console.error(error)
    return 2
  }
  const scratch = mkdtempSync(join(tmpdir(), 'codemode-adoption-'))
  try {
    const repo = join(scratch, 'task')
    mkdirSync(repo)
    const task = mode === undefined ? tsTask(repo) : mcpTask(mode, scratch, values.echoes ?? '3')
    const settingsFile = join(scratch, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify(task.settings))
    let pluginDir = ROOT
    if (values.baseline === true) {
      pluginDir = join(scratch, 'baseline')
      mkdirSync(pluginDir)
      exportHead(pluginDir)
    }
    console.log(`plugin: ${values.baseline === true ? 'baseline (HEAD)' : 'working tree'}`)
    const classify = mode === undefined ? classifyRun : classifyMcpRun
    const failed = measure(runs, () => classify(runOnce(pluginDir, repo, settingsFile, task)), mode !== undefined)
    return failed === 0 ? 0 : 1
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main()
