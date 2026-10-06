/**
 * Runs the whole path headless: a real `claude -p` session loads this plugin,
 * the model calls the codemode tool, and the script's nested calls meet real
 * permission rules and modes. It spends model tokens; run it once per change to prove.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = 'mcp__codemode__codemode'
const FIXTURE = join(ROOT, 'test/fixtures/sample.txt')
const FIXTURE_CONTENT = 'sample-fixture-content-7f3a'
const RUN_TIMEOUT_MS = 300_000

const SCRIPT = [
  `text(await tools.Read({ file_path: ${JSON.stringify(FIXTURE)} }))`,
  `text(await tools.Bash({ command: 'echo codemode-ok' }))`,
  `try { await tools.Bash({ command: 'echo denied' }); text('NOT-DENIED') } catch (e) { text('DENIAL: ' + e.message) }`,
].join('\n')

const promptFor = (script: string): string =>
  [
    `Call the ${TOOL} tool exactly once, with this value for its \`code\` argument and no changes:`,
    '',
    script,
    '',
    'Then reply with the tool result verbatim.',
  ].join('\n')

const RULES = {
  permissions: {
    allow: ['Read', 'Bash(echo:*)', TOOL],
    deny: ['Bash(echo denied:*)'],
  },
}

type Block = { type: string; id?: string; name?: string; tool_use_id?: string; content?: unknown }
type Event = { type?: string; message?: { content?: unknown } }
type Run = { events: Event[]; stdout: string; stderr: string; status: number | null }
type Check = [name: string, ok: boolean]

function blocks(event: Event): Block[] {
  const content = event.message?.content
  return Array.isArray(content) ? (content as Block[]) : []
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  return content.map(part => (part as { text?: string }).text ?? '').join('\n')
}

type RunOptions = { settingsFile: string; prompt: string; cwd: string; mode?: string }

function runClaude({ settingsFile, prompt, cwd, mode }: RunOptions): Run {
  const run = spawnSync(
    'claude',
    [
      '-p',
      '--plugin-dir', ROOT,
      '--setting-sources', 'project',
      '--settings', settingsFile,
      ...(mode === undefined ? [] : ['--permission-mode', mode]),
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      prompt,
    ],
    { cwd, encoding: 'utf8', timeout: RUN_TIMEOUT_MS },
  )
  const events = run.stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      try {
        return [JSON.parse(line) as Event]
      } catch {
        return []
      }
    })
  return { events, stdout: run.stdout, stderr: run.stderr, status: run.status }
}

/** What the model's one codemode call returned, or `undefined` when it never called it. */
function codemodeResult(events: Event[]): { called: boolean; text: string } {
  const all = events.flatMap(blocks)
  const use = all.find(block => block.type === 'tool_use' && block.name === TOOL)
  const result = all.find(block => block.type === 'tool_result' && block.tool_use_id === use?.id)
  return { called: use !== undefined, text: result === undefined ? '' : resultText(result.content) }
}

type Scenario = {
  name: string
  rules: { permissions: { allow: string[]; deny?: string[] } }
  mode?: string
  /** The script, given the throwaway file it may touch. */
  script: (file: string) => string
  /** The file's content before the run; absent means no file. */
  seed?: string
  checks: (text: string, file: string) => Check[]
}

const read = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

const WRITE_SCRIPT = (file: string): string =>
  [
    `const f = ${JSON.stringify(file)}`,
    `try { text(await tools.Write({ file_path: f, content: 'written-by-script' })); text('WRITE-OK') } catch (e) { text('DENIAL: ' + e.message) }`,
  ].join('\n')

const SCENARIOS: Scenario[] = [
  {
    name: 'rules allow',
    rules: { permissions: { allow: ['Read', 'Write', 'Edit', TOOL] } },
    script: file =>
      [
        `const f = ${JSON.stringify(file)}`,
        `await tools.Write({ file_path: f, content: 'alpha-original' })`,
        `text('FIRST: ' + await tools.Read({ file_path: f }))`,
        `await tools.Edit({ file_path: f, old_string: 'alpha-original', new_string: 'beta-edited' })`,
        `text('SECOND: ' + await tools.Read({ file_path: f }))`,
      ].join('\n'),
    checks: (text, file) => [
      ['rules allow: the script read its own write', text.includes('FIRST:') && text.includes('alpha-original')],
      ['rules allow: the script read the edited text back', text.includes('SECOND:') && text.includes('beta-edited')],
      ['rules allow: the file on disk holds the edited text', read(file)?.includes('beta-edited') === true],
    ],
  },
  {
    name: 'deny rule',
    rules: { permissions: { allow: ['Read', 'Write', TOOL], deny: ['Edit(*)'] } },
    seed: FIXTURE_CONTENT,
    script: file =>
      [
        `const f = ${JSON.stringify(file)}`,
        `text('BEFORE: ' + await tools.Read({ file_path: f }))`,
        `try { await tools.Edit({ file_path: f, old_string: ${JSON.stringify(FIXTURE_CONTENT)}, new_string: 'changed' }); text('NOT-DENIED') } catch (e) { text('DENIAL: ' + e.message) }`,
      ].join('\n'),
    checks: (text, file) => [
      ['deny rule: the script caught the Edit denial', text.includes('DENIAL:') && !text.includes('NOT-DENIED')],
      ['deny rule: the file on disk is unchanged', read(file) === FIXTURE_CONTENT],
    ],
  },
  {
    name: 'acceptEdits',
    rules: { permissions: { allow: ['Read', TOOL] } },
    mode: 'acceptEdits',
    script: WRITE_SCRIPT,
    checks: (text, file) => [
      ['acceptEdits: the script Write succeeded with no allow rule', text.includes('WRITE-OK') && !text.includes('DENIAL:')],
      ['acceptEdits: the file on disk holds the written text', read(file) === 'written-by-script'],
    ],
  },
  {
    name: 'no mode',
    rules: { permissions: { allow: ['Read', TOOL] } },
    script: WRITE_SCRIPT,
    checks: (text, file) => [
      ['no mode: the script Write was denied', text.includes('DENIAL:') && !text.includes('WRITE-OK')],
      ['no mode: nothing was written', read(file) === undefined],
    ],
  },
]

type Outcome = { name: string; checks: Check[]; run: Run; text: string }

function runScenario(scenario: Scenario, scratch: string, index: number): Outcome {
  const folder = mkdtempSync(join(scratch, `scenario-${index}-`))
  const file = join(folder, 'target.txt')
  if (scenario.seed !== undefined) writeFileSync(file, scenario.seed)
  const settingsFile = join(folder, 'settings.json')
  // The session's ambient default mode may allow writes, so each scenario names the stock one.
  writeFileSync(settingsFile, JSON.stringify({ permissions: { defaultMode: 'default', ...scenario.rules.permissions } }))
  const run = runClaude({ settingsFile, prompt: promptFor(scenario.script(file)), cwd: folder, mode: scenario.mode })
  const { called, text } = codemodeResult(run.events)
  const checks: Check[] = [[`${scenario.name}: the codemode tool was called`, called], ...scenario.checks(text, file)]
  return { name: scenario.name, checks, run, text }
}

function runBaseline(scratch: string): Outcome {
  const settingsFile = join(scratch, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify(RULES))
  const run = runClaude({ settingsFile, prompt: promptFor(SCRIPT), cwd: ROOT })
  const { called, text } = codemodeResult(run.events)
  const checks: Check[] = [
    ['the codemode tool was called', called],
    ['the tool result holds the fixture content', text.includes(FIXTURE_CONTENT)],
    ['the tool result holds codemode-ok', text.includes('codemode-ok')],
    ['the script caught the denial', text.includes('DENIAL:') && !text.includes('NOT-DENIED')],
  ]
  return { name: 'baseline', checks, run, text }
}

const hasFailed = (outcome: Outcome): boolean => outcome.checks.some(([, ok]) => !ok)

function describeFailure({ name, run }: Outcome): string {
  return `${name}: claude exit status ${run.status}\nstderr:\n${run.stderr}\nstdout:\n${run.stdout.slice(-6000)}`
}

function main(): number {
  const scratch = mkdtempSync(join(tmpdir(), 'codemode-e2e-'))
  try {
    const outcomes = [runBaseline(scratch), ...SCENARIOS.map((scenario, index) => runScenario(scenario, scratch, index))]
    for (const outcome of outcomes) console.log(`${outcome.name} result:\n${outcome.text}`)
    for (const [name, ok] of outcomes.flatMap(outcome => outcome.checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
    const failed = outcomes.filter(hasFailed)
    if (failed.length === 0) return 0
    console.log(failed.map(describeFailure).join('\n\n'))
    return 1
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

process.exitCode = main()
