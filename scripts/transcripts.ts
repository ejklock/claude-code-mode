/**
 * Counts, in Claude Code transcripts, how often the model ran Bash, an inline
 * Python or Node script through Bash, and the codemode tool. It prints counts
 * only, never a command's text, and reads the transcripts read-only.
 *
 *   node scripts/transcripts.ts                       (~/.claude/projects, the last 30 days)
 *   node scripts/transcripts.ts --since 2026-05-01   (the window starts at 00:00 UTC of that day)
 *   node scripts/transcripts.ts --root <directory>
 */
import { createReadStream, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { inlineScriptKind } from './inline-script.ts'
import type { InlineKind } from './inline-script.ts'

const TOOL = 'mcp__codemode__codemode'
const DAY_MS = 86_400_000
const DEFAULT_WINDOW_DAYS = 30
const KINDS: InlineKind[] = ['python-c', 'python-stdin', 'node-e', 'node-stdin']

type Bucket = { bash: number; codemode: number; kinds: Record<InlineKind, number> }
type Counts = { main: Bucket; sidechain: Bucket; skipped: number }

type Block = { type?: string; name?: string; input?: { command?: unknown } }
type Line = { isSidechain?: unknown; timestamp?: unknown; message?: { content?: unknown } }

const emptyBucket = (): Bucket => ({
  bash: 0,
  codemode: 0,
  kinds: { 'python-c': 0, 'python-stdin': 0, 'node-e': 0, 'node-stdin': 0 },
})
const emptyCounts = (): Counts => ({ main: emptyBucket(), sidechain: emptyBucket(), skipped: 0 })

function add(target: Bucket, source: Bucket): void {
  target.bash += source.bash
  target.codemode += source.codemode
  for (const kind of KINDS) target.kinds[kind] += source.kinds[kind]
}

function addCounts(target: Counts, source: Counts): void {
  add(target.main, source.main)
  add(target.sidechain, source.sidechain)
  target.skipped += source.skipped
}

function countBlock(bucket: Bucket, block: Block): void {
  if (block.type !== 'tool_use') return
  if (block.name === TOOL) bucket.codemode++
  if (block.name !== 'Bash') return
  bucket.bash++
  const command = block.input?.command
  const kind = typeof command === 'string' ? inlineScriptKind(command) : undefined
  if (kind !== undefined) bucket.kinds[kind]++
}

function countLine(counts: Counts, line: Line, since: number): void {
  const time = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN
  if (!(time >= since)) return
  const content = line.message?.content
  if (!Array.isArray(content)) return
  const bucket = line.isSidechain === true ? counts.sidechain : counts.main
  for (const block of content as Block[]) countBlock(bucket, block)
}

async function scanFile(path: string, since: number, counts: Counts): Promise<void> {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const text of lines) {
    if (text.trim() === '') continue
    try {
      countLine(counts, JSON.parse(text) as Line, since)
    } catch {
      counts.skipped++
    }
  }
}

/** Every regular .jsonl file under a directory; a symlink, to a file or a directory, is never followed. */
function transcriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return transcriptFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  })
}

function bucketText(bucket: Bucket): string {
  const kinds = KINDS.map(kind => `${kind} ${bucket.kinds[kind]}`).join(', ')
  return `bash ${bucket.bash}, ${kinds}, codemode ${bucket.codemode}`
}

function lineText(name: string, counts: Counts): string {
  return `${name} main: ${bucketText(counts.main)} | sidechain: ${bucketText(counts.sidechain)}`
}

/** The start of the window in epoch milliseconds, or undefined when the flag is not a calendar day. */
function windowStart(since: string | undefined, now: number): number | undefined {
  if (since === undefined) return now - DEFAULT_WINDOW_DAYS * DAY_MS
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return undefined
  const start = Date.parse(`${since}T00:00:00Z`)
  return Number.isNaN(start) ? undefined : start
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { root: { type: 'string' }, since: { type: 'string' } } })
  const root = values.root ?? join(homedir(), '.claude', 'projects')
  const since = windowStart(values.since, Date.now())
  if (since === undefined) {
    console.error('--since needs a date as YYYY-MM-DD; the window starts at 00:00 UTC of that day')
    return 2
  }
  if (!existsSync(root)) {
    console.error(`the transcripts root does not exist: ${root}`)
    return 2
  }
  const total = emptyCounts()
  const projects = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  for (const project of projects) {
    const counts = emptyCounts()
    for (const file of transcriptFiles(join(root, project.name))) await scanFile(file, since, counts)
    console.log(lineText(project.name, counts))
    addCounts(total, counts)
  }
  console.log(lineText('total', total))
  console.log(`skipped lines: ${total.skipped}`)
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main()
