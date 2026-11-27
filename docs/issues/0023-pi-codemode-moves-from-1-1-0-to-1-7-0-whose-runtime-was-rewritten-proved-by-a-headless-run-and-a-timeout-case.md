---
type: Issue
title: pi-codemode moves from 1.1.0 to 1.7.0, whose runtime was rewritten, proved by a headless run and a timeout case
description: The exact pin moves to 1.7.0 in its own change; the declaration diff from 1.1.0 is recorded.
status: closed
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
- The mod version goes to 0.8.0, a minor bump, because the branch also carries the new web tools (issue 0020).
- **C3 accepted in part**: the headless run loads the mod on 1.7.0, and its permission-denial cases fail the same way on 1.1.0, so the failure belongs to the test environment; issue 0028 takes it. Not taken: the owner running the headless check in a plain shell; holding this issue until the check passes.
- **Review round on the deadline tests**: a per-test timeout so a child that never exits fails instead of hanging, and the exact timeout message; the in-time case keeps its wide margin as a stated choice against flakiness from worker start-up. Not taken: also narrowing that margin; committing with the findings open.

### Acceptance

- C1: `npm run typecheck` passes.
- C2: `npm test` passes, the exact-pin check, the identifier oracle and the new timeout case included.
- C3: `node scripts/e2e.ts` passes against the installed mod on 1.7.0.
- C4: `se-gates check` passes.

### Outcome

Read from the coder's report and checked by the session on 2026-11-27:
- The pin is exactly 1.7.0 (`npm ls @earendil-works/pi-codemode`); `npm test` 279 pass, `claude plugin test .` 224 pass, `se-gates check` pass; no source change was needed.
- Three deadline cases in `test/node/child.spec.ts` (a script that never yields, a script waiting on a nested call that never answers, a script that ends in time) pass on 1.7.0 and already passed on 1.1.0: they guard the behavior, they do not show a change.
- `node scripts/e2e.ts` fails its permission-denial cases (a denied call returns `NOT-DENIED`) on 1.7.0 and on 1.1.0 alike in this session (auto permission mode, `CLAUDE_CONFIG_DIR` set, remote and policy settings present); the coder reports the other cases pass. Issue 0028.
- Review round: each deadline case now has a kill limit and a test timeout, so a child that never exits fails (the reviewer saw it fail in about 1 s against a stub child) and the timeout message is asserted exactly. Open nit, accepted: if reading the child's output threw, the helper would clear its kill timer without killing the child; reading only, no reproduction.
