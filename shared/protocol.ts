/**
 * The wire format between the mod and the codemode child. Both import this
 * file, and it holds types and pure parsers only, so either side may load it.
 */

/** The tools a script may call; the child declares them and the mod refuses others. */
export const EXPOSED_TOOLS = ['Read', 'Bash'] as const

export type ExposedTool = (typeof EXPOSED_TOOLS)[number]

/** One argument of an exposed tool: the child declares it, the description names it. */
export type ToolArg = {
  type: 'string' | 'number'
  isRequired: boolean
  /** How the model-facing description words the argument. */
  note?: string
  /** The argument's `description` in the schema a script can inspect. */
  sandboxNote?: string
}

/** What a script may pass an exposed tool and what the call resolves to. */
export type ToolSpec = {
  /** The tool's `description` in the sandbox's `ALL_TOOLS`. */
  sandboxDescription: string
  summary: string
  resolves: string
  args: Record<string, ToolArg>
}

export const TOOL_SPECS: Record<ExposedTool, ToolSpec> = {
  Read: {
    sandboxDescription: 'Reads a file; resolves to its text.',
    summary: 'Reads a file.',
    resolves: 'the file text',
    args: {
      file_path: { type: 'string', isRequired: true, note: 'absolute path', sandboxNote: 'Absolute path of the file.' },
      offset: { type: 'number', isRequired: false, note: 'first line, from 1', sandboxNote: 'First line to read, from 1.' },
      limit: { type: 'number', isRequired: false, note: 'number of lines', sandboxNote: 'Number of lines to read.' },
    },
  },
  Bash: {
    sandboxDescription: 'Runs a shell command; resolves to its output.',
    summary: 'Runs a shell command.',
    resolves: 'the command output',
    args: {
      command: { type: 'string', isRequired: true },
      timeout: { type: 'number', isRequired: false, note: 'milliseconds', sandboxNote: 'Milliseconds.' },
    },
  },
}

/** The JSON schema of a tool's input, as the child declares it to the sandbox. */
export function inputSchemaOf(spec: ToolSpec): Record<string, unknown> {
  const entries = Object.entries(spec.args)
  return {
    type: 'object',
    properties: Object.fromEntries(
      entries.map(([name, arg]) => [name, { type: arg.type, ...(arg.sandboxNote === undefined ? {} : { description: arg.sandboxNote }) }]),
    ),
    required: entries.filter(([, arg]) => arg.isRequired).map(([name]) => name),
  }
}

/** What the child declares for an exposed tool: its description, input schema and output schema. */
export function declarationOf(name: ExposedTool): {
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
} {
  const spec = TOOL_SPECS[name]
  return {
    description: spec.sandboxDescription,
    inputSchema: inputSchemaOf(spec),
    outputSchema: { type: 'string' },
  }
}

/** Path the mod POSTs each answer to, over the child's Unix socket. */
export const ANSWER_PATH = '/answer'

/** What the mod writes to the child's standard input. */
export type RunRequest = {
  code: string
  timeoutMs: number
}

/** One JSON line the child writes to standard output. */
export type ChildMessage =
  | { type: 'listening'; socketPath: string }
  | { type: 'call'; id: number; tool: string; input: Record<string, unknown> }
  | { type: 'done'; ok: true; output: string }
  | { type: 'done'; ok: false; error: string; output: string }

/** The body of a POST from the mod: how the nested call `id` ended. */
export type CallAnswer =
  | { id: number; ok: true; text: string }
  | { id: number; ok: false; error: string }

type Json = Record<string, unknown>

function parseJson(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text)
    const isObject = typeof value === 'object' && value !== null && !Array.isArray(value)
    return isObject ? (value as Json) : undefined
  } catch {
    return undefined
  }
}

export function isExposedTool(name: string): name is ExposedTool {
  return (EXPOSED_TOOLS as readonly string[]).includes(name)
}

export function parseRunRequest(text: string): RunRequest | undefined {
  const json = parseJson(text)
  const isValid = json !== undefined && typeof json.code === 'string' && typeof json.timeoutMs === 'number'
  return isValid ? { code: json.code as string, timeoutMs: json.timeoutMs as number } : undefined
}

export function parseChildMessage(line: string): ChildMessage | undefined {
  const json = parseJson(line)
  if (json === undefined) return undefined
  if (json.type === 'listening' && typeof json.socketPath === 'string') {
    return { type: 'listening', socketPath: json.socketPath }
  }
  if (json.type === 'call') return parseCall(json)
  if (json.type === 'done') return parseDone(json)
  return undefined
}

function parseCall(json: Json): ChildMessage | undefined {
  const { id, tool, input } = json
  const isInput = typeof input === 'object' && input !== null && !Array.isArray(input)
  if (typeof id !== 'number' || typeof tool !== 'string' || !isInput) return undefined
  return { type: 'call', id, tool, input: input as Record<string, unknown> }
}

function parseDone(json: Json): ChildMessage | undefined {
  const { ok, output, error } = json
  if (typeof output !== 'string') return undefined
  if (ok === true) return { type: 'done', ok, output }
  if (ok === false && typeof error === 'string') return { type: 'done', ok, error, output }
  return undefined
}

export function parseCallAnswer(text: string): CallAnswer | undefined {
  const json = parseJson(text)
  if (json === undefined || typeof json.id !== 'number') return undefined
  if (json.ok === true && typeof json.text === 'string') return { id: json.id, ok: true, text: json.text }
  if (json.ok === false && typeof json.error === 'string') return { id: json.id, ok: false, error: json.error }
  return undefined
}
