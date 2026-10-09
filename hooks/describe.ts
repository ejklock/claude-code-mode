import { EXPOSED_TOOLS, TOOL_SPECS } from '../shared/protocol.ts'
import type { McpTool, ToolArg, ToolSpec } from '../shared/protocol.ts'

/** The line the system prompt carries so the model reaches for codemode unprompted. */
export const GUIDELINE =
  'Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.'

/** The note Bash's description ends with, so data-processing scripts go to codemode instead of inline python or node. */
export const BASH_NOTE =
  'To process data, batch tool calls or filter large output with a script, use the codemode tool (JavaScript calling `tools.<name>(args)`) instead of inline python or node in Bash. Keep Bash for running commands.'

/** How a script calls one tool, and what the call resolves to. */
export type ToolDoc = {
  name: string
  summary: string
  args: string
  resolves: string
}

function describeArg([name, arg]: [string, ToolArg]): string {
  return arg.note === undefined ? `\`${name}\`` : `\`${name}\` (${arg.note})`
}

function describeArgs(args: Record<string, ToolArg>): string {
  const entries = Object.entries(args)
  const required = entries.filter(([, arg]) => arg.isRequired).map(describeArg)
  const optional = entries.filter(([, arg]) => !arg.isRequired).map(describeArg)
  const optionalText = optional.length === 0 ? [] : [`optional ${optional.join(' and ')}`]
  return [...required, ...optionalText].join(', ')
}

/** One doc per tool in `names`, read from `specs`, the source the child declares its tools from. */
export function toolDocs(
  specs: Record<string, ToolSpec> = TOOL_SPECS,
  names: readonly string[] = EXPOSED_TOOLS,
): ToolDoc[] {
  return names.flatMap(name => {
    const spec = specs[name]
    return spec === undefined ? [] : [{ name, summary: spec.summary, args: describeArgs(spec.args), resolves: spec.resolves }]
  })
}

export const EXPOSED_DOCS: readonly ToolDoc[] = toolDocs()

const INTRO = [
  'Runs JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a sandbox: top-level `await` works. No Node, file system, network, or timers.',
  '- `await tools.<name>({ ...args })` resolves to the tool\'s text and rejects with an Error when the call fails or a permission rule refuses it; catch it to continue.',
  '- Only what the script prints comes back, so filter and combine results in the script.',
  '- A failed run lists the nested calls that already ran, so a retry redoes only what did not.',
  '- A call marked unknown may have taken effect: read the current state before redoing it.',
  '- A call marked read-only is safe to redo.',
  "- A script with writes prints each step as it completes, catches each item's failure apart, and passes an idempotency key when a tool takes one, derived from the data, never at random.",
  '- Prefer writes that are safe to repeat: overwrite, `mkdir -p`, upsert, check then act.',
  '- To search, run `rg` or `git grep` through Bash, print only the matches, then read only the files that matter.',
  '- Keep a handle a tool returns in a variable and pass it to the next call; never print it.',
].join('\n')

const GLOBALS = [
  'Globals:',
  '- `text(value)` and `console.log(...)` add output; non-strings are JSON-stringified. A top-level `return` ends the script, and its value is not sent back.',
  '- `exit()` ends the script successfully, keeping its output.',
  '- `ALL_TOOLS` lists `{ name, description }` for each tool a script can call.',
  '- Connected MCP tools are callable too, as `tools.<name>(args)` by their full `mcp__server__tool` name, and listed in `ALL_TOOLS`.',
  '- Each nested tool has a section in the description of the `code` parameter; one with no section there is still callable, and `ALL_TOOLS` is how to find it.',
].join('\n')

/** The first line of the `code` property's description. */
const CODE_LEAD = 'The script to run.'

function toolSection(doc: ToolDoc): string {
  return [
    `### \`${doc.name}\``,
    `${doc.summary} \`tools.${doc.name}(args)\` takes ${doc.args}, and resolves to ${doc.resolves}.`,
  ].join('\n')
}

/** The most characters of a tool's description the build sends to the model. */
export const DESCRIPTION_CAP = 2048

/** What the sections may cost together, in estimated tokens (characters divided by four). */
export const SECTIONS_BUDGET = 3000
const CHARS_PER_TOKEN = 4

/** One nested tool's section; `server` is absent for the built-ins. */
export type Section = {
  name: string
  server: string | undefined
  text: string
}

/** A group's sections as the budget left them: `shown` in the group's order, out of `total`. */
export type Group = {
  server: string | undefined
  shown: Section[]
  total: number
}

const costOf = (section: Section): number => Math.ceil(section.text.length / CHARS_PER_TOKEN)

/** The identifier a script uses for a tool: a character invalid in an identifier becomes `_`. */
export function toIdentifier(name: string): string {
  let identifier = ''
  for (const char of name) {
    const isValid = identifier === '' ? /^[A-Za-z_$]$/.test(char) : /^[A-Za-z0-9_$]$/.test(char)
    identifier += isValid ? char : '_'
  }
  return identifier === '' ? '_' : identifier
}

/** The server of `mcp__server__tool`: the part between the first two `__`. */
function serverOf(name: string): string {
  return name.split('__')[1] ?? ''
}

export function builtinSection(doc: ToolDoc): Section {
  return { name: doc.name, server: undefined, text: toolSection(doc) }
}

// A description is data, not markup: one line with no fence and no leading `#`
// cannot end its section or open another.
function inert(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/`{3,}/g, "'''").replace(/^#/, '\\#')
}

/** An MCP tool's section: its heading, its own description, and how a script calls it. */
export function mcpSection(tool: McpTool): Section {
  const id = toIdentifier(tool.name)
  const heading = id === tool.name ? `### \`${id}\`` : `### \`${id}\` (\`${inert(tool.name)}\`)`
  const description = inert(tool.description)
  const call = `\`tools.${id}(args)\` takes an open object of arguments, and resolves to the tool's text.`
  const lines = [heading, ...(description === '' ? [] : [description]), call]
  return { name: tool.name, server: serverOf(tool.name), text: lines.join('\n') }
}

function serversOf(sections: readonly Section[]): string[] {
  const names = new Set(sections.flatMap(section => (section.server === undefined ? [] : [section.server])))
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * Picks the sections that fit `budget` tokens: in each round every group, the
 * built-ins first and then the servers by name, places its cheapest remaining
 * section; a group whose next one does not fit drops out while the others go on.
 */
export function selectSections(sections: readonly Section[], budget: number): Group[] {
  const servers: (string | undefined)[] = [undefined, ...serversOf(sections)]
  // Unlike Pi, which keeps the input order, a server's ties and shown order go by name,
  // so the text depends on the set of tools and not on the order they arrive in;
  // the built-ins are a fixed list and keep its order.
  const inGroupOrder = (server: string | undefined, list: Section[]): Section[] =>
    server === undefined ? list : list.sort((a, b) => a.name.localeCompare(b.name))
  const groups = servers
    .map(server => ({ server, all: inGroupOrder(server, sections.filter(section => section.server === server)) }))
    .filter(group => group.all.length > 0)
  const queues = groups.map(group => [...group.all].sort((a, b) => costOf(a) - costOf(b)))
  const shown = new Set<Section>()
  let remaining = budget
  let active = queues
  while (active.length > 0) {
    active = active.filter(queue => {
      const next = queue.shift()
      if (next === undefined) return false
      if (costOf(next) > remaining) return false
      remaining -= costOf(next)
      shown.add(next)
      return queue.length > 0
    })
  }
  return groups.map(group => ({
    server: group.server,
    shown: group.all.filter(section => shown.has(section)),
    total: group.all.length,
  }))
}

function serverHeading(group: Group): string[] {
  if (group.server === undefined) return []
  if (group.shown.length === group.total) return [`## ${group.server}`]
  const listing = group.shown.length === 0 ? 'tools not listed' : 'some tools not listed'
  return [`## ${group.server} (${listing})`]
}

/** The sections that fit the budget, under `Nested tools:`; empty when there is no tool at all. */
export function renderSections(sections: readonly Section[], budget: number = SECTIONS_BUDGET): string {
  if (sections.length === 0) return ''
  const parts = selectSections(sections, budget).flatMap(group => [
    ...serverHeading(group),
    ...group.shown.map(section => section.text),
  ])
  return ['Nested tools:', ...parts].join('\n\n')
}

/** The `code` property's description: what the script is, then one section per nested tool. */
export function codeDescription(mcpTools: readonly McpTool[] = [], docs: readonly ToolDoc[] = EXPOSED_DOCS): string {
  const sections = renderSections([...docs.map(builtinSection), ...mcpTools.map(mcpSection)])
  return sections === '' ? CODE_LEAD : `${CODE_LEAD}\n\n${sections}`
}

/** The tool's own description: the intro and the globals; the sections ride in the `code` property. */
export function describeCodemode(): string {
  return [INTRO, GLOBALS].join('\n\n')
}
