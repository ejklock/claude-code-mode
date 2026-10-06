/**
 * Measures whether the model picks codemode on its own: it runs a headless
 * `claude -p` task that never names the tool, N times, and counts the runs
 * that called it. It spends model tokens, so run it once per measurement.
 *
 *   node scripts/adoption.ts --runs 5
 *   node scripts/adoption.ts --runs 5 --baseline   (against HEAD's committed tree)
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

type Block = { type?: string; name?: string }
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

/** A run is valid only when claude spawned, exited 0 and the stream ended with a result event. */
export function classifyRun(run: SpawnOutcome): RunOutcome {
  if (run.error !== undefined) return { ok: false, reason: `spawn failed: ${run.error.message}` }
  if (run.status !== 0) return { ok: false, reason: `exit status ${run.status}` }
  const events = parseEvents(run.stdout)
  if (!events.some(event => event.type === 'result')) return { ok: false, reason: 'the stream has no result event' }
  const tools = toolNames(events)
  return { ok: true, tools, usedCodemode: tools.includes(TOOL) }
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

function runOnce(pluginDir: string, repo: string, settingsFile: string): RunOutcome {
  const run = spawnSync(
    'claude',
    [
      '-p',
      '--plugin-dir', pluginDir,
      '--setting-sources', 'project',
      '--settings', settingsFile,
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      PROMPT,
    ],
    { cwd: repo, encoding: 'utf8', timeout: RUN_TIMEOUT_MS },
  )
  return classifyRun({ error: run.error, status: run.status, stdout: run.stdout ?? '' })
}

function main(): number {
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '5' }, baseline: { type: 'boolean' } } })
  const runs = Number(values.runs)
  if (!Number.isInteger(runs) || runs < 1) {
    console.error('--runs needs a positive integer')
    return 2
  }
  const scratch = mkdtempSync(join(tmpdir(), 'codemode-adoption-'))
  try {
    const repo = join(scratch, 'task')
    mkdirSync(repo)
    buildTaskRepo(repo)
    const settingsFile = join(scratch, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify(RULES))
    let pluginDir = ROOT
    if (values.baseline === true) {
      pluginDir = join(scratch, 'baseline')
      mkdirSync(pluginDir)
      exportHead(pluginDir)
    }
    console.log(`plugin: ${values.baseline === true ? 'baseline (HEAD)' : 'working tree'}`)
    let used = 0
    let failed = 0
    for (let run = 1; run <= runs; run++) {
      const outcome = runOnce(pluginDir, repo, settingsFile)
      if (!outcome.ok) {
        failed++
        console.log(`run ${run}: failed (${outcome.reason})`)
        continue
      }
      if (outcome.usedCodemode) used++
      console.log(`run ${run}: ${outcome.tools.length > 0 ? outcome.tools.join(' > ') : '(no tool called)'}`)
    }
    console.log(`codemode used in ${used} of ${runs - failed} valid runs (${failed} failed)`)
    return failed === 0 ? 0 : 1
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main()
