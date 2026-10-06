import { EXPOSED_TOOLS, TOOL_SPECS } from '../shared/protocol.ts'
import type { ToolArg, ToolSpec } from '../shared/protocol.ts'

/** The line the system prompt carries so the model reaches for codemode unprompted. */
export const GUIDELINE =
  'Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.'

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
].join('\n')

const GLOBALS = [
  'Globals:',
  '- `text(value)` and `console.log(...)` add output; non-strings are JSON-stringified. A top-level `return` ends the script, and its value is not sent back.',
  '- `exit()` ends the script successfully, keeping its output.',
  '- `ALL_TOOLS` lists `{ name, description }` for each tool a script can call.',
].join('\n')

function toolSection(doc: ToolDoc): string {
  return [
    `### \`${doc.name}\``,
    `${doc.summary} \`tools.${doc.name}(args)\` takes ${doc.args}, and resolves to ${doc.resolves}.`,
  ].join('\n')
}

/** The most characters of a tool's description the build sends to the model. */
export const DESCRIPTION_CAP = 2048

function omittedNote(omitted: readonly ToolDoc[]): string[] {
  if (omitted.length === 0) return []
  const names = omitted.map(doc => `\`${doc.name}\``).join(', ')
  return [`${names}: callable too, with no section here, and listed in \`ALL_TOOLS\`.`]
}

function assemble(kept: readonly ToolDoc[], omitted: readonly ToolDoc[]): string {
  const nested = ['Nested tools:', ...kept.map(toolSection)].join('\n\n')
  return [INTRO, GLOBALS, nested, ...omittedNote(omitted)].join('\n\n')
}

/**
 * The model-facing description: the intro, the globals, then one section per
 * tool in `docs` order. When the whole does not fit the cap, the sections that
 * do not fit are dropped from the end and named as callable through `ALL_TOOLS`.
 */
export function describeCodemode(docs: readonly ToolDoc[] = EXPOSED_DOCS): string {
  for (let kept = docs.length; kept > 0; kept -= 1) {
    const text = assemble(docs.slice(0, kept), docs.slice(kept))
    if (text.length <= DESCRIPTION_CAP) return text
  }
  return assemble([], docs)
}
