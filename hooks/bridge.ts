import type {
  HookStream,
  HttpInit,
  HttpResponse,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  ToolCallArgs,
  ToolCallResult,
  ToolInfo,
} from 'claude-code'

import { ANSWER_PATH, CODEMODE_TOOL_ID, isExposedTool, parseChildMessage } from '../shared/protocol.ts'
import type { CallAnswer, ChildMessage, McpTool, RunRequest } from '../shared/protocol.ts'
import type { CodemodeCall, CodemodeCallState, CodemodeRun } from '../types/index.d.ts'

/**
 * What the bridge needs of the engine. The hooks loader refuses a module that
 * passes `$` around, so the hook builds these closures where it spells `$`.
 */
export type BridgeHost = {
  pluginRoot: string
  spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  callTool: (input: ToolCallArgs) => Promise<ToolCallResult>
  /** The tools the model has now, built-in and MCP alike. */
  listTools: () => Promise<ToolInfo[]>
  post: (url: string, init: HttpInit) => Promise<HttpResponse>
  /** Applies a change to the runs the transcript draws from. */
  publish: (change: (runs: CodemodeRun[]) => CodemodeRun[]) => Promise<void>
  now: () => Promise<number>
  /** Resolves after `ms` milliseconds; the hooks loader gives a module no timer of its own. */
  sleep: (ms: number) => Promise<void>
}

/** How long a failed run waits for the child's closing line, so a script error is not lost to a late-answer failure. */
export const CLOSING_GRACE_MS = 2000

/** Runs kept in `$.state`: the transcript rarely draws more than the latest few. */
export const RUN_LIMIT = 20
/** Calls kept per run; a script looping over files would otherwise grow one value without end. */
export const CALL_LIMIT = 100
const LABEL_CHARS = 80
const REASON_CHARS = 120
const ARGS_CHARS = 80

type Settled = {
  answer: CallAnswer
  state: Exclude<CodemodeCallState, 'running'>
  reason?: string
  /** Ledger only: the call may have taken effect though no answer says so; the transcript state stays as it is. */
  unknown?: true
  /** Ledger only: the tool held the input read-only, so redoing the call is safe; set on done calls. */
  readOnly?: true
}

// Built from strings so the source holds no raw control character. CSI and OSC
// sequences go whole; a lone ESC with its next character goes after them.
const ESCAPE_SEQUENCES = new RegExp(
  ['\\u001b\\[[0-9;?]*[ -/]*[@-~]', '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?', '\\u001b.?'].join('|'),
  'g',
)
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g

/** One printable line: what the state keeps must not carry a terminal's control codes. */
function firstLine(text: string, limit: number): string {
  const first = text.split(/[\r\n]/)[0] ?? ''
  const line = first.replace(ESCAPE_SEQUENCES, '').replaceAll('\t', ' ').replace(CONTROL_CHARACTERS, '').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

function labelOf(input: Record<string, unknown>): string {
  const target = input.file_path ?? input.command
  return typeof target === 'string' ? firstLine(target, LABEL_CHARS) : ''
}

function mapRun(runs: CodemodeRun[], id: string, change: (run: CodemodeRun) => CodemodeRun): CodemodeRun[] {
  return runs.map(run => (run.id === id ? change(run) : run))
}

function withCall(run: CodemodeRun, call: CodemodeCall): CodemodeRun {
  const calls = [...run.calls, call]
  const dropped = Math.max(0, calls.length - CALL_LIMIT)
  return { ...run, calls: calls.slice(dropped), omitted: run.omitted + dropped }
}

/**
 * Publishes one run's progress for the transcript to draw. Drawing is a side
 * view: a failed publish never reaches the script or the model.
 */
class RunTracker {
  private readonly host: BridgeHost
  private readonly runId: string

  constructor(host: BridgeHost, runId: string) {
    this.host = host
    this.runId = runId
  }

  begin(code: string): Promise<void> {
    return this.safely(async () => {
      const scriptWidth = Math.max(...code.split('\n').map(line => line.length))
      const run: CodemodeRun = {
        id: this.runId,
        startedAt: await this.host.now(),
        scriptWidth,
        calls: [],
        omitted: 0,
      }
      await this.host.publish(runs => [...runs, run].slice(-RUN_LIMIT))
    })
  }

  startCall(call: CallMessage): Promise<void> {
    return this.safely(async () => {
      const entry: CodemodeCall = {
        id: call.id,
        tool: call.tool,
        label: labelOf(call.input),
        state: 'running',
        startedAt: await this.host.now(),
      }
      await this.host.publish(runs => mapRun(runs, this.runId, run => withCall(run, entry)))
    })
  }

  settleCall(id: number, settled: Settled): Promise<void> {
    return this.safely(async () => {
      const endedAt = await this.host.now()
      const reason = settled.reason === undefined ? undefined : firstLine(settled.reason, REASON_CHARS)
      const patch = { state: settled.state, endedAt, ...(reason === undefined ? {} : { reason }) }
      await this.host.publish(runs =>
        mapRun(runs, this.runId, run => ({
          ...run,
          calls: run.calls.map(call => (call.id === id ? { ...call, ...patch } : call)),
        })),
      )
    })
  }

  finish(): Promise<void> {
    return this.safely(async () => {
      const endedAt = await this.host.now()
      await this.host.publish(runs => mapRun(runs, this.runId, run => ({ ...run, endedAt })))
    })
  }

  private async safely(work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch {
      // The drawing is optional; the script's answers do not depend on it.
    }
  }
}

type LedgerEntry = {
  id: number
  tool: string
  args: string
  state: CodemodeCallState
  detail: string
  unknown: boolean
  readOnly: boolean
}

const LEDGER_HEADING = 'Nested calls before the failure:'

function detailOf(settled: Settled): string {
  const text = settled.answer.ok ? settled.answer.text : (settled.reason ?? '')
  return firstLine(text, REASON_CHARS)
}

const MAY_HAVE_RUN = '(it may have taken effect; check before redoing it)'

function renderEntry(entry: LedgerEntry): string {
  const unknown = entry.unknown || entry.state === 'running'
  const detail = entry.state === 'running' ? 'no answer' : entry.detail
  const marked = entry.readOnly && entry.state === 'done' && !unknown
  const state = unknown ? 'unknown' : marked ? 'done (read-only)' : entry.state
  const text = detail === '' ? state : `${state}: ${detail}`
  return `#${entry.id} ${entry.tool} ${entry.args} — ${unknown ? `${text} ${MAY_HAVE_RUN}` : text}`
}

function renderOmitted(omitted: number): string[] {
  if (omitted === 0) return []
  return [`(${omitted} earlier ${omitted === 1 ? 'call' : 'calls'} left out)`]
}

/**
 * What the model reads after a failure: the nested calls that already ran.
 * It lives in the run state, apart from the published progress, which may fail.
 */
export class CallLedger {
  private entries: LedgerEntry[] = []
  private omitted = 0

  begin(call: CallMessage): void {
    const args = firstLine(JSON.stringify(call.input), ARGS_CHARS)
    this.entries.push({ id: call.id, tool: call.tool, args, state: 'running', detail: '', unknown: false, readOnly: false })
    const dropped = Math.max(0, this.entries.length - CALL_LIMIT)
    this.entries = this.entries.slice(dropped)
    this.omitted += dropped
  }

  settle(id: number, settled: Settled): void {
    this.entries = this.entries.map(entry =>
      entry.id === id ? { ...entry, state: settled.state, detail: detailOf(settled), unknown: settled.unknown === true, readOnly: settled.readOnly === true } : entry,
    )
  }

  /** The section to append to a failure's text; empty when no call was made. */
  render(): string {
    if (this.entries.length === 0) return ''
    return [LEDGER_HEADING, ...renderOmitted(this.omitted), ...this.entries.map(renderEntry)].join('\n')
  }
}

export type CodemodeOutcome = { ok: true; output: string } | { ok: false; error: string }

type CallMessage = Extract<ChildMessage, { type: 'call' }>
type DoneMessage = Extract<ChildMessage, { type: 'done' }>

type RunState = {
  socketPath: string | undefined
  closing: DoneMessage | undefined
  problem: string | undefined
  stderr: string
  /** The MCP tool names this run's script may call, besides the built-ins. */
  mcpNames: ReadonlySet<string>
  answers: Promise<void>[]
  /** Settles when a problem is recorded, so a read blocked on the child can stop. */
  aborted: Promise<void>
  abort: () => void
  tracker: RunTracker
  ledger: CallLedger
}

function newRunState(tracker: RunTracker, mcpNames: ReadonlySet<string>): RunState {
  let abort = (): void => {}
  const aborted = new Promise<void>(resolve => {
    abort = resolve
  })
  return {
    socketPath: undefined,
    closing: undefined,
    problem: undefined,
    stderr: '',
    mcpNames,
    answers: [],
    aborted,
    abort,
    tracker,
    ledger: new CallLedger(),
  }
}

function recordProblem(state: RunState, problem: string): void {
  state.problem ??= problem
  state.abort()
}

const STDERR_TAIL_CHARS = 2000
const BAD_LINE_CHARS = 200

/** Keys the engine reserves on a call; a script must never set them. */
const RESERVED_KEYS = ['tool', 'tool_use_id', 'consent', 'agentId']

/** Cuts a byte stream into whole lines; a line may span pieces or share one. */
class LineSplitter {
  private pending = ''

  push(text: string): string[] {
    const pieces = (this.pending + text).split('\n')
    this.pending = pieces.pop() ?? ''
    return pieces.filter(piece => piece.trim() !== '')
  }
}

/**
 * Runs one codemode script in a child process and serves the child's nested
 * tool calls through `$.tool.call`, so each runs under the session's
 * permission check and hooks.
 */
export class CodemodeBridge {
  private readonly host: BridgeHost
  private readonly timeoutMs: number

  constructor(host: BridgeHost, timeoutMs: number) {
    this.host = host
    this.timeoutMs = timeoutMs
  }

  /** `runId` is the codemode call's tool_use_id, the key its transcript row draws from. */
  async run(code: string, runId: string): Promise<CodemodeOutcome> {
    const mcpTools = await this.connectedMcpTools()
    const request: RunRequest = { code, timeoutMs: this.timeoutMs, mcpTools }
    const tracker = new RunTracker(this.host, runId)
    await tracker.begin(code)
    const state = newRunState(tracker, new Set(mcpTools.map(tool => tool.name)))
    const exit = await this.readChild(JSON.stringify(request), state)
    await Promise.allSettled(state.answers)
    await tracker.finish()
    return this.outcome(state, exit)
  }

  /** A list that cannot be read leaves the script with the built-ins; the model is told nothing new. */
  private async connectedMcpTools(): Promise<McpTool[]> {
    try {
      const listed = await this.host.listTools()
      return listed
        .filter(tool => tool.mcp && tool.name !== CODEMODE_TOOL_ID)
        .map(({ name, description }) => ({ name, description }))
    } catch {
      return []
    }
  }

  private async readChild(input: string, state: RunState): Promise<string> {
    const argv = ['node', `${this.host.pluginRoot}/child/main.ts`]
    const stream = this.host.spawn({ argv, input })
    const lines = new LineSplitter()
    try {
      while (state.closing === undefined || state.problem === undefined) {
        const next = await Promise.race([stream.next(), state.aborted])
        if (next === undefined) break
        if (next.done) return this.describeExit(next.value.code, next.value.signal)
        this.takeChunk(next.value, lines, state)
      }
      // Not awaited: a return() waits behind a read still pending on the child.
      stream.return({ code: null, signal: null }).catch(() => undefined)
      return 'killed by the mod'
    } catch (error) {
      recordProblem(state, `the codemode child could not run: ${errorMessage(error)}`)
      return 'did not start'
    }
  }

  private takeChunk(chunk: ProcessSpawnChunk, lines: LineSplitter, state: RunState): void {
    if (chunk.stream === 'stderr') state.stderr = (state.stderr + chunk.text).slice(-STDERR_TAIL_CHARS)
    else for (const line of lines.push(chunk.text)) this.handleLine(line, state)
  }

  private describeExit(code: number | null, signal: string | null): string {
    if (code !== null) return `exited with code ${code}`
    return `was stopped by signal ${signal ?? 'unknown'}`
  }

  private handleLine(line: string, state: RunState): void {
    const message = parseChildMessage(line)
    if (message === undefined) {
      recordProblem(state, `the codemode child sent a malformed line: ${line.slice(0, BAD_LINE_CHARS)}`)
    } else if (message.type === 'listening') {
      state.socketPath = message.socketPath
    } else if (message.type === 'done') {
      state.closing = message
    } else if (state.socketPath === undefined) {
      recordProblem(state, 'the codemode child asked for a tool before it announced its socket')
    } else {
      state.answers.push(this.serve(message, state.socketPath, state))
    }
  }

  private async serve(call: CallMessage, socketPath: string, state: RunState): Promise<void> {
    state.ledger.begin(call)
    await state.tracker.startCall(call)
    const settled = await this.execute(call, state.mcpNames)
    state.ledger.settle(call.id, settled)
    await state.tracker.settleCall(call.id, settled)
    try {
      await this.host.post(`http://bridge${ANSWER_PATH}`, {
        method: 'POST',
        body: JSON.stringify(settled.answer),
        socketPath,
      })
    } catch (error) {
      // The child may be ending on a script error: the read goes on for its closing line, but only for the grace.
      state.problem ??= `the answer to a nested call could not reach the child: ${errorMessage(error)}`
      void this.host.sleep(CLOSING_GRACE_MS).then(state.abort, state.abort)
    }
  }

  private async execute(call: CallMessage, mcpNames: ReadonlySet<string>): Promise<Settled> {
    const refused = (reason: string): Settled => ({
      answer: { id: call.id, ok: false, error: reason },
      state: 'denied',
      reason,
    })
    const failed = (reason: string): Settled => ({
      answer: { id: call.id, ok: false, error: reason },
      state: 'failed',
      reason,
    })
    if (!isExposedTool(call.tool) && !mcpNames.has(call.tool)) return refused(`tool ${call.tool} is not available to codemode scripts`)
    const input = Object.fromEntries(
      Object.entries(call.input).filter(([key]) => !RESERVED_KEYS.includes(key)),
    )
    try {
      // The tool's own schema validates the arguments; the script chose them.
      const result = await this.host.callTool({ ...input, tool: call.tool } as ToolCallArgs)
      if (result.deny !== undefined) return refused(result.deny)
      if (result.isError === true) return failed(result.text ?? `${call.tool} failed`)
      const answer = { id: call.id, ok: true as const, text: result.text ?? '' }
      return result.isReadOnly === true ? { answer, state: 'done', readOnly: true } : { answer, state: 'done' }
    } catch (error) {
      return thrownOutcome(call.id, error)
    }
  }

  private outcome(state: RunState, exit: string): CodemodeOutcome {
    if (state.problem === undefined && state.closing?.ok === true) return { ok: true, output: state.closing.output }
    return { ok: false, error: withLedger(this.failure(state, exit), state.ledger) }
  }

  private failure(state: RunState, exit: string): string {
    if (state.closing?.ok === false) {
      const printed = state.closing.output === '' ? '' : `\n\nOutput before the failure:\n${state.closing.output}`
      // A late answer that cannot reach the exited child is a symptom of the script's end, so it follows the cause.
      const late = state.problem === undefined ? '' : `\n\n${state.problem}`
      return `${state.closing.error}${printed}${late}`
    }
    if (state.problem !== undefined) return state.problem
    const stderr = state.stderr.trim() === '' ? '' : `\n${state.stderr.trim()}`
    return `the codemode child ${exit} without a closing line${stderr}`
  }
}

function withLedger(text: string, ledger: CallLedger): string {
  const section = ledger.render()
  return section === '' ? text : `${text}\n\n${section}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function thrownOutcome(id: number, error: unknown): Settled {
  const reason = errorMessage(error)
  return { answer: { id, ok: false, error: reason }, state: 'failed', reason, unknown: true }
}
