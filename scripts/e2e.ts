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

type Block = { type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }
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

type RunOptions = {
  settingsFile: string
  prompt: string
  cwd: string
  mode?: string
  mcpConfig?: string
  env?: Record<string, string>
}

function runClaude({ settingsFile, prompt, cwd, mode, mcpConfig, env }: RunOptions): Run {
  const run = spawnSync(
    'claude',
    [
      '-p',
      '--plugin-dir', ROOT,
      '--setting-sources', 'project',
      '--settings', settingsFile,
      ...(mode === undefined ? [] : ['--permission-mode', mode]),
      ...(mcpConfig === undefined ? [] : ['--mcp-config', mcpConfig, '--strict-mcp-config']),
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      prompt,
    ],
    { cwd, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, env: { ...process.env, ...env } },
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
function codemodeResult(events: Event[]): { called: boolean; text: string; code: string } {
  const all = events.flatMap(blocks)
  const use = all.find(block => block.type === 'tool_use' && block.name === TOOL)
  const result = all.find(block => block.type === 'tool_result' && block.tool_use_id === use?.id)
  const code = (use?.input as { code?: unknown } | undefined)?.code
  return {
    called: use !== undefined,
    text: result === undefined ? '' : resultText(result.content),
    code: typeof code === 'string' ? code : '',
  }
}

type Scenario = {
  name: string
  rules: { permissions: { allow: string[]; deny?: string[] } }
  mode?: string
  /** `fake` connects the stand-in MCP server; `none` runs strict with no server at all. */
  mcp?: 'fake' | 'none'
  /** Environment variables for this run only. */
  env?: Record<string, string>
  /** The script, given the throwaway file it may touch. */
  script: (file: string) => string
  /** The file's content before the run; absent means no file. */
  seed?: string
  /** A request in words, in place of the prompt that hands the model the script. */
  ask?: string
  checks: (text: string, file: string, code: string) => Check[]
}

const read = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

const WRITE_SCRIPT = (file: string): string =>
  [
    `const f = ${JSON.stringify(file)}`,
    `try { text(await tools.Write({ file_path: f, content: 'written-by-script' })); text('WRITE-OK') } catch (e) { text('DENIAL: ' + e.message) }`,
  ].join('\n')

const MCP_TOOL = 'mcp__fake__echo'
const MCP_SERVER = join(ROOT, 'test/fixtures/fake-mcp-server.mjs')

const MCP_CONFIGS = {
  fake: { mcpServers: { fake: { command: 'node', args: [MCP_SERVER] } } },
  none: { mcpServers: {} },
}

const LISTS_MCP_TOOL = `text('LISTED: ' + ALL_TOOLS.some(tool => tool.name === '${MCP_TOOL}'))`

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
  {
    name: 'mcp allowed',
    rules: { permissions: { allow: [TOOL, MCP_TOOL] } },
    mcp: 'fake',
    script: () =>
      [LISTS_MCP_TOOL, `text('ECHO: ' + await tools.${MCP_TOOL}({ text: 'e2e-ping-31' }))`].join('\n'),
    checks: text => [
      ['mcp allowed: ALL_TOOLS lists the MCP tool', text.includes('LISTED: true')],
      ['mcp allowed: the result holds the server answer', text.includes('ECHO: fake-echo: e2e-ping-31')],
    ],
  },
  {
    name: 'mcp denied',
    rules: { permissions: { allow: [TOOL], deny: [MCP_TOOL] } },
    mcp: 'fake',
    script: () =>
      [
        LISTS_MCP_TOOL,
        `try { text('NOT-DENIED: ' + await tools.${MCP_TOOL}({ text: 'e2e-ping-31' })) } catch (e) { text('DENIAL: ' + e.message) }`,
      ].join('\n'),
    checks: text => [
      ['mcp denied: a deny rule hides the tool, so ALL_TOOLS does not list it', text.includes('LISTED: false')],
      ['mcp denied: the call failed inside the script and the server never answered', text.includes('DENIAL:') && !text.includes('NOT-DENIED') && !text.includes('fake-echo:')],
    ],
  },
  {
    name: 'mcp deferred',
    rules: { permissions: { allow: [TOOL, MCP_TOOL] } },
    mcp: 'fake',
    env: { ENABLE_TOOL_SEARCH: 'true' },
    script: () =>
      [LISTS_MCP_TOOL, `text('ECHO: ' + await tools.${MCP_TOOL}({ text: 'e2e-ping-31' }))`].join('\n'),
    checks: text => [
      ['mcp deferred: ALL_TOOLS lists the tool with tool search forced on', text.includes('LISTED: true')],
      ['mcp deferred: the result holds the server answer', text.includes('ECHO: fake-echo: e2e-ping-31')],
    ],
  },
  {
    name: 'mcp not allowed',
    rules: { permissions: { allow: [TOOL] } },
    mcp: 'fake',
    script: () =>
      [
        LISTS_MCP_TOOL,
        `try { text('NOT-DENIED: ' + await tools.${MCP_TOOL}({ text: 'e2e-ping-31' })) } catch (e) { text('DENIAL: ' + e.message) }`,
      ].join('\n'),
    checks: text => [
      ['mcp not allowed: ALL_TOOLS lists the tool', text.includes('LISTED: true')],
      ['mcp not allowed: the permission check refused the call', text.includes('DENIAL:') && !text.includes('NOT-DENIED') && !text.includes('does not exist')],
    ],
  },
  {
    name: 'mcp from the schema',
    rules: { permissions: { allow: [TOOL, MCP_TOOL] } },
    mcp: 'fake',
    ask: [
      `Use the ${TOOL} tool, once, to call the connected echo tool from a script with the text e2e-ping-31.`,
      'You are not given the echo tool\'s name: read it where the codemode tool describes its nested tools.',
      'Then reply with the echo tool\'s answer verbatim.',
    ].join('\n'),
    script: () => '',
    checks: (text, _file, code) => [
      ['mcp from the schema: the script named the MCP tool', code.includes(MCP_TOOL)],
      ['mcp from the schema: the result holds the server answer', text.includes('fake-echo: e2e-ping-31')],
    ],
  },
  {
    name: 'mcp absent',
    rules: { permissions: { allow: [TOOL, MCP_TOOL] } },
    mcp: 'none',
    script: () =>
      [
        LISTS_MCP_TOOL,
        `try { text('NOT-ABSENT: ' + await tools.${MCP_TOOL}({ text: 'e2e-ping-31' })) } catch (e) { text('ABSENT: ' + e.message) }`,
      ].join('\n'),
    checks: text => [
      ['mcp absent: ALL_TOOLS does not list the tool', text.includes('LISTED: false')],
      ['mcp absent: the call failed in the script', text.includes('ABSENT:') && !text.includes('NOT-ABSENT')],
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
  const mcpConfig = scenario.mcp === undefined ? undefined : join(folder, 'mcp.json')
  if (mcpConfig !== undefined && scenario.mcp !== undefined) writeFileSync(mcpConfig, JSON.stringify(MCP_CONFIGS[scenario.mcp]))
  const run = runClaude({ settingsFile, prompt: scenario.ask ?? promptFor(scenario.script(file)), cwd: folder, mode: scenario.mode, mcpConfig, env: scenario.env })
  const { called, text, code } = codemodeResult(run.events)
  const checks: Check[] = [[`${scenario.name}: the codemode tool was called`, called], ...scenario.checks(text, file, code)]
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
