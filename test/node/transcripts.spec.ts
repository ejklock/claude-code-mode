import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/transcripts.ts')
const CODEMODE = 'mcp__codemode__codemode'
const DAY = '2026-05-10T12:00:00.000Z'

type Call = { name: string; command?: string }

function entry(timestamp: string, sidechain: boolean, ...calls: Call[]): string {
  const content = calls.map(call => ({
    type: 'tool_use',
    name: call.name,
    input: call.command === undefined ? {} : { command: call.command },
  }))
  return JSON.stringify({ type: 'assistant', isSidechain: sidechain, timestamp, message: { content } })
}

const bash = (command: string): Call => ({ name: 'Bash', command })

function write(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`)
}

function scan(root: string, ...extra: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync('node', [SCRIPT, '--root', root, ...extra], { encoding: 'utf8' })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

/** The count printed after `label` on the line that starts with `prefix`. */
function countOf(stdout: string, prefix: string, section: 'main' | 'sidechain', label: string): number {
  const line = stdout.split('\n').find(candidate => candidate.startsWith(prefix)) ?? ''
  const part = line.split('|')[section === 'main' ? 0 : 1] ?? ''
  const found = new RegExp(`${label} (\\d+)`).exec(part)
  return found === null ? Number.NaN : Number(found[1])
}

describe('the transcript scan counts Bash, inline scripts and codemode per project', () => {
  let scratch = ''
  let root = ''

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'transcripts-'))
    root = join(scratch, 'projects')
    write(join(root, 'alpha', 's1.jsonl'), [
      entry(DAY, false, bash('python3 -c x'), bash('ls')),
      entry(DAY, false, { name: CODEMODE }, bash('node -e 1')),
      entry(DAY, true, bash("python3 - <<'EOF'"), { name: CODEMODE }),
      '{not json',
      '',
    ])
    write(join(root, 'alpha', 's1', 'subagents', 'agent-a.jsonl'), [entry(DAY, true, bash('ls'))])
    write(join(root, 'beta', 's2.jsonl'), [entry(DAY, false, bash('cat SECRET_TOKEN_123'))])
  })

  after(() => rmSync(scratch, { recursive: true, force: true }))

  it('Proves C3: a project line holds the exact counts for the main session', () => {
    const { stdout } = scan(root, '--since', '2026-05-01')
    assert.equal(countOf(stdout, 'alpha', 'main', 'bash'), 3)
    assert.equal(countOf(stdout, 'alpha', 'main', 'python-c'), 1)
    assert.equal(countOf(stdout, 'alpha', 'main', 'node-e'), 1)
    assert.equal(countOf(stdout, 'alpha', 'main', 'python-stdin'), 0)
    assert.equal(countOf(stdout, 'alpha', 'main', 'codemode'), 1)
  })

  it('Proves C3: the sidechain counts are apart, nested subagent files included', () => {
    const { stdout } = scan(root, '--since', '2026-05-01')
    assert.equal(countOf(stdout, 'alpha', 'sidechain', 'bash'), 2)
    assert.equal(countOf(stdout, 'alpha', 'sidechain', 'python-stdin'), 1)
    assert.equal(countOf(stdout, 'alpha', 'sidechain', 'codemode'), 1)
  })

  it('Proves C3: the total sums every project', () => {
    const { stdout } = scan(root, '--since', '2026-05-01')
    assert.equal(countOf(stdout, 'total', 'main', 'bash'), 4)
    assert.equal(countOf(stdout, 'total', 'sidechain', 'bash'), 2)
    assert.equal(countOf(stdout, 'total', 'main', 'codemode'), 1)
  })

  it('Proves C3: a malformed line is skipped and counted', () => {
    const { stdout, status } = scan(root, '--since', '2026-05-01')
    assert.equal(status, 0)
    assert.match(stdout, /skipped lines: 1\b/)
  })

  it('Proves C3: a command text never reaches stdout or stderr', () => {
    const { stdout, stderr } = scan(root, '--since', '2026-05-01')
    assert.doesNotMatch(stdout + stderr, /SECRET_TOKEN_123/)
  })

  it('Proves C3: a missing root exits 2 with a message', () => {
    const { status, stderr } = scan(join(scratch, 'absent'))
    assert.equal(status, 2)
    assert.match(stderr, /absent/)
  })
})

describe('the transcript window and the root boundary', () => {
  let scratch = ''
  let root = ''

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'transcripts-window-'))
    root = join(scratch, 'projects')
    write(join(root, 'gamma', 'w.jsonl'), [
      entry('2026-05-09T23:59:59.000Z', false, bash('ls')),
      entry('2026-05-10T00:00:00.000Z', false, bash('ls')),
      entry('2026-05-11T08:00:00.000Z', false, bash('ls')),
    ])
    const outside = join(scratch, 'outside')
    write(join(outside, 'o.jsonl'), [entry(DAY, false, bash('ls'), bash('ls'), bash('ls'))])
    symlinkSync(outside, join(root, 'linked'))
    symlinkSync(outside, join(root, 'gamma', 'inner'))
  })

  after(() => rmSync(scratch, { recursive: true, force: true }))

  it('Proves C3: the day before --since is excluded and the day itself is included', () => {
    const { stdout } = scan(root, '--since', '2026-05-10')
    assert.equal(countOf(stdout, 'gamma', 'main', 'bash'), 2)
  })

  it('Proves C3: a symlink inside the root pointing outside is not followed', () => {
    const { stdout } = scan(root, '--since', '2026-05-01')
    assert.equal(countOf(stdout, 'total', 'main', 'bash'), 3)
    assert.doesNotMatch(stdout, /linked/)
  })

  it('Proves C3: a bad --since exits 2', () => {
    const { status, stderr } = scan(root, '--since', 'yesterday')
    assert.equal(status, 2)
    assert.match(stderr, /--since/)
  })

  it('Proves C3: the default window is the last 30 days', () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    write(join(root, 'delta', 'd.jsonl'), [entry(recent, false, bash('ls')), entry(old, false, bash('ls'))])
    const { stdout } = scan(root)
    assert.equal(countOf(stdout, 'delta', 'main', 'bash'), 1)
  })
})
