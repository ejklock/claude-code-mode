import type {
  HookStream,
  HttpInit,
  HttpResponse,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  ToolCallArgs,
  ToolCallResult,
} from 'claude-code'

import { ANSWER_PATH, isExposedTool, parseChildMessage } from '../shared/protocol.ts'
import type { CallAnswer, ChildMessage, RunRequest } from '../shared/protocol.ts'

/**
 * What the bridge needs of the engine. The hooks loader refuses a module that
 * passes `$` around, so the hook builds these closures where it spells `$`.
 */
export type BridgeHost = {
  pluginRoot: string
  spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  callTool: (input: ToolCallArgs) => Promise<ToolCallResult>
  post: (url: string, init: HttpInit) => Promise<HttpResponse>
}

export type CodemodeOutcome = { ok: true; output: string } | { ok: false; error: string }

type CallMessage = Extract<ChildMessage, { type: 'call' }>
type DoneMessage = Extract<ChildMessage, { type: 'done' }>

type RunState = {
  socketPath: string | undefined
  closing: DoneMessage | undefined
  problem: string | undefined
  stderr: string
  answers: Promise<void>[]
  /** Settles when a problem is recorded, so a read blocked on the child can stop. */
  aborted: Promise<void>
  abort: () => void
}

function newRunState(): RunState {
  let abort = (): void => {}
  const aborted = new Promise<void>(resolve => {
    abort = resolve
  })
  return {
    socketPath: undefined,
    closing: undefined,
    problem: undefined,
    stderr: '',
    answers: [],
    aborted,
    abort,
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

  async run(code: string): Promise<CodemodeOutcome> {
    const request: RunRequest = { code, timeoutMs: this.timeoutMs }
    const state = newRunState()
    const exit = await this.readChild(JSON.stringify(request), state)
    await Promise.allSettled(state.answers)
    return this.outcome(state, exit)
  }

  private async readChild(input: string, state: RunState): Promise<string> {
    const argv = ['node', `${this.host.pluginRoot}/child/main.ts`]
    const stream = this.host.spawn({ argv, input })
    const lines = new LineSplitter()
    try {
      while (state.problem === undefined) {
        const next = await Promise.race([stream.next(), state.aborted])
        if (next === undefined) break
        if (next.done) return this.describeExit(next.value.code, next.value.signal)
        const { stream: pipe, text } = next.value
        if (pipe === 'stderr') state.stderr = (state.stderr + text).slice(-STDERR_TAIL_CHARS)
        else for (const line of lines.push(text)) this.handleLine(line, state)
      }
      // Not awaited: a return() waits behind a read still pending on the child.
      stream.return({ code: null, signal: null }).catch(() => undefined)
      return 'killed by the mod'
    } catch (error) {
      recordProblem(state, `the codemode child could not run: ${errorMessage(error)}`)
      return 'did not start'
    }
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
    const answer = await this.execute(call)
    try {
      await this.host.post(`http://bridge${ANSWER_PATH}`, {
        method: 'POST',
        body: JSON.stringify(answer),
        socketPath,
      })
    } catch (error) {
      recordProblem(state, `the answer to a nested call could not reach the child: ${errorMessage(error)}`)
    }
  }

  private async execute(call: CallMessage): Promise<CallAnswer> {
    if (!isExposedTool(call.tool)) {
      return { id: call.id, ok: false, error: `tool ${call.tool} is not available to codemode scripts` }
    }
    const input = Object.fromEntries(
      Object.entries(call.input).filter(([key]) => !RESERVED_KEYS.includes(key)),
    )
    try {
      // The tool's own schema validates the arguments; the script chose them.
      const result = await this.host.callTool({ ...input, tool: call.tool } as ToolCallArgs)
      if (result.deny !== undefined) return { id: call.id, ok: false, error: result.deny }
      if (result.isError === true) {
        return { id: call.id, ok: false, error: result.text ?? `${call.tool} failed` }
      }
      return { id: call.id, ok: true, text: result.text ?? '' }
    } catch (error) {
      return { id: call.id, ok: false, error: errorMessage(error) }
    }
  }

  private outcome(state: RunState, exit: string): CodemodeOutcome {
    if (state.problem !== undefined) return { ok: false, error: state.problem }
    if (state.closing?.ok === true) return { ok: true, output: state.closing.output }
    if (state.closing !== undefined) {
      const printed = state.closing.output === '' ? '' : `\n\nOutput before the failure:\n${state.closing.output}`
      return { ok: false, error: `${state.closing.error}${printed}` }
    }
    const stderr = state.stderr.trim() === '' ? '' : `\n${state.stderr.trim()}`
    return {
      ok: false,
      error: `the codemode child ${exit} without a closing line${stderr}`,
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
