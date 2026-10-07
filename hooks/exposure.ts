import { CODEMODE_TOOL_ID } from '../shared/protocol.ts'

export type ExposureMode = 'codemode' | 'deferred' | 'direct' | 'hidden'

// Structural, so the node specs load this file without the kit's type package.
type PluginOptions = Readonly<Record<string, unknown>>

type Entry = { text: string; mode: ExposureMode; pattern: RegExp | undefined }

type Table = {
  readonly exact: ReadonlyMap<string, ExposureMode>
  readonly patterns: readonly Entry[]
  readonly servers: ReadonlyMap<string, ExposureMode>
}

declare const brand: unique symbol

/** Opaque: built by `readExposure`, read by `modeOf`; the table behind it stays in this file. */
export type Exposure = { readonly [brand]: 'exposure' }

const tables = new WeakMap<Exposure, Table>()

// The order patterns are tried in: the first list to match wins.
const LISTS = [
  ['mcpHidden', 'hidden'],
  ['mcpCodemode', 'codemode'],
  ['mcpDeferred', 'deferred'],
  ['mcpDirect', 'direct'],
] as const satisfies readonly (readonly [string, ExposureMode])[]

const MCP_PREFIX = 'mcp__'
const SEPARATOR = '__'

const patternOf = (text: string): RegExp =>
  new RegExp(`^${text.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)

// `/plugin configure` stores a multiple-string field as one comma-separated string; a hand-written array also arrives.
const listOf = (options: PluginOptions, key: string): readonly string[] => {
  const value = options[key]
  if (value === undefined) return []
  if (Array.isArray(value)) {
    if (value.every((item): item is string => typeof item === 'string')) return value
  } else if (typeof value === 'string') {
    const pieces = value.split(',')
    // A trailing comma is a typing slip, and an empty string splits to one empty piece.
    if (pieces.at(-1)?.trim() === '') pieces.pop()
    return pieces
  }
  throw new Error(`The ${key} setting takes a list of strings or one comma-separated string.`)
}

/** Reads the four lists; throws on a bad value, an empty entry or an entry named twice. */
export function readExposure(options: PluginOptions): Exposure {
  const seen = new Map<string, string>()
  const exact = new Map<string, ExposureMode>()
  const servers = new Map<string, ExposureMode>()
  const patterns: Entry[] = []

  for (const [key, mode] of LISTS) {
    for (const written of listOf(options, key)) {
      const trimmed = written.trim()
      const text = trimmed.startsWith(MCP_PREFIX) ? trimmed.slice(MCP_PREFIX.length).trim() : trimmed
      if (text === '') throw new Error(`The ${key} setting holds an empty entry.`)
      const earlier = seen.get(text)
      if (earlier !== undefined) {
        const where = earlier === key ? `twice in ${key}` : `in ${earlier} and ${key}`
        throw new Error(`The entry "${text}" is named ${where}; each entry takes one exposure mode.`)
      }
      seen.set(text, key)
      if (text.includes('*')) patterns.push({ text, mode, pattern: patternOf(text) })
      else if (text.includes(SEPARATOR)) exact.set(text, mode)
      else servers.set(text, mode)
    }
  }
  const handle = Object.freeze({}) as Exposure
  tables.set(handle, { exact, patterns, servers })
  return handle
}

/** The mode the settings give an MCP tool name; `undefined` leaves the tool as the host has it. */
export function modeOf(exposure: Exposure, tool: string): ExposureMode | undefined {
  if (!tool.startsWith(MCP_PREFIX) || tool === CODEMODE_TOOL_ID) return undefined
  const table = tables.get(exposure)
  if (table === undefined) return undefined
  const name = tool.slice(MCP_PREFIX.length)
  const exactMode = table.exact.get(name)
  if (exactMode !== undefined) return exactMode
  const hit = table.patterns.find(entry => entry.pattern?.test(name))
  if (hit !== undefined) return hit.mode
  const server = name.slice(0, Math.max(name.indexOf(SEPARATOR), 0))
  return table.servers.get(server)
}
