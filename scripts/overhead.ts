/**
 * Measures the bridge's own cost with no model and no engine in the loop: one
 * run of the codemode child per sample, every nested call answered instantly
 * over the child's own socket, for scripts of 0, 1, 10 and 100 sequential
 * calls. The fixed cost is the 0-call median; the per-call cost is the median
 * span between one call line and the next, one full answer round trip, with
 * the total-over-fixed difference shown beside it for sizes too small to span.
 *
 *   node scripts/overhead.ts --runs 7
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { performance } from 'node:perf_hooks'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import { ANSWER_PATH, parseChildMessage } from '../shared/protocol.ts'
import type { CallAnswer, ChildMessage } from '../shared/protocol.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHILD = join(ROOT, 'child/main.ts')
const PINNED_PACKAGE = '@earendil-works/pi-codemode'
const SCRIPT_TIMEOUT_MS = 120_000
const EXPECTED_OUTPUT = 'bench-done'
const ANSWER_TEXT = 'bench-answer'
/** The script sizes measured, in calls: 0 is the fixed cost, the rest scale the calls. */
const SIZES: readonly number[] = [0, 1, 10, 100]

/** One measured run: how many calls its script made, how long it took, whether it ended right. */
export type OverheadSample = {
  calls: number
  ms: number
  ok: boolean
  /** Why the run failed, when it did. */
  reason?: string
  /** The spans between one call line and the next, in ms: each is one full answer round trip. */
  spans: readonly number[]
}

/** The kept runs of one script size, as medians and range. */
export type OverheadRow = {
  calls: number
  kept: number
  failed: number
  medianMs: number | undefined
  minMs: number | undefined
  maxMs: number | undefined
  /** The median span between call lines over the kept runs; a single call spans nothing. */
  perCallMs: number | undefined
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const below = sorted[middle - 1]
  const above = sorted[middle]
  return sorted.length % 2 === 1
    ? above
    : below === undefined || above === undefined
      ? undefined
      : (below + above) / 2
}

export function summarizeOverhead(samples: readonly OverheadSample[]): OverheadRow[] {
  const sizes = [...new Set(samples.map(sample => sample.calls))].sort((a, b) => a - b)
  return sizes.map(calls => {
    const ofSize = samples.filter(sample => sample.calls === calls)
    const kept = ofSize.filter(sample => sample.ok).map(sample => sample.ms)
    const spans = ofSize.filter(sample => sample.ok).flatMap(sample => sample.spans)
    return {
      calls,
      kept: kept.length,
      failed: ofSize.length - kept.length,
      medianMs: median(kept),
      minMs: kept.length === 0 ? undefined : Math.min(...kept),
      maxMs: kept.length === 0 ? undefined : Math.max(...kept),
      perCallMs: median(spans),
    }
  })
}

function scriptOf(calls: number): string {
  if (calls === 0) return `text('${EXPECTED_OUTPUT}')`
  return `for (let i = 0; i < ${calls}; i = i + 1) { await tools.Read({ file_path: '/codemode-overhead' }) }\ntext('${EXPECTED_OUTPUT}')`
}

function postAnswer(socketPath: string, answer: CallAnswer): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: ANSWER_PATH, method: 'POST' }, res => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
    req.end(JSON.stringify(answer))
  })
}

type DoneMessage = Extract<ChildMessage, { type: 'done' }>

/** What a run must hold to count, or why it does not. */
function problems(
  exitCode: number | null,
  done: DoneMessage | undefined,
  seen: number,
  calls: number,
  socketPath: string | undefined,
): string[] {
  const found: string[] = []
  if (exitCode !== 0) found.push(`the child exited with ${exitCode ?? 'a signal'}`)
  if (done === undefined) found.push('the child closed its output without a closing line')
  else if (done.ok !== true) found.push(`the script failed: ${done.error}`)
  else if (done.output !== EXPECTED_OUTPUT) found.push('the final output is wrong')
  if (seen !== calls) found.push(`the script made ${seen} of ${calls} calls`)
  if (socketPath !== undefined && existsSync(socketPath)) found.push('the socket file is left behind')
  return found
}

/** Spawns the child once, answers every nested call instantly, and times spawn to exit. */
export async function measureRun(calls: number): Promise<OverheadSample> {
  const startedAt = performance.now()
  const child = spawn('node', [CHILD], { stdio: ['pipe', 'pipe', 'inherit'] })
  const exited = new Promise<number | null>(resolve => child.on('close', resolve))
  child.stdin.end(JSON.stringify({ code: scriptOf(calls), timeoutMs: SCRIPT_TIMEOUT_MS }))
  let socketPath: string | undefined
  let seen = 0
  let done: DoneMessage | undefined
  const answers: Promise<void>[] = []
  const arrivals: number[] = []
  for await (const line of createInterface({ input: child.stdout })) {
    const message = parseChildMessage(line)
    if (message?.type === 'listening') socketPath = message.socketPath
    if (message?.type === 'done') done = message
    if (message?.type === 'call' && socketPath !== undefined) {
      seen++
      arrivals.push(performance.now())
      answers.push(postAnswer(socketPath, { id: message.id, ok: true, text: ANSWER_TEXT }))
    }
  }
  await Promise.all(answers)
  const exitCode = await exited
  const ms = performance.now() - startedAt
  const spans: number[] = []
  let previous: number | undefined
  for (const at of arrivals) {
    if (previous !== undefined) spans.push(at - previous)
    previous = at
  }
  const found = problems(exitCode, done, seen, calls, socketPath)
  return found.length === 0 ? { calls, ms, ok: true, spans } : { calls, ms, ok: false, reason: found.join('; '), spans }
}

function pinnedVersion(): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  return manifest.dependencies?.[PINNED_PACKAGE] ?? 'unpinned'
}

const ms = (value: number | undefined): string => value === undefined ? '-' : value.toFixed(1)

function printRow(row: OverheadRow, fixed: number | undefined): void {
  const per = row.calls === 0 ? 'fixed' : ms(row.perCallMs)
  const diff = fixed === undefined || row.calls === 0 || row.medianMs === undefined ? '-' : ms((row.medianMs - fixed) / row.calls)
  const cells = [String(row.calls), String(row.kept + row.failed), String(row.failed), ms(row.medianMs), ms(row.minMs), ms(row.maxMs), per, diff]
  console.log(cells.map((cell, index) => cell.padStart(5 + index * 2)).join(''))
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '7' } } })
  const runs = Number(values.runs)
  if (!Number.isInteger(runs) || runs < 1) {
    console.error('--runs needs a positive integer')
    return 2
  }
  console.log(`node ${process.version}, ${PINNED_PACKAGE} ${pinnedVersion()}, no model, sequential calls, instant answers, times in ms`)
  console.log(['calls', 'runs', 'failed', 'median', 'min', 'max', 'per call', 'diff/call'].map((cell, index) => cell.padStart(5 + index * 2)).join(''))
  let fixed: number | undefined
  for (const size of SIZES) {
    const warmUp = await measureRun(size)
    if (!warmUp.ok) console.log(`warm-up at ${size} calls failed: ${warmUp.reason}`)
    const samples: OverheadSample[] = []
    for (let run = 1; run <= runs; run++) samples.push(await measureRun(size))
    for (const sample of samples.filter(sample => !sample.ok)) console.log(`run at ${sample.calls} calls failed: ${sample.reason}`)
    const [row] = summarizeOverhead(samples)
    if (row === undefined) continue
    if (size === 0) fixed = row.medianMs
    printRow(row, fixed)
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main()
