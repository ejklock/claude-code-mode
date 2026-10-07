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

/** Hides the codemode-mode MCP tools from the model outside the codemode tool; a script still calls them. */
export function registerExposure(on: On, exposure: Exposure): void {
  on('tool.describe', async (_$, e, next) => {
    const answer = await next(e)
    if (modeOf(exposure, e.tool) !== 'codemode') return answer
    return { ...answer, description: `${callNote(e.tool)}\n\n${answer.description}`, isDeferred: true as const }
  }).catch((_$, e, next) => next(e))

  on('prompt.attachment', async ($, e, next) => {
    const answer = await next(e)
    if (answer.text === null) return answer
    const names = await connected($)
    if (names === undefined) return answer
    const group = inCodemode(exposure, names)
    if (group.length === 0) return answer
    const kept = withoutTools(answer.text, group)
    if (e.type === 'mcp_instructions_delta') {
      return { ...answer, text: `${kept}\n\n${instructionsLine(group, names)}` }
    }
    return { ...answer, text: kept }
  }).catch((_$, e, next) => next(e))
}

/**
 * The turn-start check: the engine caches the two answers `registerExposure` rewrites for the session,
 * so a codemode-mode tool that connects later needs them asked again.
 */
export function exposureSync(exposure: Exposure): (session: Session) => Promise<void> {
  let seen = ''
  return async session => {
    const names = await connected(session)
    if (names === undefined) return
    const now = inCodemode(exposure, names).sort().join('\n')
    if (now === seen) return
    seen = now
    session.ui.invalidate('prompt.attachment')
    session.ui.invalidate('tool.describe')
  }
}
