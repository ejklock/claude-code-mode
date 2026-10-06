import { atom, update } from 'claude-code'
import type { Register } from 'claude-code'

import { CodemodeBridge } from './bridge.ts'
import { registerRender } from './render.tsx'

// The state scan reads the reference from this file, so render.tsx spells its
// own; an invariant spec fails when the two differ.
const RUNS = atom({ plugin: 'codemode', key: 'runs' } as const, [])

const TOOL_NAME = 'codemode'
const SCRIPT_TIMEOUT_MS = 120_000

const DESCRIPTION = [
  'Runs a JavaScript script that calls the session\'s tools, and returns only what the script prints.',
  'The script is the body of an async function: `await` and `return` work at the top level.',
  'Call tools as `await tools.Read({ file_path })` and `await tools.Bash({ command })`; each resolves to the tool\'s text.',
  'No other tool is available. A refused or failed call throws an Error inside the script; catch it to continue.',
  'Print with `text(value)` or `console.log(value)`: only that output comes back, so filter and combine results in the script.',
].join('\n')

const INPUT_SCHEMA = {
  type: 'object',
  properties: { code: { type: 'string', description: 'The script to run.' } },
  required: ['code'],
}

export const register: Register = (on, options) => {
  registerRender(on, options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({ name: TOOL_NAME, description: DESCRIPTION, inputSchema: INPUT_SCHEMA })
    return started
  })

  on('tool.call', { tool: `mcp__codemode__${TOOL_NAME}` }, async ($, e) => {
    if (typeof e.code !== 'string') return { deny: 'codemode needs a `code` string.' }
    const bridge = new CodemodeBridge(
      {
        pluginRoot: $.plugin.root,
        spawn: request => $.process.spawn(request),
        callTool: input => $.tool.call(input),
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
