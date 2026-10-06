import { atom, update } from 'claude-code'
import type { Register } from 'claude-code'

import { CodemodeBridge } from './bridge.ts'
import { GUIDELINE, describeCodemode } from './describe.ts'
import { registerRender } from './render.tsx'
import { CODEMODE_TOOL_ID } from '../shared/protocol.ts'

// The state scan reads the reference from this file, so render.tsx spells its
// own; an invariant spec fails when the two differ.
const RUNS = atom({ plugin: 'codemode', key: 'runs' } as const, [])

const TOOL_NAME = 'codemode'
const SCRIPT_TIMEOUT_MS = 120_000

const TOOL_ID = CODEMODE_TOOL_ID

const INPUT_SCHEMA = {
  type: 'object',
  properties: { code: { type: 'string', description: 'The script to run.' } },
  required: ['code'],
}

export const register: Register = (on, options) => {
  registerRender(on, options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({ name: TOOL_NAME, description: describeCodemode(), inputSchema: INPUT_SCHEMA })
    return started
  })

  on('tool.describe', { tool: TOOL_ID }, () => ({ description: describeCodemode(), isDeferred: false })).catch(
    (_$, e, next) => next(e),
  )

  on('prompt.compose', async (_$, e, next) => {
    const { sections } = await next(e)
    if (!e.tools.includes(TOOL_ID)) return { sections }
    return { sections: [...sections, { id: 'codemode:guideline', text: GUIDELINE, scope: 'session' as const }] }
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    if (typeof e.code !== 'string') return { deny: 'codemode needs a `code` string.' }
    const bridge = new CodemodeBridge(
      {
        pluginRoot: $.plugin.root,
        spawn: request => $.process.spawn(request),
        callTool: input => $.tool.call(input),
        listTools: () => $.tool.list(),
        post: (url, init) => $.http.fetch(url, init),
        publish: async change => {
          await update($, RUNS, change)
        },
        now: () => $.clock.now(),
      },
      SCRIPT_TIMEOUT_MS,
    )
    const outcome = await bridge.run(e.code, e.tool_use_id)
    return outcome.ok ? { result: outcome.output } : { deny: outcome.error }
  }).catch((_$, _e, next) => ({
    deny: `codemode failed unexpectedly: ${next.error.message ?? next.error.kind}`,
  }))
}
