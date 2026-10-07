import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CALL_LIMIT, CallLedger, CodemodeBridge, thrownOutcome } from '../hooks/bridge.ts'
import { EXPOSED_DOCS, GUIDELINE, codeDescription, describeCodemode, toolDocs } from '../hooks/describe.ts'
import type { ToolDoc } from '../hooks/describe.ts'
import { ANSWER_PATH, EXPOSED_TOOLS } from '../shared/protocol.ts'
import type { CodemodeRun } from '../types/index.d.ts'

const CODEMODE = 'mcp__codemode__codemode'
const SOCKET = '/tmp/stand-in/bridge.sock'

const line = (message: Record<string, unknown>): string => `${JSON.stringify(message)}\n`
const listening = line({ type: 'listening', socketPath: SOCKET })
const call = (id: number, tool: string, input: Record<string, unknown>): string =>
  line({ type: 'call', id, tool, input })
const done = (output: string): string => line({ type: 'done', ok: true, output })

type WaitForPosts = { waitForPosts: number }
type Plan = {
  pieces: (string | WaitForPosts)[]
  exit?: number
  stderr?: string
  /** The Read tool answers only once this many answers were POSTed. */
  readWaitsForPosts?: number
  /** Every answer POST is refused by the transport. */
  postFails?: boolean
}
type Post = { url: string; socketPath: string | undefined; body: Record<string, unknown> }

type StandIn = {
  posts: Post[]
  spawned: { argv: readonly string[]; input: string | undefined }[]
  toolsSeen: string[]
  bashInputs: Record<string, unknown>[]
}

/**
 * Stands in for the child (a kit hook beneath the mod, since the kit runs no
 * process) and for the engine's tools; it tests the mod's logic alone.
 */
function standIn(on: On, plan: Plan): StandIn {
  const stand: StandIn = { posts: [], spawned: [], toolsSeen: [], bashInputs: [] }
  const waiters: { count: number; release: () => void }[] = []
  const arrived = (count: number): Promise<void> =>
    stand.posts.length >= count
      ? Promise.resolve()
      : new Promise(release => waiters.push({ count, release }))

  on('http.fetch', (_$, e) => {
    if (plan.postFails === true) return { deny: 'the socket is gone' }
    stand.posts.push({
      url: e.url,
      socketPath: e.init?.socketPath,
      body: JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>,
    })
    for (const waiter of waiters) if (stand.posts.length >= waiter.count) waiter.release()
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })

  on('process.spawn', async function* (_$, e) {
    stand.spawned.push({ argv: e.argv, input: e.input })
    for (const piece of plan.pieces) {
      if (typeof piece === 'string') yield { stream: 'stdout' as const, text: piece }
      else await arrived(piece.waitForPosts)
    }
    if (plan.stderr !== undefined) yield { stream: 'stderr' as const, text: plan.stderr }
    return { value: { code: plan.exit ?? 0, signal: null } }
  })

  on('tool.call', { tool: 'Read' }, async () => {
    if (plan.readWaitsForPosts !== undefined) await arrived(plan.readWaitsForPosts)
    stand.toolsSeen.push('Read')
    return { result: 'unused', text: 'FIXTURE-CONTENT' }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    stand.toolsSeen.push('Bash')
    stand.bashInputs.push({ ...e })
    return { result: 'unused', text: String(e.command).replace(/^echo /, '') }
  })
  return stand
}

/** Stands in for the engine's Write and Edit; `inputs` holds what each received. */
function standInFileTools(on: On): { inputs: Record<string, unknown>[] } {
  const stand = { inputs: [] as Record<string, unknown>[] }
  const answer = (tool: string, e: Record<string, unknown>) => {
    stand.inputs.push({ ...e })
    return { result: 'unused', text: `${tool} done` }
  }
  on('tool.call', { tool: 'Write' }, (_$, e) => answer('Write', e))
  on('tool.call', { tool: 'Edit' }, (_$, e) => answer('Edit', e))
  return stand
}

/** Stands in for `$.state`; the returned reader gives the latest value stored. */
function standInState(on: On): () => unknown {
  let held: { value: unknown; version: number } = { value: undefined, version: 0 }
  on('state.get', () => ({ value: held }))
  on('state.set', (_$, e) => {
    held = { value: e.value, version: held.version + 1 }
    return { value: { isSet: true as const, version: held.version } }
  })
  return () => held.value
}

function denyWrite(on: On): void {
  on('classic.PreToolUse', ($, e, next) =>
    e.tool === 'Write' ? { deny: 'Write is denied by a permission rule' } : next(e),
  )
}

function denyEchoDenied(on: On): void {
  on('classic.PreToolUse', ($, e, next) =>
    e.tool === 'Bash' && String(e.command).includes('denied')
      ? { deny: 'Bash(echo denied) is denied by a permission rule' }
      : next(e),
  )
}

const callCodemode = ($: Engine) => $.tool.call({ tool: CODEMODE, code: 'the script' })

const SCRIPT_WITH_READ_AND_BASH = [
  listening,
  call(1, 'Read', { file_path: '/fixture.txt' }),
  call(2, 'Bash', { command: 'echo codemode-ok' }),
  { waitForPosts: 2 },
  done('FIXTURE-CONTENT\ncodemode-ok'),
]

describe('the codemode tool, mod side', () => {
  test('Proves C1: it registers the tool at session start', async ($, on) => {
    const registered: Record<string, unknown>[] = []
    on('tool.register', (_$, e) => {
      registered.push({ ...e })
      return { value: { tool: `mcp__codemode__${e.name}` } }
    })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    expect(registered.map(spec => spec.name)).toEqual(['codemode'])
    expect(JSON.stringify(registered[0]?.inputSchema)).toContain('code')
  })

  test('Proves C1: Read and Bash run through tool.call and the output is the one result', async ($, on) => {
    const stand = standIn(on, { pieces: SCRIPT_WITH_READ_AND_BASH })
    const reply = await callCodemode($)
    expect(reply.result).toBe('FIXTURE-CONTENT\ncodemode-ok')
    expect([...stand.toolsSeen].sort()).toEqual(['Bash', 'Read'])
    const answers = Object.fromEntries(stand.posts.map(post => [post.body.id, post.body]))
    expect(answers[1]).toEqual({ id: 1, ok: true, text: 'FIXTURE-CONTENT' })
    expect(answers[2]).toEqual({ id: 2, ok: true, text: 'codemode-ok' })
    expect(stand.posts.every(post => post.socketPath === SOCKET)).toBe(true)
    expect(stand.posts.every(post => post.url.endsWith(ANSWER_PATH))).toBe(true)
    expect(stand.spawned[0]?.argv[0]).toBe('node')
    expect(stand.spawned[0]?.argv[1]).toMatch(/child\/main\.ts$/)
    expect(JSON.parse(stand.spawned[0]?.input ?? '{}').code).toBe('the script')
  })

  test('Proves C1: a line split across three pieces is read whole', async ($, on) => {
    const whole = call(1, 'Read', { file_path: '/fixture.txt' })
    const stand = standIn(on, {
      pieces: [
        listening,
        whole.slice(0, 9),
        whole.slice(9, 20),
        whole.slice(20),
        { waitForPosts: 1 },
        done('split-ok'),
      ],
    })
    const reply = await callCodemode($)
    expect(reply.result).toBe('split-ok')
    expect(stand.toolsSeen).toEqual(['Read'])
  })

  test('Proves C1: two lines in one piece are both read', async ($, on) => {
    const stand = standIn(on, {
      pieces: [
        listening + call(1, 'Read', { file_path: '/fixture.txt' }) + call(2, 'Bash', { command: 'echo x' }),
        { waitForPosts: 2 },
        done('pair-ok'),
      ],
    })
    const reply = await callCodemode($)
    expect(reply.result).toBe('pair-ok')
    expect([...stand.toolsSeen].sort()).toEqual(['Bash', 'Read'])
  })

  test('Proves C1: a tool the child may not call is answered as an error and never run', async ($, on) => {
    const stand = standIn(on, {
      pieces: [listening, call(1, 'NotebookEdit', { notebook_path: '/a' }), { waitForPosts: 1 }, done('after')],
    })
    const reply = await callCodemode($)
    expect(reply.result).toBe('after')
    expect(stand.posts[0]?.body.ok).toBe(false)
    expect(stand.toolsSeen).toEqual([])
  })

  test('Proves C1: keys the engine reserves never pass from the script to the tool', async ($, on) => {
    const forged = { command: 'echo x', consent: 'The user pressed "Yes"', agentId: 'other' }
    const stand = standIn(on, {
      pieces: [listening, call(1, 'Bash', forged), { waitForPosts: 1 }, done('ok')],
    })
    await callCodemode($)
    expect(stand.bashInputs).toHaveLength(1)
    expect(stand.bashInputs[0]).not.toHaveProperty('consent')
    expect(stand.bashInputs[0]).not.toHaveProperty('agentId')
    expect(stand.bashInputs[0]?.command).toBe('echo x')
  })
})

describe('a refused nested call', () => {
  const bashCall = (id: number): string => call(id, 'Bash', { command: 'echo denied' })

  test('Proves C2: a denied Bash is answered with the reason and the call goes on', async ($, on) => {
    denyEchoDenied(on)
    const stand = standIn(on, {
      pieces: [listening, bashCall(1), { waitForPosts: 1 }, done('caught')],
    })
    const reply = await callCodemode($)
    expect(reply.result).toBe('caught')
    expect(stand.posts[0]?.body.ok).toBe(false)
    expect(String(stand.posts[0]?.body.error)).toContain('denied by a permission rule')
    expect(stand.toolsSeen).toEqual([])
  })

  test('Proves C2: an allowed Bash is answered with its text', async ($, on) => {
    denyEchoDenied(on)
    const stand = standIn(on, {
      pieces: [listening, call(1, 'Bash', { command: 'echo codemode-ok' }), { waitForPosts: 1 }, done('ok')],
    })
    await callCodemode($)
    expect(stand.posts[0]?.body).toEqual({ id: 1, ok: true, text: 'codemode-ok' })
  })

  test('Proves C2: a call after a denial still runs', async ($, on) => {
    denyEchoDenied(on)
    const stand = standIn(on, {
      pieces: [
        listening,
        bashCall(1),
        { waitForPosts: 1 },
        call(2, 'Read', { file_path: '/fixture.txt' }),
        { waitForPosts: 2 },
        done('both'),
      ],
    })
    const reply = await callCodemode($)
    expect(reply.result).toBe('both')
    expect(stand.posts.map(post => post.body.ok)).toEqual([false, true])
    expect(stand.toolsSeen).toEqual(['Read'])
  })
})

describe('Write and Edit nested calls', () => {
  const writeInput = { file_path: '/work/a.txt', content: 'one' }
  const editInput = { file_path: '/work/a.txt', old_string: 'one', new_string: 'two', replace_all: true }

  test('Proves C2: an allowed Write is forwarded with the script input and answered with its text', async ($, on) => {
    const files = standInFileTools(on)
    const stand = standIn(on, {
      pieces: [listening, call(1, 'Write', { ...writeInput, consent: 'forged', agentId: 'other' }), { waitForPosts: 1 }, done('ok')],
    })
    await callCodemode($)
    expect(files.inputs).toHaveLength(1)
    expect(files.inputs[0]).toMatchObject({ ...writeInput, tool: 'Write' })
    expect(files.inputs[0]).not.toHaveProperty('consent')
    expect(files.inputs[0]).not.toHaveProperty('agentId')
    expect(stand.posts[0]?.body).toEqual({ id: 1, ok: true, text: 'Write done' })
  })

  test('Proves C2: an allowed Edit is forwarded with the script input and answered with its text', async ($, on) => {
    const files = standInFileTools(on)
    const stand = standIn(on, {
      pieces: [listening, call(1, 'Edit', { ...editInput, tool_use_id: 'forged' }), { waitForPosts: 1 }, done('ok')],
    })
    await callCodemode($)
    expect(files.inputs).toHaveLength(1)
    expect(files.inputs[0]).toMatchObject({ ...editInput, tool: 'Edit' })
    // The bridge strips the forged id, then the engine stamps its own on the event, so the key stays and only its value is checked.
    expect(files.inputs[0]?.tool_use_id).not.toBe('forged')
    expect(stand.posts[0]?.body).toEqual({ id: 1, ok: true, text: 'Edit done' })
  })

  test('Proves C2: a Write denied by a PreToolUse hook reaches the script as a refusal and never runs', async ($, on) => {
    denyWrite(on)
    const files = standInFileTools(on)
    const stand = standIn(on, {
      pieces: [listening, call(1, 'Write', writeInput), { waitForPosts: 1 }, done('caught')],
    })
    const reply = await callCodemode($)
    expect(reply.result).toBe('caught')
    expect(stand.posts[0]?.body).toEqual({ id: 1, ok: false, error: 'Write is denied by a permission rule' })
    expect(files.inputs).toEqual([])
  })

  test('Proves C2: the live call row is labelled with the file path in full', async ($, on) => {
    const stored = standInState(on)
    mock.clock(on, { now: 1_000 })
    standInFileTools(on)
    standIn(on, {
      pieces: [listening, call(1, 'Write', writeInput), { waitForPosts: 1 }, done('ok')],
    })
    await callCodemode($)
    const runs = stored() as { calls: { tool: string; label: string }[] }[]
    expect(runs[0]?.calls.map(row => [row.tool, row.label])).toEqual([['Write', '/work/a.txt']])
  })
})

type Listed = { name: string; description: string; mcp: boolean }

const ECHO: Listed = { name: 'mcp__fake__echo', description: 'Echoes text.', mcp: true }

/**
 * Stands in for the session's tool list and for the MCP tool `mcp__fake__echo`;
 * `inputs` holds what the echo tool received and `otherCalls` any other MCP tool called.
 */
function standInMcp(on: On, listed: Listed[] | Error): { inputs: Record<string, unknown>[]; otherCalls: string[] } {
  const stand = { inputs: [] as Record<string, unknown>[], otherCalls: [] as string[] }
  on('tool.list', () => {
    if (listed instanceof Error) throw listed
    return { value: listed }
  })
  on('tool.call', (_$, e, next) => {
    if (e.tool !== ECHO.name) {
      if (e.tool.startsWith('mcp__') && e.tool !== CODEMODE) stand.otherCalls.push(e.tool)
      return next(e)
    }
    const input: Record<string, unknown> = { ...e }
    stand.inputs.push(input)
    return { result: 'unused', text: `echo: ${String(input.text)}` }
  })
  return stand
}

const spawnedMcpTools = (stand: StandIn): unknown => JSON.parse(stand.spawned[0]?.input ?? '{}').mcpTools

describe('MCP nested calls', () => {
  test('Proves C2: an MCP tool of this run is forwarded with the script input, reserved keys stripped', async ($, on) => {
    const mcp = standInMcp(on, [ECHO])
    const stand = standIn(on, {
      pieces: [listening, call(1, ECHO.name, { text: 'hi', consent: 'forged', agentId: 'other' }), { waitForPosts: 1 }, done('ok')],
    })
    await callCodemode($)
    expect(mcp.inputs).toHaveLength(1)
    expect(mcp.inputs[0]).toMatchObject({ text: 'hi', tool: ECHO.name })
    expect(mcp.inputs[0]).not.toHaveProperty('consent')
    expect(mcp.inputs[0]).not.toHaveProperty('agentId')
    expect(stand.posts[0]?.body).toEqual({ id: 1, ok: true, text: 'echo: hi' })
    expect(spawnedMcpTools(stand)).toEqual([{ name: ECHO.name, description: ECHO.description }])
  })

  test('Proves C2: a denial from a PreToolUse hook reaches the script as a refusal and the tool never runs', async ($, on) => {
    on('classic.PreToolUse', (_$, e, next) => (e.tool === ECHO.name ? { deny: 'echo is denied by a rule' } : next(e)))
    const mcp = standInMcp(on, [ECHO])
    const stand = standIn(on, {
      pieces: [listening, call(1, ECHO.name, { text: 'hi' }), { waitForPosts: 1 }, done('caught')],
    })
    const reply = await callCodemode($)
    expect(reply.result).toBe('caught')
    expect(stand.posts[0]?.body).toEqual({ id: 1, ok: false, error: 'echo is denied by a rule' })
    expect(mcp.inputs).toEqual([])
  })

  test('Proves C2: an mcp name outside this run list is refused before any tool call', async ($, on) => {
    const ghost: string = 'mcp__ghost__run'
    const mcp = standInMcp(on, [ECHO])
    const stand = standIn(on, {
      pieces: [listening, call(1, ghost, {}), { waitForPosts: 1 }, done('after')],
    })
    await callCodemode($)
    expect(stand.posts[0]?.body).toEqual({
      id: 1,
      ok: false,
      error: `tool ${ghost} is not available to codemode scripts`,
    })
    expect(mcp.otherCalls).toEqual([])
  })

  test('Proves C2: the codemode tool itself is refused and never sent to the child', async ($, on) => {
    const nested: string[] = []
    on('tool.call', { tool: CODEMODE }, (_$, e, next) => {
      if (e.code !== 'inner') return next(e)
      nested.push('inner')
      return { result: 'unused' }
    })
    standInMcp(on, [{ name: CODEMODE, description: 'codemode', mcp: true }, ECHO])
    const stand = standIn(on, {
      pieces: [listening, call(1, CODEMODE, { code: 'inner' }), { waitForPosts: 1 }, done('after')],
    })
    await callCodemode($)
    expect(stand.posts[0]?.body.ok).toBe(false)
    expect(nested).toEqual([])
    expect(spawnedMcpTools(stand)).toEqual([{ name: ECHO.name, description: ECHO.description }])
  })

  test('Proves C2: a tool the list marks as built-in is not declared as MCP', async ($, on) => {
    standInMcp(on, [{ name: 'Glob', description: 'Finds files.', mcp: false }, ECHO])
    const stand = standIn(on, { pieces: [listening, done('ok')] })
    await callCodemode($)
    expect(spawnedMcpTools(stand)).toEqual([{ name: ECHO.name, description: ECHO.description }])
  })

  test('Proves C2: a built-in still works when the list holds no MCP tool', async ($, on) => {
    standInMcp(on, [])
    const stand = standIn(on, { pieces: SCRIPT_WITH_READ_AND_BASH })
    const reply = await callCodemode($)
    expect(reply.result).toBe('FIXTURE-CONTENT\ncodemode-ok')
    expect(spawnedMcpTools(stand)).toEqual([])
  })

  test('Proves C2: a list that rejects leaves the run with the built-ins and the same result', async ($, on) => {
    standInMcp(on, new Error('the list is gone'))
    const stand = standIn(on, { pieces: SCRIPT_WITH_READ_AND_BASH })
    const reply = await callCodemode($)
    expect(reply.result).toBe('FIXTURE-CONTENT\ncodemode-ok')
    expect(reply.deny).toBeUndefined()
    expect(spawnedMcpTools(stand)).toEqual([])
  })
})

describe('mod-side failures end as an errored result', () => {
  test('Proves C3: a child that exits non-zero before a closing line', async ($, on) => {
    standIn(on, { pieces: [listening], exit: 3, stderr: 'node: crashed' })
    const reply = await callCodemode($)
    expect(reply.deny).toContain('exited with code 3')
    expect(reply.deny).toContain('node: crashed')
  })

  test('Proves C3: a malformed line', async ($, on) => {
    standIn(on, { pieces: [listening, 'this is not json\n', done('never read')] })
    const reply = await callCodemode($)
    expect(reply.deny).toContain('malformed')
    expect(reply.deny).toContain('this is not json')
  })

  test('Proves C3: a stream that ends without a closing line', async ($, on) => {
    standIn(on, { pieces: [listening] })
    const reply = await callCodemode($)
    expect(reply.deny).toContain('without a closing line')
  })

  test('Proves C3: a script that failed is an errored result with its message and output', async ($, on) => {
    standIn(on, {
      pieces: [listening, line({ type: 'done', ok: false, error: 'boom', output: 'partial' })],
    })
    const reply = await callCodemode($)
    expect(reply.deny).toContain('boom')
    expect(reply.deny).toContain('partial')
  })
})

describe('two nested calls in flight at once', () => {
  const twoCalls = [
    listening,
    call(1, 'Read', { file_path: '/fixture.txt' }),
    call(2, 'Bash', { command: 'echo codemode-ok' }),
    { waitForPosts: 2 },
    done('both'),
  ]

  test('Proves concurrency: answers in order each carry their own id and text', async ($, on) => {
    const stand = standIn(on, { pieces: twoCalls })
    const reply = await callCodemode($)
    expect(reply.result).toBe('both')
    expect(stand.posts.map(post => post.body)).toEqual([
      { id: 1, ok: true, text: 'FIXTURE-CONTENT' },
      { id: 2, ok: true, text: 'codemode-ok' },
    ])
  })

  test('Proves concurrency: the second call answers first and each answer keeps its id', async ($, on) => {
    const stand = standIn(on, { pieces: twoCalls, readWaitsForPosts: 1 })
    const reply = await callCodemode($)
    expect(reply.result).toBe('both')
    expect(stand.posts.map(post => post.body)).toEqual([
      { id: 2, ok: true, text: 'codemode-ok' },
      { id: 1, ok: true, text: 'FIXTURE-CONTENT' },
    ])
  })

  test('Proves concurrency: a denial of the second call does not touch the first answer', async ($, on) => {
    denyEchoDenied(on)
    const stand = standIn(on, {
      pieces: [
        listening,
        call(1, 'Read', { file_path: '/fixture.txt' }),
        call(2, 'Bash', { command: 'echo denied' }),
        { waitForPosts: 2 },
        done('both'),
      ],
      readWaitsForPosts: 1,
    })
    const reply = await callCodemode($)
    expect(reply.result).toBe('both')
    expect(stand.posts.map(post => [post.body.id, post.body.ok])).toEqual([
      [2, false],
      [1, true],
    ])
    expect(stand.posts[1]?.body.text).toBe('FIXTURE-CONTENT')
  })
})

describe('an answer that cannot be delivered', () => {
  test('Proves prompt failure: the call ends at once while the child waits for the answer', async ($, on) => {
    standIn(on, {
      pieces: [listening, call(1, 'Read', { file_path: '/fixture.txt' }), { waitForPosts: 99 }],
      postFails: true,
    })
    const startedAt = Date.now()
    const reply = await callCodemode($)
    expect(Date.now() - startedAt).toBeLessThan(3000)
    expect(reply.deny).toContain('could not reach the child')
    expect(reply.deny).toContain('the socket is gone')
  })

  test('Proves prompt failure: a refused POST after the closing line is still an error', async ($, on) => {
    standIn(on, {
      pieces: [listening, call(1, 'Read', { file_path: '/fixture.txt' }), done('too late')],
      postFails: true,
    })
    const reply = await callCodemode($)
    expect(reply.result).toBeUndefined()
    expect(reply.deny).toContain('could not reach the child')
  })

  test('Proves prompt failure: a delivered answer changes nothing', async ($, on) => {
    const stand = standIn(on, { pieces: SCRIPT_WITH_READ_AND_BASH })
    const reply = await callCodemode($)
    expect(reply.result).toBe('FIXTURE-CONTENT\ncodemode-ok')
    expect(stand.posts).toHaveLength(2)
  })
})

describe('the width a run publishes', () => {
  test('Proves P2: a run carries the length of its longest script line', async ($, on) => {
    const stored = standInState(on)
    mock.clock(on, { now: 1_000 })
    standIn(on, { pieces: [listening, done('ok')] })

    await $.tool.call({ tool: CODEMODE, code: 'short\nthe longest line here\nmid line' })
    const runs = stored() as { scriptWidth?: number }[]
    expect(runs[0]?.scriptWidth).toBe('the longest line here'.length)
  })
})

describe('a progress state that cannot be published', () => {
  test('Proves N1: the model gets the same result as when publishing works', async ($, on) => {
    let isBroken = false
    let held = { value: undefined as unknown, version: 0 }
    on('state.get', () => {
      if (isBroken) throw new Error('the state is gone')
      return { value: held }
    })
    on('state.set', (_$, e) => {
      if (isBroken) throw new Error('the state is gone')
      held = { value: e.value, version: held.version + 1 }
      return { value: { isSet: true as const, version: held.version } }
    })
    mock.clock(on, { now: 1_000 })
    standIn(on, { pieces: SCRIPT_WITH_READ_AND_BASH })

    const working = await callCodemode($)
    expect(held.value).toBeDefined()

    isBroken = true
    const failing = await callCodemode($)
    expect(working.result).toBe('FIXTURE-CONTENT\ncodemode-ok')
    expect(failing).toEqual(working)
  })
})

const ENGINE_ORIGIN = { plugin: 'engine', tier: 'core' } as const
const GUIDELINE_ID = 'codemode:guideline'

const engineSection = (id: string, scope: 'shared' | 'session') => ({ id, text: `text of ${id}`, scope })

function standInPrompt(on: On, sections: ReturnType<typeof engineSection>[]): void {
  on('prompt.compose', () => ({ sections }))
}

const composeFor = ($: Engine, tools: string[]) =>
  $.prompt.compose({
    model: 'a-model',
    promptModel: 'a-model',
    surfaces: [],
    tools,
    outputStyle: null,
    traits: [],
  })

describe('the codemode description', () => {
  test('Proves C1: the tool is declared up front with the intro, the globals and one section per tool', async ($, on) => {
    on('tool.describe', (_$, e) => ({ description: e.description, isDeferred: true as const }))
    const answer = await $.tool.describe({ tool: CODEMODE, description: 'registered', provider: ENGINE_ORIGIN })

    expect(answer.isDeferred).toBe(false)
    expect(answer.description).toContain('Runs JavaScript that calls other tools')
    expect(answer.description).toContain('Globals:')
    expect(answer.description).toContain('`text(value)`')
    expect(answer.description).toContain('`exit()`')
    expect(answer.description).toContain('`ALL_TOOLS`')
    expect(answer.description).not.toContain('Nested tools:')
    expect(answer.description.length).toBeLessThanOrEqual(2048)
  })

  test('Proves C1: another tool keeps its description and its placement', async ($, on) => {
    on('tool.describe', (_$, e) => ({ description: e.description, isDeferred: true as const }))
    const answer = await $.tool.describe({ tool: 'Bash', description: 'the engine text', provider: ENGINE_ORIGIN })
    expect(answer).toEqual({ description: 'the engine text', isDeferred: true })
  })

  test('Proves C1: the builder gives one section per exposed tool, in list order', () => {
    const extra = { name: 'Grep', summary: 'Searches.', args: '`pattern`', resolves: 'the matches' }
    const sections = (docs: readonly ToolDoc[]) =>
      [...codeDescription([], docs).matchAll(/^### `(\w+)`$/gm)].map(match => match[1])

    expect(sections(EXPOSED_DOCS)).toEqual([...EXPOSED_TOOLS])
    expect(sections([...EXPOSED_DOCS, extra])).toEqual([...EXPOSED_TOOLS, 'Grep'])
    expect(codeDescription([], [...EXPOSED_DOCS, extra])).toContain('`tools.Grep(args)` takes `pattern`')
  })

  test('Proves C3: the sections name Write and Edit with their arguments', () => {
    const text = codeDescription()
    expect(text).toContain('`tools.Write(args)` takes `file_path`')
    expect(text).toContain('`tools.Edit(args)` takes `file_path`')
    expect(text).toContain('`replace_all`')
  })
})

/** Stands in for the engine's registration and the session's tool list; `registered` collects each call. */
function standInRegistration(on: On, tools: () => Listed[]) {
  const registered: { description: string; code: string }[] = []
  on('tool.register', (_$, e) => {
    const properties = (e.inputSchema as { properties: { code: { description: string } } }).properties
    registered.push({ description: e.description ?? '', code: properties.code.description })
    return { value: { tool: `mcp__codemode__${e.name}` } }
  })
  on('tool.list', () => ({ value: tools() }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  return registered
}

const startSession = ($: Engine) => $.session.start({ cwd: '/work', surface: null, isInteractive: false })
const startTurn = ($: Engine, turnId: string) => $.turn.start({ text: 'go', turnId })

describe('the sections follow the connected tools', () => {
  test('Proves C3: session start registers the short description and the sections in the code property', async ($, on) => {
    const registered = standInRegistration(on, () => [ECHO])
    await startSession($)
    expect(registered).toHaveLength(1)
    expect(registered[0]?.description).toBe(describeCodemode())
    expect(registered[0]?.description).not.toContain('### ')
    expect(registered[0]?.code).toContain('### `mcp__fake__echo`')
    expect(registered[0]?.code).toContain('## fake')
    expect(registered[0]?.code).toContain('### `Read`')
  })

  test('Proves C3: a tool that connects later is registered with its section at the next turn', async ($, on) => {
    let listed: Listed[] = []
    const registered = standInRegistration(on, () => listed)
    await startSession($)
    listed = [ECHO]
    await startTurn($, 't1')
    expect(registered).toHaveLength(2)
    expect(registered[0]?.code).not.toContain('mcp__fake__echo')
    expect(registered[1]?.code).toContain('### `mcp__fake__echo`')
  })

  test('Proves C3: unchanged tools register nothing again', async ($, on) => {
    const registered = standInRegistration(on, () => [ECHO])
    await startSession($)
    await startTurn($, 't1')
    await startTurn($, 't2')
    expect(registered).toHaveLength(1)
  })

  test('Proves C3: a list that rejects registers the built-ins and the run goes on', async ($, on) => {
    const registered = standInRegistration(on, () => {
      throw new Error('the list is gone')
    })
    await startSession($)
    await startTurn($, 't1')
    expect(registered).toHaveLength(1)
    expect(registered[0]?.code).toContain('### `Read`')
    expect(registered[0]?.code).not.toMatch(/^## /m)
  })
})

describe('the codemode description source', () => {
  test('Proves C2: a stand-in source with an extra argument shows up in the description', () => {
    const specs = {
      Grep: {
        sandboxDescription: 'Searches.',
        summary: 'Searches.',
        resolves: 'the matches',
        args: {
          pattern: { type: 'string', isRequired: true },
          glob: { type: 'string', isRequired: false, note: 'file filter' },
        },
      },
    } as const
    const description = codeDescription([], toolDocs(specs, ['Grep']))
    expect(description).toContain('`tools.Grep(args)` takes `pattern`, optional `glob` (file filter), and resolves to the matches.')
  })
})

describe('the codemode guideline', () => {
  test('Proves C2: it follows engine sections that are all shared', async ($, on) => {
    const engine = [engineSection('intro', 'shared'), engineSection('tools', 'shared')]
    standInPrompt(on, engine)
    const { sections } = await composeFor($, [CODEMODE])
    expect(sections.slice(0, 2)).toEqual(engine)
    expect(sections).toHaveLength(3)
    expect(sections[2]).toEqual({ id: GUIDELINE_ID, text: GUIDELINE, scope: 'session' })
    expect(GUIDELINE).toBe(
      'Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.',
    )
  })

  test('Proves C2: it follows engine sections that already end in session ones', async ($, on) => {
    const engine = [engineSection('intro', 'shared'), engineSection('env', 'session'), engineSection('memory', 'session')]
    standInPrompt(on, engine)
    const { sections } = await composeFor($, [CODEMODE])
    expect(sections.map(section => section.id)).toEqual(['intro', 'env', 'memory', GUIDELINE_ID])
    expect(sections.slice(0, 3)).toEqual(engine)
  })

  test('Proves C2: nothing is appended when the request lacks the codemode tool', async ($, on) => {
    const engine = [engineSection('intro', 'shared'), engineSection('env', 'session')]
    standInPrompt(on, engine)
    const { sections } = await composeFor($, ['Read', 'Bash'])
    expect(sections).toEqual(engine)
  })
})

const SECTION = 'Nested calls before the failure:'
const failedDone = (error: string, output = ''): string => line({ type: 'done', ok: false, error, output })
const echoCall = (id: number, text: string): string => call(id, 'Bash', { command: `echo ${text}` })
const echoLine = (id: number, text: string): string => `#${id} Bash {"command":"echo ${text}"} — done: ${text}`

function standInFailingEdit(on: On, text: string): void {
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'unused', isError: true, text }))
}

describe('a failed run lists the nested calls that already ran', () => {
  const edit = { file_path: '/work/a.txt', old_string: 'a', new_string: 'b' }

  test('Proves C1: three done and a fourth failed are listed in call order after the error and the output', async ($, on) => {
    standInFailingEdit(on, 'disk full\nsecond line')
    standIn(on, {
      pieces: [
        listening,
        echoCall(1, 'one'),
        echoCall(2, 'two'),
        echoCall(3, 'three'),
        call(4, 'Edit', edit),
        { waitForPosts: 4 },
        failedDone('boom', 'partial'),
      ],
    })
    const reply = await callCodemode($)
    expect(reply.deny).toBe(
      [
        'boom',
        '',
        'Output before the failure:',
        'partial',
        '',
        SECTION,
        echoLine(1, 'one'),
        echoLine(2, 'two'),
        echoLine(3, 'three'),
        `#4 Edit ${JSON.stringify(edit)} — failed: disk full`,
      ].join('\n'),
    )
  })

  test('Proves C1: a denied call shows denied with its reason', async ($, on) => {
    denyEchoDenied(on)
    standIn(on, { pieces: [listening, echoCall(1, 'denied'), { waitForPosts: 1 }, failedDone('boom')] })
    const reply = await callCodemode($)
    expect(reply.deny).toBe(
      `boom\n\n${SECTION}\n#1 Bash {"command":"echo denied"} — denied: Bash(echo denied) is denied by a permission rule`,
    )
  })

  test('Proves C1: the arguments are cut to 80 characters and the detail to 120, both with an ellipsis', async ($, on) => {
    const long = 'x'.repeat(300)
    standIn(on, { pieces: [listening, echoCall(1, long), { waitForPosts: 1 }, failedDone('boom')] })
    const reply = await callCodemode($)
    const args = JSON.stringify({ command: `echo ${long}` })
    const entry = `#1 Bash ${args.slice(0, 79)}… — done: ${'x'.repeat(119)}…`
    expect(reply.deny).toBe(`boom\n\n${SECTION}\n${entry}`)
  })

  test('Proves C1: a failed run with no nested call has no section', async ($, on) => {
    standIn(on, { pieces: [listening, failedDone('boom', 'partial')] })
    const reply = await callCodemode($)
    expect(reply.deny).toBe('boom\n\nOutput before the failure:\npartial')
  })

  test('Proves C1: a call that has not answered renders as unknown with no answer, next to a done call', () => {
    const ledger = new CallLedger()
    ledger.begin({ type: 'call', id: 1, tool: 'Read', input: { file_path: '/a' } })
    ledger.begin({ type: 'call', id: 2, tool: 'Bash', input: { command: 'ls' } })
    ledger.settle(2, { answer: { id: 2, ok: true, text: '\u001b[31mred\u001b[0m\nsecond' }, state: 'done' })
    expect(ledger.render()).toBe(
      `${SECTION}\n#1 Read {"file_path":"/a"} — unknown: no answer (it may have taken effect; check before redoing it)\n#2 Bash {"command":"ls"} — done: red`,
    )
  })

  test('Proves C2: exactly the call limit are all listed with no omission line', async ($, on) => {
    standIn(on, {
      pieces: [listening, ...Array.from({ length: CALL_LIMIT }, (_, i) => echoCall(i + 1, 'n')), { waitForPosts: CALL_LIMIT }, failedDone('boom')],
    })
    const reply = await callCodemode($)
    expect(reply.deny).toContain(`${SECTION}\n${echoLine(1, 'n')}`)
    expect(reply.deny).toContain(echoLine(CALL_LIMIT, 'n'))
    expect(reply.deny).not.toContain('left out')
  })

  test('Proves C2: one call past the limit leaves the first out and says so', async ($, on) => {
    const total = CALL_LIMIT + 1
    standIn(on, {
      pieces: [listening, ...Array.from({ length: total }, (_, i) => echoCall(i + 1, 'n')), { waitForPosts: total }, failedDone('boom')],
    })
    const reply = await callCodemode($)
    expect(reply.deny).toContain(`${SECTION}\n(1 earlier call left out)\n${echoLine(2, 'n')}`)
    expect(reply.deny).not.toContain(`\n${echoLine(1, 'n')}`)
    expect(reply.deny).toContain(echoLine(total, 'n'))
  })

  test('Proves C2: five calls past the limit are counted in the plural', async ($, on) => {
    const total = CALL_LIMIT + 5
    standIn(on, {
      pieces: [listening, ...Array.from({ length: total }, (_, i) => echoCall(i + 1, 'n')), { waitForPosts: total }, failedDone('boom')],
    })
    const reply = await callCodemode($)
    expect(reply.deny).toContain(`${SECTION}\n(5 earlier calls left out)\n${echoLine(6, 'n')}`)
  })

  test('Proves C3: a malformed line after an answered call carries the section after its text', async ($, on) => {
    standIn(on, { pieces: [listening, echoCall(1, 'a'), { waitForPosts: 1 }, 'this is not json\n'] })
    const reply = await callCodemode($)
    expect(reply.deny).toContain('malformed line: this is not json')
    expect(reply.deny).toMatch(/this is not json\n\nNested calls before the failure:\n#1 Bash/)
    expect(reply.deny?.endsWith(echoLine(1, 'a'))).toBe(true)
  })

  test('Proves C3: a child that exits non-zero after an answered call carries the section after its stderr', async ($, on) => {
    standIn(on, { pieces: [listening, echoCall(1, 'a'), { waitForPosts: 1 }], exit: 3, stderr: 'node: crashed' })
    const reply = await callCodemode($)
    expect(reply.deny).toBe(`the codemode child exited with code 3 without a closing line\nnode: crashed\n\n${SECTION}\n${echoLine(1, 'a')}`)
  })

  test('Proves C3: a stream that ends without a closing line after an answered call carries the section', async ($, on) => {
    standIn(on, { pieces: [listening, echoCall(1, 'a'), { waitForPosts: 1 }] })
    const reply = await callCodemode($)
    expect(reply.deny).toBe(`the codemode child exited with code 0 without a closing line\n\n${SECTION}\n${echoLine(1, 'a')}`)
  })

  test('Proves C3: a successful run has no section', async ($, on) => {
    standIn(on, { pieces: SCRIPT_WITH_READ_AND_BASH })
    const reply = await callCodemode($)
    expect(reply).toEqual({ result: 'FIXTURE-CONTENT\ncodemode-ok' })
  })

  test('Proves C3: a state that cannot be published still lists every call', async ($, on) => {
    on('state.get', () => {
      throw new Error('the state is gone')
    })
    on('state.set', () => {
      throw new Error('the state is gone')
    })
    mock.clock(on, { now: 1_000 })
    standIn(on, { pieces: [listening, echoCall(1, 'a'), echoCall(2, 'b'), { waitForPosts: 2 }, failedDone('boom')] })
    const reply = await callCodemode($)
    expect(reply.deny).toBe(`boom\n\n${SECTION}\n${echoLine(1, 'a')}\n${echoLine(2, 'b')}`)
  })
})

describe('the codemode description on a failed run', () => {
  test('Proves C4: it says a failed run lists the calls that ran and how a script with writes fails safely', () => {
    const text = describeCodemode()
    expect(text).toContain('A failed run lists the nested calls that already ran, so a retry redoes only what did not.')
    expect(text).toContain('prints each step as it completes')
    expect(text).toContain("catches each item's failure apart")
    expect(text).toContain('passes an idempotency key when a tool takes one')
  })
})

const MAY_HAVE_RUN = '(it may have taken effect; check before redoing it)'

function standInThrowingEdit(on: On, thrown: unknown): void {
  on('tool.call', { tool: 'Edit' }, () => {
    throw thrown
  })
}

describe('a failed run tells a failed call from one with an unknown outcome', () => {
  const edit = { file_path: '/work/a.txt', old_string: 'a', new_string: 'b' }
  const editLine = (state: string): string => `#2 Edit ${JSON.stringify(edit)} — ${state}`
  const failedRun = [listening, echoCall(1, 'one'), call(2, 'Edit', edit), { waitForPosts: 2 }, failedDone('boom')]

  test('Proves C1: a call whose tool returned an error result stays failed', async ($, on) => {
    standInFailingEdit(on, 'disk full')
    standIn(on, { pieces: failedRun })
    const reply = await callCodemode($)
    expect(reply.deny).toBe(`boom\n\n${SECTION}\n${echoLine(1, 'one')}\n${editLine('failed: disk full')}`)
  })

  test('Proves C1: a call whose tool threw is unknown in the run, with the engine message', async ($, on) => {
    standInThrowingEdit(on, new Error('connection reset'))
    standIn(on, { pieces: failedRun })
    const reply = await callCodemode($)
    expect(reply.deny).toBe(
      `boom\n\n${SECTION}\n${echoLine(1, 'one')}\n${editLine(`unknown: no implementation for tool.call ${MAY_HAVE_RUN}`)}`,
    )
  })

  test('Proves C1: a thrown Error is unknown with its message', () => {
    expect(thrownOutcome(7, new Error('connection reset'))).toEqual({
      answer: { id: 7, ok: false, error: 'connection reset' },
      state: 'failed',
      reason: 'connection reset',
      unknown: true,
    })
  })

  test('Proves C1: a thrown non-Error value is unknown with its string', () => {
    expect(thrownOutcome(7, 'socket closed')).toEqual({
      answer: { id: 7, ok: false, error: 'socket closed' },
      state: 'failed',
      reason: 'socket closed',
      unknown: true,
    })
  })

  test('Proves C1: a call with no answer is unknown with no answer', () => {
    const ledger = new CallLedger()
    ledger.begin({ type: 'call', id: 1, tool: 'Read', input: { file_path: '/a' } })
    expect(ledger.render()).toBe(`${SECTION}\n#1 Read {"file_path":"/a"} — unknown: no answer ${MAY_HAVE_RUN}`)
  })

  test('Proves C1: a call settled unknown with no reason still carries the warning', () => {
    const ledger = new CallLedger()
    ledger.begin({ type: 'call', id: 1, tool: 'Read', input: {} })
    ledger.settle(1, { answer: { id: 1, ok: false, error: '' }, state: 'failed', reason: '', unknown: true })
    expect(ledger.render()).toBe(`${SECTION}\n#1 Read {} — unknown ${MAY_HAVE_RUN}`)
  })

  test('Proves C1: a denied call is denied and a done call is done, unchanged', async ($, on) => {
    denyEchoDenied(on)
    standIn(on, { pieces: [listening, echoCall(1, 'denied'), echoCall(2, 'ok'), { waitForPosts: 2 }, failedDone('boom')] })
    const reply = await callCodemode($)
    expect(reply.deny).toContain('#1 Bash {"command":"echo denied"} — denied: Bash(echo denied) is denied by a permission rule')
  })

  test('Proves C1: a run mixing done, failed and unknown keeps call-id order', () => {
    const ledger = new CallLedger()
    for (const id of [1, 2, 3, 4]) ledger.begin({ type: 'call', id, tool: 'T', input: {} })
    ledger.settle(3, { answer: { id: 3, ok: false, error: 'x' }, state: 'failed', reason: 'x', unknown: true })
    ledger.settle(1, { answer: { id: 1, ok: true, text: 'a' }, state: 'done' })
    ledger.settle(2, { answer: { id: 2, ok: false, error: 'bad' }, state: 'failed', reason: 'bad' })
    expect(ledger.render()).toBe(
      [
        SECTION,
        '#1 T {} — done: a',
        '#2 T {} — failed: bad',
        `#3 T {} — unknown: x ${MAY_HAVE_RUN}`,
        `#4 T {} — unknown: no answer ${MAY_HAVE_RUN}`,
      ].join('\n'),
    )
  })

  test('Proves C1: the transcript state of a thrown call stays failed and the answer to the script is unchanged', async ($, on) => {
    const stored = standInState(on)
    mock.clock(on, { now: 1_000 })
    standInThrowingEdit(on, new Error('connection reset'))
    const stand = standIn(on, { pieces: [listening, call(1, 'Edit', edit), { waitForPosts: 1 }, done('caught')] })
    const reply = await callCodemode($)
    expect(reply).toEqual({ result: 'caught' })
    expect(stand.posts[0]?.body).toEqual({ id: 1, ok: false, error: 'no implementation for tool.call' })
    const runs = stored() as { calls: { state: string; reason?: string }[] }[]
    expect(runs[0]?.calls.map(row => [row.state, row.reason])).toEqual([['failed', 'no implementation for tool.call']])
  })
})

describe('a done nested call with an empty answer', () => {
  test('Proves N1: it renders as done with no trailing colon', () => {
    const ledger = new CallLedger()
    ledger.begin({ type: 'call', id: 1, tool: 'Bash', input: { command: 'true' } })
    ledger.settle(1, { answer: { id: 1, ok: true, text: '' }, state: 'done' })
    expect(ledger.render()).toBe(`${SECTION}\n#1 Bash {"command":"true"} — done`)
  })
})

describe('the codemode description on an unknown outcome', () => {
  test('Proves C2: it says a call marked unknown may have taken effect, so the script reads the current state first', () => {
    expect(describeCodemode()).toContain(
      'A call marked unknown may have taken effect: read the current state before redoing it.',
    )
  })
})

describe('a done nested call whose tool ran read-only', () => {
  const settleDone = (text: string, readOnly: boolean): string => {
    const ledger = new CallLedger()
    ledger.begin({ type: 'call', id: 1, tool: 'Read', input: { file_path: '/a' } })
    ledger.settle(1, { answer: { id: 1, ok: true, text }, state: 'done', ...(readOnly ? { readOnly: true as const } : {}) })
    return ledger.render()
  }

  test('Proves C1: an empty answer renders as done (read-only)', () => {
    expect(settleDone('', true)).toBe(`${SECTION}\n#1 Read {"file_path":"/a"} — done (read-only)`)
  })

  test('Proves C1: an answer renders the first line after the mark', () => {
    expect(settleDone('first\nsecond', true)).toBe(`${SECTION}\n#1 Read {"file_path":"/a"} — done (read-only): first`)
  })

  test('Proves C1: a done call without the mark renders as before', () => {
    expect(settleDone('first', false)).toBe(`${SECTION}\n#1 Read {"file_path":"/a"} — done: first`)
  })

  test('Proves C1: a failed call never carries the mark', () => {
    const ledger = new CallLedger()
    ledger.begin({ type: 'call', id: 1, tool: 'Read', input: {} })
    ledger.settle(1, { answer: { id: 1, ok: false, error: 'bad' }, state: 'failed', reason: 'bad', readOnly: true })
    expect(ledger.render()).toBe(`${SECTION}\n#1 Read {} — failed: bad`)
  })

  test('Proves C1: an unknown call that is also read-only renders as unknown with no mark', () => {
    const ledger = new CallLedger()
    ledger.begin({ type: 'call', id: 1, tool: 'Read', input: {} })
    ledger.settle(1, { answer: { id: 1, ok: true, text: 'late' }, state: 'done', unknown: true, readOnly: true })
    const text = ledger.render()
    expect(text).toContain('#1 Read {} — unknown: late (it may have taken effect; check before redoing it)')
    expect(text).not.toContain('(read-only)')
  })

  test('Proves C1: a call begun and never settled renders as unknown with no mark', () => {
    const ledger = new CallLedger()
    ledger.begin({ type: 'call', id: 1, tool: 'Read', input: {} })
    const text = ledger.render()
    expect(text).toContain('#1 Read {} — unknown: no answer (it may have taken effect; check before redoing it)')
    expect(text).not.toContain('(read-only)')
  })

  test('Proves C1: through execute the mark shows in the ledger and the transcript state stays done', async () => {
    let runs: CodemodeRun[] = []
    const posted: number[] = []
    let release = (): void => {}
    const bothPosted = new Promise<void>(resolve => {
      release = resolve
    })
    const host = {
      pluginRoot: '/plugin',
      spawn: async function* () {
        yield { stream: 'stdout' as const, text: listening }
        yield { stream: 'stdout' as const, text: call(1, 'Read', { file_path: '/a' }) }
        yield { stream: 'stdout' as const, text: call(2, 'Edit', { file_path: '/a', old_string: 'a', new_string: 'b' }) }
        await bothPosted
        yield { stream: 'stdout' as const, text: failedDone('boom') }
        return { code: 0, signal: null }
      },
      callTool: async (input: { tool: string }) =>
        input.tool === 'Read'
          ? { result: 'unused', text: 'listing', isReadOnly: true as const }
          : { result: 'unused', isError: true as const, text: 'disk full', isReadOnly: true as const },
      listTools: async () => [],
      post: async (_url: string, init: { body?: string }) => {
        posted.push((JSON.parse(init.body ?? '{}') as { id: number }).id)
        if (posted.length === 2) release()
        return { status: 204, ok: true, headers: {}, text: '' }
      },
      publish: async (change: (current: CodemodeRun[]) => CodemodeRun[]) => {
        runs = change(runs)
      },
      now: async () => 1_000,
    }
    const outcome = await new CodemodeBridge(host as never, 1_000).run('the script', 'run-1')
    expect(outcome.ok).toBe(false)
    const error = outcome.ok ? '' : outcome.error
    expect(error).toContain('#1 Read {"file_path":"/a"} — done (read-only): listing')
    expect(error).toContain('— failed: disk full')
    expect(runs[0]?.calls.map(row => row.state)).toEqual(['done', 'failed'])
  })
})
