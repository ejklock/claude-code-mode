export type CodemodeCallState = 'running' | 'done' | 'denied' | 'failed'

/** One nested call a codemode script made through the session's tools. */
export type CodemodeCall = {
  /** The id the script's child gave the call; unique within its run. */
  id: number
  tool: string
  /** One short line naming the target: a file path, the first line of a command. */
  label: string
  state: CodemodeCallState
  /** Epoch milliseconds. */
  startedAt: number
  endedAt?: number
  /** Why the call was denied or failed, as one short line. */
  reason?: string
}

/** One codemode call as the transcript draws it, keyed by the call's tool_use_id. */
export type CodemodeRun = {
  id: string
  startedAt: number
  endedAt?: number
  /** Length of the script's longest line, so the result row sizes its box like the script row. */
  scriptWidth?: number
  /** The most recent calls, oldest first, capped. */
  calls: CodemodeCall[]
  /** How many older calls the cap dropped from `calls`. */
  omitted: number
}

declare module 'claude-code' {
  interface PluginState {
    codemode: { runs: CodemodeRun[] }
  }
}
