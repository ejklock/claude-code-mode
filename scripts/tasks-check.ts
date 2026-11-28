/**
 * Tells, against the installed Claude Code, whether a session declares the MCP tasks extension and what a
 * codemode script receives from a tool that answers with a task. One headless `claude -p` session talks to
 * a stand-in server that logs every request; the log decides the verdict. It spends model tokens; run it
 * after a Claude Code upgrade.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
const PROTOCOL_KEY = 'io.modelcontextprotocol/protocolVersion'
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'

export type Verdict = {
  kind: 'declared' | 'not declared' | 'cannot tell'
  protocol?: string
  capabilities?: unknown
}

type Dict = Record<string, unknown>

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value)

const dictAt = (value: unknown, key: string): Dict | undefined => {
  const found = isDict(value) ? value[key] : undefined
  return isDict(found) ? found : undefined
}

function parseLog(log: string): Dict[] | undefined {
  const lines = log.split('\n').filter(line => line.trim() !== '')
  const requests: Dict[] = []
  for (const line of lines) {
    try {
      const request: unknown = JSON.parse(line)
      if (isDict(request)) requests.push(request)
    } catch {
      return undefined
    }
  }
  return requests
}

/** The capabilities a request states: the per-request meta entry, or an initialize request's own. */
function capabilitiesOf(request: Dict): { stated: boolean; capabilities?: unknown } {
  const params = dictAt(request, 'params')
  const meta = dictAt(params, '_meta')
  if (meta !== undefined && CAPABILITIES_KEY in meta) return { stated: true, capabilities: meta[CAPABILITIES_KEY] }
  if (request['method'] === 'initialize') {
    return params !== undefined && 'capabilities' in params ? { stated: true, capabilities: params['capabilities'] } : { stated: true }
  }
  return { stated: false }
}

function protocolOf(request: Dict): string | undefined {
  const params = dictAt(request, 'params')
  const version = params?.['protocolVersion'] ?? dictAt(params, '_meta')?.[PROTOCOL_KEY]
  return typeof version === 'string' ? version : undefined
}

const declaresTasks =(capabilities: unknown): boolean => dictAt(capabilities, 'extensions')?.[TASKS_EXTENSION] !== undefined

/** What a request log shows about the tasks extension; a log that is empty, malformed or never states capabilities tells nothing. */
export function classifyLog(log: string): Verdict {
  const requests = parseLog(log)
  if (requests === undefined) return { kind: 'cannot tell' }
  const entries = requests.map(request => ({ ...capabilitiesOf(request), protocol: protocolOf(request) }))
  const stated = entries.filter(entry => entry.stated)
  if (stated.length === 0) return { kind: 'cannot tell' }
  const declaring = stated.find(entry => declaresTasks(entry.capabilities))
  const chosen = declaring ?? stated.find(entry => 'capabilities' in entry) ?? stated[0]
  const named = chosen?.protocol ?? entries.find(entry => entry.protocol !== undefined)?.protocol
  const protocol = named === undefined ? {} : { protocol: named }
  const capabilities = chosen !== undefined && 'capabilities' in chosen ? { capabilities: chosen.capabilities } : {}
  return { kind: declaring === undefined ? 'not declared' : 'declared', ...protocol, ...capabilities }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = 'mcp__codemode__codemode'
const SERVER = 'tasks'
const MCP_TOOL = `mcp__${SERVER}__long_job`
const RUN_TIMEOUT_MS = 300_000

const SCRIPT = `try { text('RECEIVED: ' + await tools.${MCP_TOOL}({})) } catch (e) { text('ERROR: ' + e.message) }`

const PROMPT = [
  `Call the ${TOOL} tool exactly once, with this value for its \`code\` argument and no changes:`,
  '',
  SCRIPT,
  '',
  'Then reply with the tool result verbatim.',
].join('\n')

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string; content?: unknown }

function blocksOf(stdout: string): Block[] {
  return stdout.split('\n').flatMap(line => {
    try {
      const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content
      return Array.isArray(content) ? (content as Block[]) : []
    } catch {
      return []
    }
  })
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  return content.map(part => (part as { text?: string }).text ?? '').join('\n')
}

/** What the script received: the text of the codemode call's result, when the session made the call. */
function receivedText(stdout: string): string | undefined {
  const blocks = blocksOf(stdout)
  const call = blocks.find(block => block.type === 'tool_use' && block.name === TOOL)
  if (call === undefined) return undefined
  const result = blocks.find(block => block.type === 'tool_result' && block.tool_use_id === call.id)
  return result === undefined ? undefined : resultText(result.content)
}

export type RunOutcome = {
  error?: NodeJS.ErrnoException
  status: number | null
  stdout?: string | null
  stderr?: string | null
}

type Report = { out: string; err: string; code: number }

/** What to print and the exit code: a known verdict is always printed; a failed run says why on its own line. */
export function report(verdict: Verdict, run: RunOutcome): Report {
  const stdout = run.stdout ?? ''
  const known = verdict.kind !== 'cannot tell'
  const lines = known
    ? [
        `tasks extension: ${verdict.kind}`,
        `protocol: ${verdict.protocol ?? 'not named'}`,
        `capabilities sent: ${JSON.stringify(verdict.capabilities) ?? 'none'}`,
      ]
    : []
  const joined = (): string => (lines.length === 0 ? '' : `${lines.join('\n')}\n`)
  if (run.error !== undefined) {
    return { out: joined(), err: `claude did not complete: ${run.error.code ?? 'unknown error'}: ${run.error.message}\n`, code: 1 }
  }
  const received = receivedText(stdout)
  const tail = `claude exit status ${run.status}\nstderr:\n${run.stderr ?? ''}\nstdout tail:\n${stdout.slice(-3000)}\n`
  if (!known) return { out: '', err: `cannot tell: the fixture logged no usable request\n${tail}`, code: 1 }
  if (received === undefined) {
    return { out: joined(), err: `script result missing: the session never returned the codemode call result\n${tail}`, code: 1 }
  }
  lines.push(`script received: ${JSON.stringify(received)}`)
  return { out: joined(), err: '', code: 0 }
}

function main(): number {
  const scratch = mkdtempSync(join(tmpdir(), 'codemode-tasks-check-'))
  try {
    const requestLog = join(scratch, 'requests.log')
    const settings = join(scratch, 'settings.json')
    const mcpConfig = join(scratch, 'mcp.json')
    writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: 'default', allow: [TOOL, MCP_TOOL] } }))
    const server = { command: 'node', args: [join(ROOT, 'test/fixtures/tasks-mcp-server.ts')], env: { TASKS_REQUEST_LOG: requestLog } }
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [SERVER]: server } }))
    const run = spawnSync(
      'claude',
      [
        '-p',
        '--plugin-dir', ROOT,
        '--setting-sources', 'project',
        '--settings', settings,
        '--mcp-config', mcpConfig,
        '--strict-mcp-config',
        '--output-format', 'stream-json',
        '--verbose',
        '--no-session-persistence',
        PROMPT,
      ],
      { cwd: scratch, encoding: 'utf8', timeout: RUN_TIMEOUT_MS },
    )
    const log = existsSync(requestLog) ? readFileSync(requestLog, 'utf8') : ''
    const outcome = report(classifyLog(log), run)
    process.stdout.write(outcome.out)
    process.stderr.write(outcome.err)
    return outcome.code
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
