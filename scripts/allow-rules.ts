/**
 * Offers the allow rules a codemode script needs and merges them into the
 * `permissions.allow` list of one Claude Code settings file. Run by the owner
 * from install.sh, never by the plugin; it changes nothing else in the file.
 *
 *   SCOPE=user ALLOW_RULES=print node scripts/allow-rules.ts
 *
 * Environment: SCOPE (user, project or local; default user) picks the settings
 * file; ALLOW_RULES is `ask` (default: show the rules and read y/N from the
 * terminal; with no terminal it behaves as `no` and says how to rerun), `yes`
 * (merge without asking), `no` (merge nothing) or `print` (list, write nothing).
 */
import {
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { ReadStream } from 'node:tty'
import { fileURLToPath } from 'node:url'

export type MergeResult = { ok: true; text: string; added: string[] } | { ok: false; reason: string }
export type WriteResult = { ok: true; added: string[]; backup: string | undefined } | { ok: false; reason: string }

type Scope = 'user' | 'project' | 'local'
type Mode = 'ask' | 'yes' | 'no' | 'print'

/** The built-in tools a script calls that only read, plus the MCP resource tools and web search. */
export const FIXED_RULES: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
  'WebSearch',
]

const MCP_PREFIX = 'mcp__'
const SEPARATOR = '__'

// Claude Code writes every other character of a server or tool name as an underscore in a rule.
const ruleName = (name: string, keep: RegExp): string => name.replace(keep, '_')

const entriesOf = (value: unknown): string[] => {
  if (typeof value === 'string') return value.split(',')
  if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) return value
  return []
}

const partsOf = (entry: string): { server: string; tool: string } => {
  const trimmed = entry.trim()
  const text = trimmed.startsWith(MCP_PREFIX) ? trimmed.slice(MCP_PREFIX.length) : trimmed
  const at = text.indexOf(SEPARATOR)
  return at < 0 ? { server: text, tool: '' } : { server: text.slice(0, at), tool: text.slice(at + SEPARATOR.length) }
}

const ruleOf = (entry: string): string | undefined => {
  const { server, tool } = partsOf(entry)
  // An allow rule's server segment must be glob-free, so a wildcard there names no rule.
  if (server === '' || server.includes('*')) return undefined
  return `${MCP_PREFIX}${ruleName(server, /[^A-Za-z0-9_-]/g)}${SEPARATOR}${tool === '' ? '*' : ruleName(tool, /[^A-Za-z0-9_*-]/g)}`
}

/**
 * The `mcpCodemode` entries whose server segment holds a glob. The runtime
 * honours them, but no allow rule can express one, so the owner adds rules for
 * the servers they match by hand.
 */
export function globbedServers(value: unknown): string[] {
  const globbed = entriesOf(value)
    .map(entry => entry.trim())
    .filter(entry => partsOf(entry).server.includes('*'))
  return [...new Set(globbed)]
}

/**
 * The allow rules for the `mcpCodemode` setting, a list or one comma-separated
 * string: `server` allows every tool of the server, `server__tool` that tool,
 * `server__prefix*` the tools with that prefix (an allow rule may glob after
 * the literal `mcp__<server>__`). Any other value gives no rule.
 */
export function serverRules(value: unknown): string[] {
  const rules = entriesOf(value).map(ruleOf).filter((rule): rule is string => rule !== undefined)
  return [...new Set(rules)]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Adds the missing rules to `permissions.allow` of the settings text; every other key is kept as parsed. */
export function mergeAllow(text: string | undefined, rules: readonly string[]): MergeResult {
  let settings: unknown = {}
  if (text !== undefined) {
    try {
      settings = JSON.parse(text)
    } catch {
      return { ok: false, reason: 'the settings file is not valid JSON' }
    }
  }
  if (!isRecord(settings)) return { ok: false, reason: 'the settings file does not hold a JSON object' }
  const permissions = settings.permissions ?? {}
  if (!isRecord(permissions)) return { ok: false, reason: 'permissions in the settings file is not an object' }
  const allow = permissions.allow ?? []
  if (!Array.isArray(allow)) return { ok: false, reason: 'permissions.allow in the settings file is not a list' }

  const added = [...new Set(rules)].filter(rule => !allow.includes(rule))
  settings.permissions = { ...permissions, allow: [...allow, ...added] }
  return { ok: true, text: `${JSON.stringify(settings, null, 2)}\n`, added }
}

const stamp = (now: Date): string => now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')

/**
 * Merges the rules into the settings file at `path`. A file that is a symlink
 * or is not valid settings JSON is refused and left alone. A change is written
 * to a temporary file and renamed over the original after the original is
 * copied to `<path>.bak-<timestamp>`; nothing is written when no rule is new.
 * The temporary file is created exclusively, so a file or symlink already at
 * its name is refused, never followed. A failed filesystem call comes back as
 * a refusal and the temporary file this call created is removed.
 */
export function writeAllow(path: string, rules: readonly string[], now: Date): WriteResult {
  const temporary = `${path}.tmp-${process.pid}`
  let created = false
  try {
    const existing = statOf(path)
    if (existing?.isSymbolicLink()) return { ok: false, reason: `${path} is a symlink; edit its target by hand` }
    const merge = mergeAllow(existing === undefined ? undefined : readFileSync(path, 'utf8'), rules)
    if (!merge.ok) return { ok: false, reason: `${path}: ${merge.reason}` }
    if (merge.added.length === 0) return { ok: true, added: [], backup: undefined }

    if (existing === undefined) mkdirSync(dirname(path), { recursive: true })
    const mode = existing === undefined ? 0o600 : existing.mode & 0o777
    const descriptor = openSync(temporary, 'wx', mode)
    created = true
    try {
      fchmodSync(descriptor, mode)
      writeFileSync(descriptor, merge.text)
    } finally {
      closeSync(descriptor)
    }
    let backup: string | undefined
    if (existing !== undefined) {
      backup = `${path}.bak-${stamp(now)}`
      copyFileSync(path, backup, constants.COPYFILE_EXCL)
    }
    renameSync(temporary, path)
    return { ok: true, added: merge.added, backup }
  } catch (error) {
    if (created) rmSync(temporary, { force: true })
    return { ok: false, reason: failureOf(error) }
  }
}

const codeOf = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : undefined)

const failureOf = (error: unknown): string => {
  if (codeOf(error) === 'EEXIST') {
    const { dest, path } = error as { dest?: unknown; path?: unknown }
    const taken = [dest, path].find((name): name is string => typeof name === 'string')
    return `${taken ?? 'a file'} already exists; remove it and rerun`
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0] ?? message
}

/** The file's own status, a symlink not followed; `undefined` when nothing is there. */
const statOf = (path: string): Stats | undefined => {
  try {
    return lstatSync(path)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined
    throw error
  }
}

/** The settings file the install scope writes; `user` honors CLAUDE_CONFIG_DIR. */
export function settingsPath(scope: Scope, env: Readonly<Record<string, string | undefined>>, cwd: string): string {
  if (scope === 'user') return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
  return join(cwd, '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json')
}

const mcpCodemodeOf = (path: string): unknown => {
  try {
    const settings: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const configs = isRecord(settings) ? settings.pluginConfigs : undefined
    const plugin = isRecord(configs) ? configs.codemode : undefined
    const options = isRecord(plugin) ? plugin.options : undefined
    return isRecord(options) ? options.mcpCodemode : undefined
  } catch {
    return undefined
  }
}

/** True for `y` or `yes`, any case; anything else, an empty answer included, is no. */
export function isYes(answer: string): boolean {
  return ['y', 'yes'].includes(answer.trim().toLowerCase())
}

/** The answer from `read`; a question aborted by Ctrl-C or Ctrl-D is an empty answer, which is no. */
export async function answerOrNo(read: () => Promise<string>): Promise<string> {
  try {
    return await read()
  } catch (error) {
    if (codeOf(error) === 'ABORT_ERR') return ''
    throw error
  }
}

// The installer may run as `curl | sh`, so the answer comes from the terminal and not from stdin.
async function askTerminal(question: string): Promise<string | undefined> {
  if (!process.stdout.isTTY) return undefined
  let fd: number
  try {
    fd = openSync('/dev/tty', 'r')
  } catch {
    return undefined
  }
  const lines = createInterface({ input: new ReadStream(fd), output: process.stdout })
  try {
    return await answerOrNo(() => lines.question(question))
  } finally {
    lines.close()
  }
}

const SCOPES: readonly Scope[] = ['user', 'project', 'local']
const MODES: readonly Mode[] = ['ask', 'yes', 'no', 'print']

async function main(): Promise<number> {
  const scope = SCOPES.find(item => item === (process.env.SCOPE || 'user'))
  const mode = MODES.find(item => item === (process.env.ALLOW_RULES || 'ask'))
  if (scope === undefined) return fail('SCOPE must be user, project or local.')
  if (mode === undefined) return fail('ALLOW_RULES must be ask, yes, no or print.')

  const path = settingsPath(scope, process.env, process.cwd())
  const mcpCodemode = mcpCodemodeOf(path)
  const rules = [...FIXED_RULES, ...serverRules(mcpCodemode)]
  say(`Allow rules for scripts that call tools through codemode, for ${path}:`)
  for (const rule of rules) say(`  ${rule}`)
  for (const entry of globbedServers(mcpCodemode)) {
    say(`No rule can cover mcpCodemode entry ${entry}: add allow rules for the servers it matches by hand.`)
  }

  if (mode === 'print') return 0
  if (mode === 'no') {
    say('No rule was added (ALLOW_RULES=no).')
    return 0
  }
  if (mode === 'ask') {
    const answer = await askTerminal(`Add these to permissions.allow in ${path}? [y/N] `)
    if (answer === undefined) {
      say(`No terminal to ask on, so no rule was added. To add them, rerun with ALLOW_RULES=yes SCOPE=${scope}.`)
      return 0
    }
    if (!isYes(answer)) {
      say('No rule was added.')
      return 0
    }
  }

  const result = writeAllow(path, rules, new Date())
  if (!result.ok) return fail(`no rule was added: ${result.reason}.`)
  say(result.added.length === 0 ? 'Every rule was already there.' : `Added ${result.added.length} rule(s) to ${path}.`)
  if (result.backup !== undefined) say(`The previous file is kept as ${result.backup}.`)
  return 0
}

function say(line: string): void {
  process.stdout.write(`${line}\n`)
}

function fail(message: string): number {
  process.stderr.write(`allow-rules: ${message}\n`)
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main()
