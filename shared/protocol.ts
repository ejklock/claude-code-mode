/**
 * The wire format between the mod and the codemode child. Both import this
 * file, and it holds types and pure parsers only, so either side may load it.
 */

/** The tools a script may call; the child declares them and the mod refuses others. */
export const EXPOSED_TOOLS = ['Read', 'Bash'] as const

export type ExposedTool = (typeof EXPOSED_TOOLS)[number]

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
