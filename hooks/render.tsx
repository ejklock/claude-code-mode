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
/** The widest a box's content grows, so one long script line never stretches the row. */
const WIDTH_CAP = 100
/** Border and padding on both sides of a box's content. */
const FRAME = 4
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

/** The one width both boxes of a call share, from the script's longest line, the rows and the surface. */
function contentWidth(longest: number, columns: Columns, surfaceColumns: number | undefined): number {
  const cap = surfaceColumns === undefined ? WIDTH_CAP : Math.min(WIDTH_CAP, Math.max(TITLE.length, surfaceColumns - FRAME))
  return Math.min(cap, Math.max(TITLE.length, longest, rowWidth(columns)))
}

/** Cuts every line wider than the box with `…`, so none wraps inside it. */
function cutLines(text: string, width: number): string {
  return text
    .split('\n')
    .map(line => (line.length > width ? `${line.slice(0, width - 1)}…` : line))
    .join('\n')
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
          <Text dimColor>{TITLE}</Text>
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
    // Without the run's script width the box shrink-wraps its output.
    const width =
      run?.scriptWidth === undefined
        ? undefined
        : contentWidth(run.scriptWidth, columnsOf(rowsOf(run)), e.viewport?.columns)
    const fit = (text: string): string => (width === undefined ? text : cutLines(text, width))
    const boxWidth = width === undefined ? {} : { width: width + FRAME }

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
            <Text color="error">{fit(`✗ ${output}`)}</Text>
          </Box>
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
          <Text>{fit(output)}</Text>
        </Box>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
