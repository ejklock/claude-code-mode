import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CALL_LIMIT, RUN_LIMIT } from '../hooks/bridge.ts'
import type { CodemodeCall, CodemodeRun } from '../types/index.d.ts'

const CODEMODE = 'mcp__codemode__codemode'
const SOCKET = '/tmp/stand-in/bridge.sock'
const SURFACES = ['terminal', 'desktop'] as const

const line = (message: Record<string, unknown>): string => `${JSON.stringify(message)}\n`
const listening = line({ type: 'listening', socketPath: SOCKET })
const call = (id: number, tool: string, input: Record<string, unknown>): string =>
  line({ type: 'call', id, tool, input })
const done = (output: string): string => line({ type: 'done', ok: true, output })

type Piece = string | { waitForPosts: number }

/** A promise a test settles by hand, to hold a nested call in flight. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open = (): void => {}
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  return { opened, open }
}

/** Stands in for the child process and its answer socket; the kit runs neither. */
function child(on: On, pieces: Piece[]): void {
  let posts = 0
  const waiters: { count: number; release: () => void }[] = []
  on('http.fetch', () => {
    posts += 1
    for (const waiter of waiters) if (posts >= waiter.count) waiter.release()
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  on('process.spawn', async function* () {
    for (const piece of pieces) {
      if (typeof piece === 'string') yield { stream: 'stdout' as const, text: piece }
      else if (posts < piece.waitForPosts) {
        await new Promise<void>(release => waiters.push({ count: piece.waitForPosts, release }))
      }
    }
    return { value: { code: 0, signal: null } }
  })
}

type Host = {
  runs: () => CodemodeRun[]
  seed: (runs: CodemodeRun[]) => void
  clock: ReturnType<typeof mock.clock>
}

/**
 * What sits beneath the plugin in a session: the host's `$.state` (a version
 * per value, compare-and-set writes), its clock, and the engine's own drawing
 * of a row.
 */
function host(on: On): Host {
  const held = new Map<string, { value: unknown; version: number }>()
  const slot = (e: { plugin: string; key: string; id?: string }): string => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('state.get', (_$, e) => ({ value: held.get(slot(e)) ?? { value: undefined, version: 0 } }))
  on('state.set', (_$, e) => {
    const current = held.get(slot(e)) ?? { value: undefined, version: 0 }
    if (e.ifVersion !== undefined && e.ifVersion !== current.version) {
      return { value: { isSet: false as const, version: current.version } }
    }
    held.set(slot(e), { value: e.value, version: current.version + 1 })
    return { value: { isSet: true as const, version: current.version + 1 } }
  })
  on('ui.render', (_$, e) => ({ type: 'Text', children: [`ENGINE-DRAWN ${e.component}`] }))
  return {
    runs: () => (held.get('codemode/runs/')?.value ?? []) as CodemodeRun[],
    seed: runs => held.set('codemode/runs/', { value: runs, version: 1 }),
    clock: mock.clock(on, { now: 1_000 }),
  }
}

const runCodemode = ($: Engine) => $.tool.call({ tool: CODEMODE, code: 'the script' })

function runId(stand: Host): string {
  const id = stand.runs()[0]?.id
  if (id === undefined) throw new Error('no run was published')
  return id
}

function toolRow(id: string, tool: string, input: unknown) {
  return {
    tool_use_id: id,
    tool,
    input,
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  }
}

const SCRIPT = 'const a = await tools.Read({ file_path: "a.txt" })\ntext(a.length)\n'

describe('the codemode row draws the script', () => {
  const scripts: [string, string][] = [
    ['a multi-line script', SCRIPT],
    ['quotes and backslashes', 'text("say \\"hi\\" \\\\ C:\\\\dir\\n" + \'it\\\'s\')\n// \\n stays two characters'],
  ]

  for (const [name, script] of scripts) {
    test(`Proves C1: ${name} is one Code element holding the source unescaped`, async ($, on) => {
      host(on)
      for (const surface of SURFACES) {
        const ui = await $.ui.mount({
          plugin: 'codemode',
          surface,
          component: 'ToolUse',
          props: toolRow('toolu_c1', CODEMODE, { code: script }),
          requestId: 'toolu_c1',
        })
        const code = await ui.find({ type: 'Code' })
        expect(code?.props.language).toBe('javascript')
        expect(code?.props.source).toBe(script)
        expect(await ui.find({ text: 'ENGINE-DRAWN' })).toBeUndefined()
      }
    })
  }

  const layout = async (ui: { find: (q: { key: string }) => Promise<{ children: unknown[] } | undefined> }) =>
    ((await ui.find({ key: 'codemode-row' }))?.children ?? []).map(child =>
      typeof child === 'string' ? child : (child as { type: string }).type,
    )

  test('Proves C1: the row is one round box holding the title and the script, with no divider before a call', async ($, on) => {
    host(on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'codemode',
        surface,
        component: 'ToolUse',
        props: { ...toolRow('toolu_box', CODEMODE, { code: SCRIPT }), isRunning: true },
        requestId: 'toolu_box',
      })
      const box = await ui.find({ key: 'codemode-row' })
      expect(box?.type).toBe('Box')
      expect(box?.props.borderStyle).toBe('round')
      expect(box?.props.borderDimColor).toBe(true)
      expect(box?.props.alignSelf).toBe('flex-start')
      expect(await layout(ui)).toEqual(['Box', 'Code'])
      expect((await ui.find({ key: 'title' }))?.text).toBe('codemode · script')
    }
  })

  test('Proves C1: three calls follow the script after one divider, in order, and a long path is shortened', async ($, on) => {
    const stand = host(on)
    const long = '/Users/someone/projects/application/src/deep/file.ts'
    on('tool.call', { tool: 'Read' }, () => ({ result: 'unused', text: 'r' }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'unused', text: 'b' }))
    child(on, [
      listening,
      call(1, 'Read', { file_path: long }),
      { waitForPosts: 1 },
      call(2, 'Bash', { command: 'pwd' }),
      { waitForPosts: 2 },
      call(3, 'Bash', { command: 'ls' }),
      { waitForPosts: 3 },
      done('ok'),
    ])
    await runCodemode($)
    const id = runId(stand)
    expect(stand.runs()[0]?.calls[0]?.label).toBe(long)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'codemode',
        surface,
        component: 'ToolUse',
        props: toolRow(id, CODEMODE, { code: SCRIPT }),
        requestId: id,
      })
      expect(await layout(ui)).toEqual(['Box', 'Code', 'Box', 'Box', 'Box', 'Box'])
      expect((await ui.find({ key: 'codemode-row' }))?.props.borderDimColor).toBe(true)
      expect((await ui.find({ key: 'divider' }))?.text).toMatch(/^─+$/)
      const first = (await ui.find({ key: 'call-1' }))?.text
      expect(first).toContain('…/deep/file.ts')
      expect(first).not.toContain('/Users/someone')
    }
  })

  test('Proves C1: an input with no code string keeps the engine drawing', async ($, on) => {
    host(on)
    for (const surface of SURFACES) {
      for (const [n, input] of [{}, { code: 42 }, null].entries()) {
        const ui = await $.ui.mount({
          plugin: 'codemode',
          surface,
          component: 'ToolUse',
          props: toolRow(`toolu_c1b_${n}`, CODEMODE, input),
          requestId: `toolu_c1b_${n}`,
        })
        expect(await ui.find({ type: 'Code' })).toBeUndefined()
        expect(await ui.find({ text: 'ENGINE-DRAWN ToolUse' })).toBeDefined()
      }
    }
  })
})

describe('the live call list', () => {
  async function rowOnBoth($: Engine, id: string, isRunning: boolean) {
    return Promise.all(
      SURFACES.map(surface =>
        $.ui.mount({
          plugin: 'codemode',
          surface,
          component: 'ToolUse',
          props: { ...toolRow(id, CODEMODE, { code: SCRIPT }), isRunning },
          requestId: id,
        }),
      ),
    )
  }

  test('Proves C2: a Read shows running while it runs and done with a duration after', async ($, on) => {
    const stand = host(on)
    const entered = gate()
    const release = gate()
    on('tool.call', { tool: 'Read' }, async () => {
      entered.open()
      await release.opened
      return { result: 'unused', text: 'FIXTURE-CONTENT' }
    })
    child(on, [listening, call(1, 'Read', { file_path: '/work/README.md' }), { waitForPosts: 1 }, done('ok')])

    const finished = runCodemode($)
    await entered.opened
    const id = runId(stand)
    for (const ui of await rowOnBoth($, id, true)) {
      const row = await ui.find({ key: 'call-1' })
      expect(row?.text).toContain('Read')
      expect(row?.text).toContain('/work/README.md')
      expect(row?.text?.startsWith('…')).toBe(true)
      expect(row?.text).not.toMatch(/\d+ (ms|s)$/)
      await ui.unmount()
    }

    await stand.clock.advance(12)
    release.open()
    await finished
    for (const ui of await rowOnBoth($, id, false)) {
      const row = await ui.find({ key: 'call-1' })
      expect(row?.text).toContain('✓')
      expect(row?.text?.trimEnd().endsWith('12 ms')).toBe(true)
    }
  })

  test('Proves C2: a denied Bash shows denied with its reason', async ($, on) => {
    const stand = host(on)
    on('classic.PreToolUse', (_$, e, next) =>
      e.tool === 'Bash' ? { deny: 'Bash(echo denied) is denied by a permission rule' } : next(e),
    )
    child(on, [listening, call(1, 'Bash', { command: 'echo denied' }), { waitForPosts: 1 }, done('caught')])
    await runCodemode($)
    for (const ui of await rowOnBoth($, runId(stand), false)) {
      const row = await ui.find({ key: 'call-1' })
      expect(row?.text).toContain('✗')
      expect(row?.text).toContain('echo denied')
      expect(row?.text?.trimEnd().endsWith('denied')).toBe(true)
      expect(row?.text).not.toContain('permission rule')
    }
  })

  test('Proves C2: a failed call shows failed with its error', async ($, on) => {
    const stand = host(on)
    on('tool.call', { tool: 'Read' }, () => ({ result: 'unused', isError: true, text: 'ENOENT: no such file' }))
    child(on, [listening, call(1, 'Read', { file_path: '/missing' }), { waitForPosts: 1 }, done('caught')])
    await runCodemode($)
    for (const ui of await rowOnBoth($, runId(stand), false)) {
      const row = await ui.find({ key: 'call-1' })
      expect(row?.text).toContain('✗')
      expect(row?.text?.trimEnd().endsWith('failed')).toBe(true)
      expect(row?.text).not.toContain('ENOENT')
    }
  })

  test('Proves C2: two calls in flight at once are both listed', async ($, on) => {
    const stand = host(on)
    const entered = { read: gate(), bash: gate() }
    const release = gate()
    on('tool.call', { tool: 'Read' }, async () => {
      entered.read.open()
      await release.opened
      return { result: 'unused', text: 'r' }
    })
    on('tool.call', { tool: 'Bash' }, async () => {
      entered.bash.open()
      await release.opened
      return { result: 'unused', text: 'b' }
    })
    child(on, [
      listening,
      call(1, 'Read', { file_path: '/a' }),
      call(2, 'Bash', { command: 'git log --oneline -3\nsecond line' }),
      { waitForPosts: 2 },
      done('both'),
    ])

    const finished = runCodemode($)
    await Promise.all([entered.read.opened, entered.bash.opened])
    for (const ui of await rowOnBoth($, runId(stand), true)) {
      const first = await ui.find({ key: 'call-1' })
      const second = await ui.find({ key: 'call-2' })
      expect(first?.text?.startsWith('…')).toBe(true)
      expect(second?.text?.startsWith('…')).toBe(true)
      expect(second?.text).toContain('git log --oneline -3')
      expect(second?.text).not.toContain('second line')
    }
    release.open()
    await finished
  })
})

describe('the finished row', () => {
  const result = (id: string, output: string, isErrored: boolean) => ({
    tool_use_id: id,
    tool: CODEMODE,
    output,
    isErrored,
  })

  test('Proves C3: it shows the call count, the total time and the output', async ($, on) => {
    const stand = host(on)
    on('tool.call', { tool: 'Read' }, async () => {
      await stand.clock.advance(100)
      return { result: 'unused', text: 'r' }
    })
    child(on, [
      listening,
      call(1, 'Read', { file_path: '/a' }),
      { waitForPosts: 1 },
      call(2, 'Read', { file_path: '/b' }),
      { waitForPosts: 2 },
      done('FIXTURE\nOUTPUT'),
    ])
    await runCodemode($)
    const id = runId(stand)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'codemode',
        surface,
        component: 'ToolResult',
        props: result(id, 'FIXTURE\nOUTPUT', false),
        requestId: id,
      })
      const box = await ui.find({ key: 'codemode-result' })
      expect(box?.props.borderStyle).toBe('round')
      expect(box?.props.borderColor).toBe('success')
      const summary = await ui.find({ key: 'summary' })
      expect(summary?.text).toBe('✓ 2 calls · 200 ms')
      expect((await ui.find({ key: 'output' }))?.text).toBe('FIXTURE\nOUTPUT')
    }
  })

  test('Proves C3: an errored call shows its error and no summary', async ($, on) => {
    const stand = host(on)
    child(on, [listening, line({ type: 'done', ok: false, error: 'boom', output: '' })])
    await runCodemode($)
    const id = runId(stand)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'codemode',
        surface,
        component: 'ToolResult',
        props: result(id, 'boom', true),
        requestId: id,
      })
      const box = await ui.find({ key: 'codemode-result' })
      expect(box?.props.borderStyle).toBe('round')
      expect(box?.props.borderColor).toBe('error')
      expect((await ui.find({ key: 'error' }))?.text).toBe('✗ boom')
      expect(await ui.find({ key: 'summary' })).toBeUndefined()
    }
  })
})

const WIDTH_CAP = 100
const FRAME = 4

function seededRun(
  calls: [string, string, CodemodeCall['state'], number][],
  scriptWidth?: number,
): CodemodeRun {
  return {
    id: 'toolu_seed',
    ...(scriptWidth === undefined ? {} : { scriptWidth }),
    startedAt: 0,
    endedAt: 2_000,
    omitted: 0,
    calls: calls.map(([tool, label, state, ms], n) => ({
      id: n + 1,
      tool,
      label,
      state,
      startedAt: 0,
      ...(state === 'running' ? {} : { endedAt: ms }),
    })),
  }
}

describe('the polished layout', () => {
  const mountUse = ($: Engine, surface: (typeof SURFACES)[number], script: string) =>
    $.ui.mount({
      plugin: 'codemode',
      surface,
      component: 'ToolUse',
      props: toolRow('toolu_seed', CODEMODE, { code: script }),
      requestId: 'toolu_seed',
    })

  const resultCases: [string, string, number, boolean, string][] = [
    ['output narrower than the script', 'short', 80, false, 'short'],
    ['output wider than the script', 'o'.repeat(150), 80, false, `${'o'.repeat(79)}…`],
    ['an errored result', 'e'.repeat(150), 80, true, `✗ ${'e'.repeat(77)}…`],
  ]

  for (const [name, output, scriptWidth, isErrored, expected] of resultCases) {
    test(`Proves C2: the result box matches the script box for ${name}`, async ($, on) => {
      host(on).seed([seededRun([['Bash', 'pwd', 'done', 5]], scriptWidth)])
      for (const surface of SURFACES) {
        const use = await mountUse($, surface, 'x'.repeat(scriptWidth))
        const result = await $.ui.mount({
          plugin: 'codemode',
          surface,
          component: 'ToolResult',
          props: { tool_use_id: 'toolu_seed', tool: CODEMODE, output, isErrored },
          requestId: 'toolu_seed',
        })
        const useBox = await use.find({ key: 'codemode-row' })
        const resultBox = await result.find({ key: 'codemode-result' })
        expect(resultBox?.props.width).toBe(useBox?.props.width)
        const text = (await result.find({ key: isErrored ? 'error' : 'output' }))?.text
        expect(text).toBe(expected)
        await use.unmount()
        await result.unmount()
      }
    })
  }

  test('Proves C2: a run absent from the state keeps the result box shrink-wrapped', async ($, on) => {
    host(on)
    for (const surface of SURFACES) {
      const result = await $.ui.mount({
        plugin: 'codemode',
        surface,
        component: 'ToolResult',
        props: { tool_use_id: 'toolu_gone', tool: CODEMODE, output: 'o'.repeat(300), isErrored: false },
        requestId: 'toolu_gone',
      })
      expect((await result.find({ key: 'codemode-result' }))?.props.width).toBeUndefined()
      expect((await result.find({ key: 'output' }))?.text).toBe('o'.repeat(300))
      await result.unmount()
    }
  })

  const cutCases: [string, number, number | undefined, string][] = [
    ['a line exactly at the cap is unchanged', 100, undefined, 'x'.repeat(100)],
    ['a line at the cap plus 1 is cut', 101, undefined, `${'x'.repeat(99)}…`],
    ['a line far wider than the cap is cut', 400, undefined, `${'x'.repeat(99)}…`],
    ['a narrow surface caps at its width minus the frame', 60, 50, `${'x'.repeat(45)}…`],
    ['a wide surface is not capped at 100', 400, 160, `${'x'.repeat(155)}…`],
  ]

  for (const [name, length, columns, expected] of cutCases) {
    test(`Proves C1: ${name}`, async ($, on) => {
      host(on).seed([seededRun([['Bash', 'pwd', 'done', 5]])])
      const line = 'x'.repeat(length)
      for (const surface of SURFACES) {
        const ui = await $.ui.mount({
          plugin: 'codemode',
          surface,
          component: 'ToolUse',
          props: toolRow('toolu_seed', CODEMODE, { code: `${line}\nshort` }),
          requestId: 'toolu_seed',
          ...(columns === undefined ? {} : { viewport: { columns, rows: 40 } }),
        })
        const code = await ui.find({ type: 'Code' })
        expect(code?.props.source).toBe(`${expected}\nshort`)
        expect(code?.props.language).toBe('javascript')
        await ui.unmount()
      }
    })
  }

  test('Proves C3: denied and failed rows draw in the error colour, done and running rows do not', async ($, on) => {
    host(on).seed([
      seededRun([
        ['Bash', 'a', 'done', 5],
        ['Bash', 'b', 'running', 0],
        ['Bash', 'c', 'denied', 5],
        ['Read', 'd', 'failed', 5],
      ]),
    ])
    for (const surface of SURFACES) {
      const ui = await mountUse($, surface, 'text(1)')
      const colours = await Promise.all(
        [1, 2, 3, 4].map(async n => {
          const row = await ui.find({ key: `call-${n}` })
          return (row?.children[1] as { props?: { color?: string } } | undefined)?.props?.color
        }),
      )
      expect(colours).toEqual([undefined, undefined, 'error', 'error'])
      await ui.unmount()
    }
  })

  const fitCases: [string, string, number][] = [
    ['a short script with one call', 'text(1)', 0],
    ['a script whose longest line is longer than any row', `text("${'a'.repeat(52)}")`, 60],
    ['a script wider than the cap', `text("${'b'.repeat(300)}")`, 100],
  ]

  for (const [name, script, expected] of fitCases) {
    test(`Proves C1: the box fits its content for ${name}`, async ($, on) => {
      const stand = host(on)
      stand.seed([seededRun([['Bash', 'pwd', 'done', 1_500]])])
      for (const surface of SURFACES) {
        const ui = await mountUse($, surface, script)
        const box = await ui.find({ key: 'codemode-row' })
        const rowLength = (await ui.find({ key: 'call-1' }))?.text.length ?? 0
        const longest = Math.max(...script.split('\n').map(text => text.length))
        const content = Math.min(WIDTH_CAP, Math.max('codemode · script'.length, longest, rowLength))
        if (expected > 0) expect(content).toBe(expected)
        else expect(content).toBe(Math.max('codemode · script'.length, rowLength))
        expect(box?.props.borderStyle).toBe('round')
        expect(box?.props.borderDimColor).toBe(true)
        expect(box?.props.alignSelf).toBe('flex-start')
        expect(box?.props.width).toBe(content + FRAME)
        const divider = (await ui.find({ key: 'divider' }))?.text
        expect(divider).toBe('─'.repeat(content))
        expect(divider).not.toContain('…')
        await ui.unmount()
      }
    })
  }

  test('Proves C2: rows are aligned columns, a long label is cut with an ellipsis and no row wraps', async ($, on) => {
    const stand = host(on)
    const label = (length: number): string => 'p'.repeat(length)
    stand.seed([
      seededRun([
        ['Bash', label(29), 'done', 12],
        ['Read', label(30), 'done', 1_500],
        ['Bash', label(31), 'done', 48],
        ['Bash', 'sleep 9', 'running', 0],
        ['Bash', 'rm -rf /tmp/x', 'denied', 3],
        ['Read', '/nope', 'failed', 4],
      ]),
    ])
    for (const surface of SURFACES) {
      const ui = await mountUse($, surface, 'text(1)')
      const rows = await Promise.all([1, 2, 3, 4, 5, 6].map(n => ui.find({ key: `call-${n}` })))
      const texts = rows.map(row => row?.text ?? '')
      expect(new Set(texts.map(text => text.length)).size).toBe(1)
      expect(texts[0]).toContain(`${label(29)} `)
      expect(texts[1]).toContain(label(30))
      expect(texts[2]).toContain(`${label(29)}…`)
      expect(texts[2]).not.toContain(label(30))
      expect(texts[0]?.trimEnd().endsWith('12 ms')).toBe(true)
      expect(texts[1]?.trimEnd().endsWith('1.5 s')).toBe(true)
      expect(texts[3]?.trimEnd().endsWith('sleep 9')).toBe(true)
      expect(texts[4]?.endsWith('denied')).toBe(true)
      expect(texts[5]?.endsWith('failed')).toBe(true)
      expect(texts.every(text => !text.includes('\n'))).toBe(true)
      await ui.unmount()
    }
  })

  const summaries: [string, CodemodeRun, string][] = [
    ['all done', seededRun([['Bash', 'a', 'done', 1], ['Read', 'b', 'done', 1]]), '✓ 2 calls · 2.0 s'],
    ['one denied', seededRun([['Bash', 'a', 'done', 1], ['Bash', 'b', 'denied', 1]]), '✓ 2 calls · 2.0 s · 1 denied'],
    [
      'one denied and one failed',
      seededRun([['Bash', 'a', 'denied', 1], ['Read', 'b', 'failed', 1], ['Read', 'c', 'done', 1]]),
      '✓ 3 calls · 2.0 s · 1 denied · 1 failed',
    ],
  ]

  for (const [name, run, expected] of summaries) {
    test(`Proves C3: the summary for ${name}`, async ($, on) => {
      host(on).seed([run])
      for (const surface of SURFACES) {
        const ui = await $.ui.mount({
          plugin: 'codemode',
          surface,
          component: 'ToolResult',
          props: { tool_use_id: 'toolu_seed', tool: CODEMODE, output: 'out', isErrored: false },
          requestId: 'toolu_seed',
        })
        const box = await ui.find({ key: 'codemode-result' })
        expect(box?.props.borderStyle).toBe('round')
        expect(box?.props.borderDimColor).toBe(true)
        expect(box?.props.alignSelf).toBe('flex-start')
        expect((await ui.find({ key: 'summary' }))?.text).toBe(expected)
        await ui.unmount()
      }
    })
  }
})

describe('every other tool and the state bound', () => {
  for (const tool of ['Bash', 'Read']) {
    for (const component of ['ToolUse', 'ToolResult'] as const) {
      test(`Proves C4: a ${tool} ${component} row is left to the engine on both surfaces`, async ($, on) => {
        host(on)
        for (const surface of SURFACES) {
          const props =
            component === 'ToolUse'
              ? toolRow('toolu_c4', tool, { command: 'ls', file_path: '/a' })
              : { tool_use_id: 'toolu_c4', tool, output: { stdout: 'x' }, isErrored: false }
          const ui = await $.ui.mount({ plugin: 'codemode', surface, component, props, requestId: 'toolu_c4' } as never)
          expect(await ui.find({ text: `ENGINE-DRAWN ${component}` })).toBeDefined()
          expect(await ui.find({ type: 'Code' })).toBeUndefined()
        }
      })
    }
  }

  describe('labels published to the state', () => {
    test('Proves C5: an ANSI escape sequence is removed', async ($, on) => {
      const stand = host(on)
      on('tool.call', { tool: 'Bash' }, () => ({ result: 'unused', text: 'b' }))
      child(on, [listening, call(1, 'Bash', { command: '\u001b[31mred\u001b[0m' }), { waitForPosts: 1 }, done('ok')])
      await runCodemode($)
      expect(stand.runs()[0]?.calls[0]?.label).toBe('red')
    })

    test('Proves C5: a tab becomes a space and a NUL goes', async ($, on) => {
      const stand = host(on)
      on('tool.call', { tool: 'Bash' }, () => ({ result: 'unused', text: 'b' }))
      child(on, [listening, call(1, 'Bash', { command: 'a\tb\u0000c' }), { waitForPosts: 1 }, done('ok')])
      await runCodemode($)
      expect(stand.runs()[0]?.calls[0]?.label).toBe('a bc')
    })

    test('Proves C5: a plain command is unchanged', async ($, on) => {
      const stand = host(on)
      on('tool.call', { tool: 'Bash' }, () => ({ result: 'unused', text: 'b' }))
      child(on, [listening, call(1, 'Bash', { command: 'git log --oneline -3' }), { waitForPosts: 1 }, done('ok')])
      await runCodemode($)
      expect(stand.runs()[0]?.calls[0]?.label).toBe('git log --oneline -3')
    })

    test('Proves C5: the bound of 80 characters holds after cleaning', async ($, on) => {
      const stand = host(on)
      on('tool.call', { tool: 'Bash' }, () => ({ result: 'unused', text: 'b' }))
      const command = `\u001b[31m${'x'.repeat(200)}\u001b[0m`
      child(on, [listening, call(1, 'Bash', { command }), { waitForPosts: 1 }, done('ok')])
      await runCodemode($)
      const label = stand.runs()[0]?.calls[0]?.label ?? ''
      expect(label).toBe(`${'x'.repeat(79)}…`)
    })
  })

  test('Proves C4: past the run bound the oldest runs are gone', async ($, on) => {
    const stand = host(on)
    child(on, [listening, done('ok')])
    await runCodemode($)
    const first = runId(stand)
    for (let n = 0; n < RUN_LIMIT; n += 1) await runCodemode($)
    const runs = stand.runs()
    expect(runs).toHaveLength(RUN_LIMIT)
    expect(runs.map(run => run.id)).not.toContain(first)
  })

  test('Proves C4: past the call bound a run keeps its newest calls and counts the rest', async ($, on) => {
    const stand = host(on)
    const total = CALL_LIMIT + 2
    const calls = Array.from({ length: total }, (_, n) => [
      call(n + 1, 'Read', { file_path: `/f${n + 1}` }),
      { waitForPosts: n + 1 },
    ])
    on('tool.call', { tool: 'Read' }, () => ({ result: 'unused', text: 'r' }))
    child(on, [listening, ...calls.flat(), done('ok')])
    await runCodemode($)
    const run = stand.runs()[0]
    expect(run?.calls).toHaveLength(CALL_LIMIT)
    expect(run?.omitted).toBe(2)
    expect(run?.calls[0]?.id).toBe(3)
    expect(run?.calls.at(-1)?.id).toBe(total)
  })
})

describe('a known viewport fills the width the transcript gives', () => {
  const room = (columns: number): number => Math.max(4, columns - FRAME)
  const cutTo = (text: string, width: number): string => (text.length > width ? `${text.slice(0, width - 1)}…` : text)

  const mountBoth = async (
    $: Engine,
    surface: (typeof SURFACES)[number],
    code: string,
    output: string,
    columns: number | undefined,
    isErrored: boolean,
  ) => {
    const viewport = columns === undefined ? {} : { viewport: { columns, rows: 40 } }
    const use = await $.ui.mount({
      plugin: 'codemode',
      surface,
      component: 'ToolUse',
      props: toolRow('toolu_seed', CODEMODE, { code }),
      requestId: 'toolu_seed',
      ...viewport,
    })
    const result = await $.ui.mount({
      plugin: 'codemode',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 'toolu_seed', tool: CODEMODE, output, isErrored },
      requestId: 'toolu_seed',
      ...viewport,
    })
    return { use, result }
  }

  const cases: [string, string, string, number, boolean][] = [
    ['a one-line script and output at 200 columns', 'text(1)', 'ok', 200, false],
    ['a one-line script and output at 80 columns', 'text(1)', 'ok', 80, false],
    ['a 150-character script at 120 columns', 'x'.repeat(150), 'ok', 120, false],
    ['a 150-character output at 120 columns', 'text(1)', 'o'.repeat(150), 120, false],
    ['a 21-column viewport, the title width plus the frame', 'text(1)', 'ok', 21, false],
    ['a 20-column viewport, one under the title width plus the frame', 'text(1)', 'ok', 20, false],
    ['a 22-column viewport, one over the title width plus the frame', 'text(1)', 'ok', 22, false],
    ['an 8-column viewport, which cuts the title', 'text(1)', 'ok', 8, false],
    ['the error variant at 20 columns', 'text(1)', 'e'.repeat(50), 20, true],
    ['the error variant at 90 columns', 'text(1)', 'e'.repeat(150), 90, true],
  ]

  for (const [name, code, output, columns, isErrored] of cases) {
    test(`Proves C1: both boxes take the available width for ${name}`, async ($, on) => {
      host(on).seed([seededRun([['Bash', 'pwd', 'done', 5]])])
      for (const surface of SURFACES) {
        const { use, result } = await mountBoth($, surface, code, output, columns, isErrored)
        const width = room(columns)
        expect((await use.find({ key: 'codemode-row' }))?.props.width).toBe(width + FRAME)
        expect((await result.find({ key: 'codemode-result' }))?.props.width).toBe(width + FRAME)
        expect((await use.find({ key: 'divider' }))?.text).toBe('─'.repeat(width))
        expect((await use.find({ type: 'Code' }))?.props.source).toBe(cutTo(code, width))
        const shown = (await result.find({ key: isErrored ? 'error' : 'output' }))?.text
        expect(shown).toBe(cutTo(isErrored ? `✗ ${output}` : output, width))
        await use.unmount()
        await result.unmount()
      }
    })
  }

  test('Proves C1: the title is cut with the lines when the box is narrower than it', async ($, on) => {
    host(on).seed([seededRun([['Bash', 'pwd', 'done', 5]])])
    for (const surface of SURFACES) {
      const { use, result } = await mountBoth($, surface, 'text(1)', 'ok', 8, false)
      expect((await use.find({ key: 'title' }))?.text).toBe('cod…')
      await use.unmount()
      await result.unmount()
    }
  })

  const wideCases: [string, string, string][] = [
    ['ASCII at the limit stays', 'x'.repeat(10), 'x'.repeat(10)],
    ['ASCII one over is cut', 'x'.repeat(11), `${'x'.repeat(9)}…`],
    ['CJK is cut by columns', '漢'.repeat(8), `${'漢'.repeat(4)}…`],
    ['CJK of exactly the width stays', '漢'.repeat(5), '漢'.repeat(5)],
    ['an emoji straddling the limit is cut before it', `${'a'.repeat(8)}😀😀`, `${'a'.repeat(8)}…`],
    ['a combining mark adds no column', 'é'.repeat(10), 'é'.repeat(10)],
    ['a combining mark does not hide an overflow', 'é'.repeat(11), `${'é'.repeat(9)}…`],
    ['an empty line stays', '', ''],
  ]

  for (const [name, line, expected] of wideCases) {
    test(`Proves C2: the script box and the result box cut by columns, ${name}`, async ($, on) => {
      host(on).seed([seededRun([['Bash', 'pwd', 'done', 5]])])
      for (const surface of SURFACES) {
        const { use, result } = await mountBoth($, surface, line, line, 14, false)
        expect((await use.find({ type: 'Code' }))?.props.source).toBe(expected)
        expect((await result.find({ key: 'output' }))?.text).toBe(expected)
        expect((await result.find({ key: 'output' }))?.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
        await use.unmount()
        await result.unmount()
      }
    })
  }

  test('Proves C2: the error variant cuts by columns after its mark', async ($, on) => {
    host(on).seed([seededRun([['Bash', 'pwd', 'done', 5]])])
    for (const surface of SURFACES) {
      const { use, result } = await mountBoth($, surface, 'x', '漢'.repeat(8), 14, true)
      expect((await result.find({ key: 'error' }))?.text).toBe('✗ 漢漢漢…')
      await use.unmount()
      await result.unmount()
    }
  })

  test('Proves C1: without a viewport the boxes stay content-sized', async ($, on) => {
    host(on).seed([seededRun([['Bash', 'pwd', 'done', 5]], 60)])
    for (const surface of SURFACES) {
      const { use, result } = await mountBoth($, surface, 'x'.repeat(60), 'ok', undefined, false)
      expect((await use.find({ key: 'codemode-row' }))?.props.width).toBe(60 + FRAME)
      expect((await result.find({ key: 'codemode-result' }))?.props.width).toBe(60 + FRAME)
      await use.unmount()
      await result.unmount()
    }
  })
})
