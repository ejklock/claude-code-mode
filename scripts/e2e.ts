/**
 * Runs the whole path headless: a real `claude -p` session loads this plugin,
 * the model calls the codemode tool, and the script's nested calls meet real
 * permission rules. It spends model tokens; run it once per change to prove.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const PROMPT = [
  `Call the ${TOOL} tool exactly once, with this value for its \`code\` argument and no changes:`,
  '',
  SCRIPT,
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

function blocks(event: Event): Block[] {
  const content = event.message?.content
  return Array.isArray(content) ? (content as Block[]) : []
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  return content.map(part => (part as { text?: string }).text ?? '').join('\n')
}

function runClaude(settingsFile: string): { events: Event[]; stdout: string; stderr: string; status: number | null } {
  const run = spawnSync(
    'claude',
    [
      '-p',
      '--plugin-dir', ROOT,
      '--setting-sources', 'project',
      '--settings', settingsFile,
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      PROMPT,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: RUN_TIMEOUT_MS },
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

function main(): number {
  const scratch = mkdtempSync(join(tmpdir(), 'codemode-e2e-'))
  try {
    const settingsFile = join(scratch, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify(RULES))
    const { events, stdout, stderr, status } = runClaude(settingsFile)

    const all = events.flatMap(blocks)
    const use = all.find(block => block.type === 'tool_use' && block.name === TOOL)
    const result = all.find(block => block.type === 'tool_result' && block.tool_use_id === use?.id)
    const text = result === undefined ? '' : resultText(result.content)

    const checks: [string, boolean][] = [
      ['the codemode tool was called', use !== undefined],
      ['the tool result holds the fixture content', text.includes(FIXTURE_CONTENT)],
      ['the tool result holds codemode-ok', text.includes('codemode-ok')],
      ['the script caught the denial', text.includes('DENIAL:') && !text.includes('NOT-DENIED')],
    ]
    for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
    console.log(`tool result:\n${text}`)
    if (checks.every(([, ok]) => ok)) return 0
    console.log(`claude exit status: ${status}\nstderr:\n${stderr}\nstdout:\n${stdout.slice(-6000)}`)
    return 1
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

process.exitCode = main()
