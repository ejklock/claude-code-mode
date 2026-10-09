import { atom, update } from 'claude-code'
import type { Register, ToolInfo } from 'claude-code'

import { CodemodeBridge } from './bridge.ts'
import { BASH_NOTE, GUIDELINE, codeDescription, describeCodemode } from './describe.ts'
import { exposureSync, registerExposure, withoutHidden } from './expose.ts'
import { readExposure } from './exposure.ts'
import { registerRender } from './render.tsx'
import { CODEMODE_TOOL_ID } from '../shared/protocol.ts'

// The state scan reads the reference from this file, so render.tsx spells its
// own; an invariant spec fails when the two differ.
const RUNS = atom({ plugin: 'codemode', key: 'runs' } as const, [])

const TOOL_NAME = 'codemode'
const SCRIPT_TIMEOUT_MS = 120_000

const TOOL_ID = CODEMODE_TOOL_ID

/** The `code` property's description carries the tool sections, which the engine sends whole. */
const inputSchemaWith = (codeText: string) => ({
  type: 'object',
  properties: { code: { type: 'string', description: codeText } },
  required: ['code'],
})

type ListTools = () => Promise<ToolInfo[]>

/** The `code` description for the tools connected now; `undefined` when the list cannot be read. */
async function readCodeText(list: ListTools): Promise<string | undefined> {
  try {
    const tools = await list()
    const mcp = tools.filter(tool => tool.mcp && tool.name !== TOOL_ID)
    return codeDescription(mcp.map(({ name, description }) => ({ name, description })))
  } catch {
    return undefined
  }
}

export const register: Register = (on, options) => {
  // Read first so a bad setting fails the load.
  const exposure = readExposure(options)
  registerRender(on, options)
  registerExposure(on, exposure)
  const syncExposure = exposureSync(exposure)
  const visibleTools = async (list: ListTools): Promise<ToolInfo[]> => withoutHidden(exposure, await list())
  // Lost on a hot reload, which costs one more registration of the same text.
  let registeredText: string | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const codeText = (await readCodeText(() => visibleTools(() => $.tool.list()))) ?? codeDescription()
    await $.tool.register({ name: TOOL_NAME, description: describeCodemode(), inputSchema: inputSchemaWith(codeText) })
    registeredText = codeText
    return started
  })

  // MCP servers may connect or change after the session starts; the prompt cache
  // is spent only when the rendered sections differ from the last registered.
  on('turn.start', async ($, e, next) => {
    await syncExposure({ tool: { list: () => $.tool.list() }, ui: { invalidate: event => $.ui.invalidate(event) } })
    const codeText = await readCodeText(() => visibleTools(() => $.tool.list()))
    if (codeText !== undefined && codeText !== registeredText) {
      await $.tool.register({ name: TOOL_NAME, description: describeCodemode(), inputSchema: inputSchemaWith(codeText) })
      registeredText = codeText
    }
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('tool.describe', { tool: TOOL_ID }, () => ({ description: describeCodemode(), isDeferred: false })).catch(
    (_$, e, next) => next(e),
  )

  on('tool.describe', { tool: 'Bash' }, async (_$, e, next) => {
    const answer = await next(e)
    if (answer.description.endsWith(BASH_NOTE)) return answer
    return { ...answer, description: `${answer.description}\n\n${BASH_NOTE}` }
  }).catch((_$, e, next) => next(e))

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
        listTools: () => visibleTools(() => $.tool.list()),
        post: (url, init) => $.http.fetch(url, init),
        publish: async change => {
          await update($, RUNS, change)
        },
        now: () => $.clock.now(),
        sleep: ms => $.clock.sleep(ms),
      },
      SCRIPT_TIMEOUT_MS,
    )
    const outcome = await bridge.run(e.code, e.tool_use_id)
    return outcome.ok ? { result: outcome.output } : { deny: outcome.error }
  }).catch((_$, _e, next) => ({
    deny: `codemode failed unexpectedly: ${next.error.message ?? next.error.kind}`,
  }))
}
