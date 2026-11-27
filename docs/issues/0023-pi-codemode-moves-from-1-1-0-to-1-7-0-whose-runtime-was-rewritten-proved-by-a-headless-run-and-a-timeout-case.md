---
type: Issue
title: pi-codemode moves from 1.1.0 to 1.7.0, whose runtime was rewritten, proved by a headless run and a timeout case
description: The exact pin moves to 1.7.0 in its own change; the declaration diff from 1.1.0 is recorded.
status: open
timestamp: 2026-11-27T17:32:39Z
---

## 0023. pi-codemode moves from 1.1.0 to 1.7.0, whose runtime was rewritten, proved by a headless run and a timeout case

The exact pin of `@earendil-works/pi-codemode` moves from 1.1.0 to 1.7.0, as its own change (hard rule 2). Read on 2026-11-27 from the two npm tarballs (`npm pack`, then `diff` of `dist`):
- Added: `CodemodeSandboxBase.start()` with `CodemodeRun`, `CodemodeHostCall`, `CodemodeOutcome` and `CodemodeDuring`, a run whose calls the host answers later with `deliver(seq, now, id, outcome)`; `InlineCodemodeSandbox`; `RemoteCodemodeSandbox` and the `portable` and `cloudflare` entry points; `acquireWorker` and `onWorkerStarted`; constraint tags in rendered declarations; `resolveSchemaRef`.
- Removed: `MCP_TYPESCRIPT_PREAMBLE` and `mcpStructuredContentSchema`.
- The mod imports only `CodemodeSandbox` (`child/main.ts`) and `toCodemodeIdentifier` (tests), so the removals touch no source file (inference until C1 and C2 run).

### Scope

Included:
- The pin and the lockfile at 1.7.0; the mod version bump.
- A deadline-expiry case in `test/node/child.spec.ts`, since 1.7.0 says a timed-out VM "may still be computing" where 1.1.0 terminated the worker.

Out:
- Adopting `start()`. The existing `AnswerBoard` (`child/main.ts`) already answers a call late; `start()` adds replay, not waiting.

The runtime was rewritten: `runtime/host.js` went from 367 to 85 lines, and `runtime/execution.js` and `runtime/vm.js` are new (advisor review, 2026-11-27).

### Decision

- **Its own commit and issue**, over the same commit as the tasks code, which would change hard rule 2.
- **Independent of the tasks work**, after the advisor review showed the wait does not need `start()`. Not taken: keeping it as the first step of tasks.
- 1.7.0, the latest at the time of writing (published 2026-11-27).

### Acceptance

- C1: `npm run typecheck` passes.
- C2: `npm test` passes, the exact-pin check, the identifier oracle and the new timeout case included.
- C3: `node scripts/e2e.ts` passes against the installed mod on 1.7.0.
- C4: `se-gates check` passes.
