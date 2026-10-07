import type { InvalidatableEventName, On, ToolInfo } from 'claude-code'

import { modeOf } from './exposure.ts'
import type { Exposure } from './exposure.ts'

const MCP_PREFIX = 'mcp__'
/** The part of the hook context this file reads. */
type Session = {
  readonly tool: { readonly list: () => Promise<ToolInfo[]> }
  readonly ui: { readonly invalidate: (event: InvalidatableEventName) => void }
}

const FUNCTION_OPEN = '<function>'

const serverOf = (tool: string): string => {
  const rest = tool.slice(MCP_PREFIX.length)
  return rest.slice(0, Math.max(rest.indexOf('__'), 0))
}

const callNote = (tool: string): string =>
  `Call this tool inside the codemode tool as \`tools.${tool}(args)\`.`

/** The tool a `<function>` block line declares, when the line is one and its JSON parses. */
function declaredTool(line: string): string | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith(FUNCTION_OPEN)) return undefined
  const body = trimmed.slice(FUNCTION_OPEN.length).replace(/<\/function>$/, '')
  try {
    const parsed: unknown = JSON.parse(body)
    const name = (parsed as { name?: unknown } | null)?.name
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}

/** The text without the deferred-list lines and the `<function>` lines of the hidden tools; the rest is byte-identical. */
function withoutTools(text: string, hidden: readonly string[]): string {
  if (!hidden.some(name => text.includes(name))) return text
  const gone = new Set(hidden)
  return text
    .split('\n')
    .filter(line => !gone.has(line.trim()) && !gone.has(declaredTool(line) ?? ''))
    .join('\n')
}

/** One line naming the tools, a server whose every listed tool is in the group by its wildcard. */
function instructionsLine(group: readonly string[], connected: readonly string[]): string {
  const names: string[] = []
  const servers = new Set(group.map(serverOf))
  for (const server of servers) {
    const inGroup = group.filter(tool => serverOf(tool) === server)
    const listed = connected.filter(tool => serverOf(tool) === server)
    if (inGroup.length === listed.length) names.push(`${MCP_PREFIX}${server}__*`)
    else names.push(...inGroup)
  }
  return (
    `The tools ${names.join(', ')} run inside the codemode tool as \`tools.<name>(args)\`; ` +
    `where a server's instructions above name one of its tools, call it from a codemode script.`
  )
}

const connected = async ($: Session): Promise<string[] | undefined> => {
  try {
    const tools = await $.tool.list()
    return tools.filter(tool => tool.mcp).map(tool => tool.name)
  } catch {
    return undefined
  }
}

const inCodemode = (exposure: Exposure, names: readonly string[]): string[] =>
  names.filter(name => modeOf(exposure, name) === 'codemode')

type Describe = { readonly description: string; readonly isDeferred?: boolean }

/** The describe answer a tool's mode asks for; a mode the plugin does not set keeps the engine's answer. */
function describeAnswer<A extends Describe>(exposure: Exposure, tool: string, answer: A): A {
  const mode = modeOf(exposure, tool)
  if (mode === 'deferred' || mode === 'hidden') return { ...answer, isDeferred: true }
  if (mode === 'direct') return { ...answer, isDeferred: false }
  if (mode !== 'codemode') return answer
  return { ...answer, description: `${callNote(tool)}\n\n${answer.description}`, isDeferred: true }
}

const inHidden = (exposure: Exposure, names: readonly string[]): string[] =>
  names.filter(name => modeOf(exposure, name) === 'hidden')

/** The tools with the hidden ones left out; what the codemode description and the scripts may see. */
export function withoutHidden<T extends { readonly name: string }>(exposure: Exposure, tools: readonly T[]): T[] {
  return tools.filter(tool => modeOf(exposure, tool.name) !== 'hidden')
}

/**
 * The attachment text without the codemode-mode and hidden tools; the instructions line
 * is added on an instructions delta and names the codemode-mode tools only.
 */
function attachmentText(
  text: string,
  type: string,
  groups: { readonly codemode: readonly string[]; readonly hidden: readonly string[] },
  names: readonly string[],
): string {
  const kept = withoutTools(text, [...groups.codemode, ...groups.hidden])
  if (type !== 'mcp_instructions_delta' || groups.codemode.length === 0) return kept
  return `${kept}\n\n${instructionsLine(groups.codemode, names)}`
}

const hiddenReason = (tool: string): string =>
  `${tool} is hidden by the codemode plugin's settings (mcpHidden); no call to it runs.`

/** The refusal when the check itself failed: every tool is denied, and only a hidden one is told why. */
const failedCheckVerdict = (exposure: Exposure, tool: string) => ({
  decision: 'deny' as const,
  reason:
    modeOf(exposure, tool) === 'hidden'
      ? hiddenReason(tool)
      : `The codemode plugin's permission check failed, so the call to ${tool} is refused.`,
})

/** Hides the codemode-mode MCP tools from the model outside the codemode tool, and refuses the hidden ones everywhere. */
export function registerExposure(on: On, exposure: Exposure): void {
  on('tool.describe', async (_$, e, next) => describeAnswer(exposure, e.tool, await next(e))).catch((_$, e, next) =>
    next(e),
  )

  on('tool.check', (_$, e, next) =>
    modeOf(exposure, e.tool) === 'hidden' ? { decision: 'deny' as const, reason: hiddenReason(e.tool) } : next(e),
  ).catch((_$, e) => failedCheckVerdict(exposure, e.tool))

  on('prompt.attachment', async ($, e, next) => {
    const answer = await next(e)
    if (answer.text === null) return answer
    const names = await connected($)
    if (names === undefined) return answer
    const groups = { codemode: inCodemode(exposure, names), hidden: inHidden(exposure, names) }
    if (groups.codemode.length + groups.hidden.length === 0) return answer
    return { ...answer, text: attachmentText(answer.text, e.type, groups, names) }
  }).catch((_$, e, next) => next(e))
}

/** One string for the two sets; a blank line separates them, which no tool name holds. */
const groupsKey = (codemode: readonly string[], hidden: readonly string[]): string =>
  `${[...codemode].sort().join('\n')}\n\n${[...hidden].sort().join('\n')}`

/**
 * The turn-start check: the engine caches the two answers `registerExposure` rewrites for the session,
 * so a codemode-mode tool that connects later needs them asked again.
 */
export function exposureSync(exposure: Exposure): (session: Session) => Promise<void> {
  let seen = groupsKey([], [])
  return async session => {
    const names = await connected(session)
    if (names === undefined) return
    const now = groupsKey(inCodemode(exposure, names), inHidden(exposure, names))
    if (now === seen) return
    seen = now
    session.ui.invalidate('prompt.attachment')
    session.ui.invalidate('tool.describe')
  }
}
