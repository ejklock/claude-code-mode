import { atom, read } from 'claude-code'
import type { Register, StateDollar } from 'claude-code'

import type { CodemodeCall, CodemodeRun } from '../types/index.d.ts'

// The state scan reads the reference from this file, so register.ts spells its
// own; an invariant spec fails when the two differ.
const RUNS = atom({ plugin: 'codemode', key: 'runs' } as const, [])

const CODEMODE_TOOL = 'mcp__codemode__codemode'
const TITLE = 'codemode · script'

const GLYPHS = { running: '…', done: '✓', denied: '✗', failed: '✗' } as const

const LONG_PATH_CHARS = 30
const KEPT_SEGMENTS = 2
const LABEL_MAX = 30
/** The widest a box's content grows without a measured surface, so one long script line never stretches the row. */
const WIDTH_CAP = 100
/** Border and padding on both sides of a box's content. */
const FRAME = 4
/** The narrowest content a measured surface gets; a box on a viewport under FRAME + this overflows it. */
const MIN_CONTENT = 4
/** The most output lines a result box draws; the model still receives the whole output. */
const RESULT_LINES = 10
const ZERO_WIDTH: [number, number][] = [
  [0x300, 0x36f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
]
const DOUBLE_WIDTH: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]
const GAP = '  '

type Columns = { tool: number; label: number; tail: number }
type Row = { call: CodemodeCall; label: string; tail: string }

function scriptOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('code' in input)) return undefined
  return typeof input.code === 'string' ? input.code : undefined
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** What the row's last column says: the duration, or the verdict of a call that did not run. */
function tailOf(call: CodemodeCall): string {
  if (call.state === 'running') return ''
  if (call.state === 'done') return duration((call.endedAt ?? call.startedAt) - call.startedAt)
  return call.state
}

function summaryOf(run: CodemodeRun): string {
  const count = run.calls.length + run.omitted
  const parts = [`${count} ${count === 1 ? 'call' : 'calls'}`]
  if (run.endedAt !== undefined) parts.push(duration(run.endedAt - run.startedAt))
  for (const state of ['denied', 'failed'] as const) {
    const total = run.calls.filter(call => call.state === state).length
    if (total > 0) parts.push(`${total} ${state}`)
  }
  return parts.join(' · ')
}

/** Shortens each long path in a label to its last segments; the state keeps the full label. */
function shorten(label: string): string {
  return label
    .split(' ')
    .map(word => {
      const segments = word.split('/')
      const isLongPath = segments.length > KEPT_SEGMENTS + 1 && word.length > LONG_PATH_CHARS
      return isLongPath ? `…/${segments.slice(-KEPT_SEGMENTS).join('/')}` : word
    })
    .join(' ')
}

function clip(label: string): string {
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label
}

function columnsOf(rows: Row[]): Columns {
  const widest = (pick: (row: Row) => string): number => Math.max(0, ...rows.map(row => pick(row).length))
  return { tool: widest(row => row.call.tool), label: widest(row => row.label), tail: widest(row => row.tail) }
}

function rowWidth(columns: Columns): number {
  return 2 + columns.tool + 1 + columns.label + GAP.length + columns.tail
}

function rowsOf(run: CodemodeRun | undefined): Row[] {
  return (run?.calls ?? []).map(call => ({ call, label: clip(shorten(call.label)), tail: tailOf(call) }))
}

/** The width a measured surface leaves a box's content, never under a few columns so the `…` cut stays legible; the transcript takes no margin, as the engine's own rules reach the same edge. */
function surfaceWidth(surfaceColumns: number): number {
  return Math.max(MIN_CONTENT, surfaceColumns - FRAME)
}

/** The one width both boxes of a call share: the surface's room when measured, else the script's and the rows'. */
function contentWidth(longest: number, columns: Columns, surfaceColumns: number | undefined): number {
  if (surfaceColumns !== undefined) return surfaceWidth(surfaceColumns)
  return Math.min(WIDTH_CAP, Math.max(TITLE.length, longest, rowWidth(columns)))
}

/** The result box's width: the surface's room when measured, else the run's stored script width, else none. */
function resultWidth(run: CodemodeRun | undefined, surfaceColumns: number | undefined): number | undefined {
  if (surfaceColumns !== undefined) return surfaceWidth(surfaceColumns)
  return run?.scriptWidth === undefined ? undefined : contentWidth(run.scriptWidth, columnsOf(rowsOf(run)), undefined)
}

function within(point: number, ranges: [number, number][]): boolean {
  return ranges.some(([low, high]) => point >= low && point <= high)
}

/** A character's terminal columns from short range lists; no full Unicode width table, no grapheme clusters. */
function charWidth(point: number): number {
  if (within(point, ZERO_WIDTH)) return 0
  return within(point, DOUBLE_WIDTH) ? 2 : 1
}

function columnsWide(text: string): number {
  return [...text].reduce((total, char) => total + charWidth(char.codePointAt(0) ?? 0), 0)
}

/** The longest start of the line that fits `room` columns, never splitting a code point. */
function fitting(line: string, room: number): string {
  let used = 0
  let kept = ''
  for (const char of line) {
    used += charWidth(char.codePointAt(0) ?? 0)
    if (used > room) break
    kept += char
  }
  return kept
}

/** Cuts every line wider than the box, in terminal columns, with `…`, so none wraps inside it. */
function cutLines(text: string, width: number): string {
  return text
    .split('\n')
    .map(line => (columnsWide(line) > width ? `${fitting(line, width - 1)}…` : line))
    .join('\n')
}

/** The text to draw and how many lines it leaves out; one trailing newline is not a line, and a text within the cap is returned whole. */
function capLines(text: string): { shown: string; hidden: number } {
  const lines = text.split('\n')
  const count = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  if (count <= RESULT_LINES) return { shown: text, hidden: 0 }
  return { shown: lines.slice(0, RESULT_LINES).join('\n'), hidden: count - RESULT_LINES }
}

function moreLine(hidden: number): string {
  return `… ${hidden} more ${hidden === 1 ? 'line' : 'lines'}`
}

async function runOf($: StateDollar, id: string): Promise<CodemodeRun | undefined> {
  return (await read($, RUNS)).find(run => run.id === id)
}

/**
 * Draws a codemode call in the transcript as two bordered boxes, each as wide
 * as its content: the script with its nested calls in columns, then the
 * summary and the output. Every other row, and any codemode row it cannot
 * read, stays the engine's own. A refused call's reason stays in the state and
 * in the model's result; the row says only that it was denied or failed.
 */
export const registerRender: Register = on => {
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const script = e.props.tool === CODEMODE_TOOL ? scriptOf(e.props.input) : undefined
    if (script === undefined) return next(e)
    const run = await runOf($, e.requestId)
    const { Box, Text, Code } = $.ui.resolve(e)
    const rows = rowsOf(run)
    const columns = columnsOf(rows)
    const longest = Math.max(...script.split('\n').map(line => line.length))
    const width = contentWidth(longest, columns, e.viewport?.columns)

    return (
      <Box
        key="codemode-row"
        flexDirection="column"
        alignSelf="flex-start"
        width={width + FRAME}
        borderStyle="round"
        borderDimColor
        paddingX={1}
      >
        <Box key="title">
          <Text dimColor>{cutLines(TITLE, width)}</Text>
        </Box>
        <Code source={cutLines(script, width)} language="javascript" />
        {rows.length > 0 ? (
          <Box key="divider">
            <Text dimColor>{'─'.repeat(width)}</Text>
          </Box>
        ) : null}
        {run !== undefined && run.omitted > 0 ? (
          <Text dimColor>{`… ${run.omitted} earlier calls not shown`}</Text>
        ) : null}
        {rows.map(({ call, label, tail }) => (
          <Box key={`call-${call.id}`}>
            <Text>{`${GLYPHS[call.state]} ${call.tool.padEnd(columns.tool)} ${label.padEnd(columns.label)}`}</Text>
            <Text
              dimColor={call.state === 'running' || call.state === 'done'}
              color={call.state === 'denied' || call.state === 'failed' ? 'error' : undefined}
            >
              {`${GAP}${tail.padStart(columns.tail)}`}
            </Text>
          </Box>
        ))}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const output = e.props.output
    if (e.props.tool !== CODEMODE_TOOL || typeof output !== 'string') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const run = await runOf($, e.requestId)
    // Without a viewport or the run's script width the box shrink-wraps its output.
    const width = resultWidth(run, e.viewport?.columns)
    const fit = (text: string): string => (width === undefined ? text : cutLines(text, width))
    const boxWidth = width === undefined ? {} : { width: width + FRAME }
    const { shown, hidden } = capLines(output)
    const more = hidden > 0 ? <Box key="more"><Text dimColor>{fit(moreLine(hidden))}</Text></Box> : null

    if (e.props.isErrored) {
      return (
        <Box
          key="codemode-result"
          flexDirection="column"
          alignSelf="flex-start"
          {...boxWidth}
          borderStyle="round"
          borderColor="error"
          borderDimColor
          paddingX={1}
        >
          <Box key="error">
            <Text color="error">{fit(`✗ ${shown}`)}</Text>
          </Box>
          {more}
        </Box>
      )
    }

    return (
      <Box
        key="codemode-result"
        flexDirection="column"
        alignSelf="flex-start"
        {...boxWidth}
        borderStyle="round"
        borderColor="success"
        borderDimColor
        paddingX={1}
      >
        <Box key="summary">
          <Text bold color="success">
            ✓
          </Text>
          <Text>{` ${run === undefined ? 'done' : summaryOf(run)}`}</Text>
        </Box>
        <Box key="output">
          <Text>{fit(shown)}</Text>
        </Box>
        {more}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
