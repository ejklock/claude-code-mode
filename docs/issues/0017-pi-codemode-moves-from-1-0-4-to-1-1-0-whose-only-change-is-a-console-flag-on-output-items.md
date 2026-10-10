---
type: Issue
title: pi-codemode moves from 1.0.4 to 1.1.0, whose only change is a console flag on output items
description: The pin moves to 1.1.0, whose only change is a console flag on text output items that the mod ignores; the full declaration diff and the safety posture are recorded.
status: closed
timestamp: 2026-10-10T17:23:06Z
---

## 0017. pi-codemode moves from 1.0.4 to 1.1.0, whose only change is a console flag on output items

The exact pin of `@earendil-works/pi-codemode` moves from 1.0.4 to 1.1.0, as its own change (hard rule 2). Read on 2026-10-10 from the extracted 1.1.0 tarball against the installed 1.0.4 build.

What changed in 1.1.0, from the `dist` declarations, the runtime JavaScript and the README:
- `CodemodeOutputItem`, text variant, gains an optional `console?: true`. The worker sets it on items that come from `console.log/info/warn/error/debug`; `text()` items stay unmarked. The prelude's `output` host call takes `"text"` or `"console"` as its kind.
- No export, option, event or type was added or removed. `index`, `declarations`, `source`, `identifier`, `wasm`, `runtime/host`, `runtime/protocol` and `runtime/worker` declarations are byte-identical apart from the doc comments of `types.d.ts` and `runtime/prelude-source.d.ts`.
- Dependencies are unchanged (`quickjs-wasi` 3.6.2). The package declares no peer dependencies, in 1.0.4 or in 1.1.0.
- Tool calls are routed and sandboxed as before: the only capability a script has is the injected `tools` object, and `host.js` and the call protocol did not change.

What the mod does with it: `child/main.ts` keeps every item with `type === 'text'` and joins them, so console and `text()` output still reach the model in order and the flag is not read. Nothing is adapted in `child/`, `hooks/`, `shared/` or `types/`.

### Scope

Included:
- The pin and the lockfile at 1.1.0.
- The mod version, 0.7.1 to 0.7.2.

Out:
- Distinguishing console output from `text()` output in the result. The flag allows it; no requirement asks for it.

### Decision

Not load-bearing, so it lives here. **Take the flag as ignored**, over rendering console lines differently: the model sees one stream today and a split has no use yet.

### Acceptance

- C1: `npm run typecheck` passes on 1.1.0 with no source change.
- C2: `npm test` passes (262 tests), including the exact-pin check and the check that no `$.mcp.call` appears in `child/` or `hooks/`, so the invariant that every nested call goes through `$.tool.call` holds.
- C3: `living-docs check docs` passes.
