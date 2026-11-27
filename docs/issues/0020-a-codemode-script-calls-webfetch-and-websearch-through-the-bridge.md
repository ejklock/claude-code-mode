---
type: Issue
title: A codemode script calls WebFetch and WebSearch through the bridge
description: WebFetch and WebSearch join the exposed tools, so a script reads and searches the web through the session tools and returns only what it prints.
status: closed
timestamp: 2026-11-27T17:32:35Z
---

## 0020. A codemode script calls WebFetch and WebSearch through the bridge

The script reaches the network only through the session's tools (Constitution, Non-negotiables). `EXPOSED_TOOLS` in `shared/protocol.ts` lists neither `WebFetch` nor `WebSearch`, so a script's `tools.WebFetch` fails with "does not exist" (seen in a live session on 2026-11-27).

### Scope

Included:
- `WebFetch` and `WebSearch` in `EXPOSED_TOOLS`, with their declarations and description sections.

Out:
- The Agent tool; it keeps its Phase 2 place in the Constitution.

### Decision

- **WebFetch and WebSearch together**, over WebFetch only (one change lets a script search and then read) and over adding the Agent tool too (a larger scope with its own risks).
- The delivery order of issues 0020 to 0026 lives in issue 0024, the issue that stays open longest.
- **After any failed script, the bridge waits for nested calls still running only `CLOSING_GRACE_MS`, then lists them unknown with the may-have-run note**, over the grace on a deadline only (a plain script error would again wait on every call, and hang on a call that never answers). Accepted cost: a nested Edit waiting on a permission prompt can run after the model has moved on; the ledger says it may have run.
- A thrown nested call answers the script with an error that names the tool (`TOOL: reason`, or `TOOL failed` for an empty reason); the ledger keeps the raw reason.
- **Review follow-ups in a separate task** (a test that a call answering during the grace is listed done and that a successful script still waits for every answer, the `CLOSING_GRACE_MS` docblock, the web-tool tests in their own describe), over a session edit under #solo and over accepting them as open items; the round limit of this slice was reached.

### Acceptance

- C1: `npm test` passes with a case where a script's `tools.WebFetch` and `tools.WebSearch` reach `$.tool.call`, `WebSearch` with `allowed_domains` as an array; `ToolArg` in `shared/protocol.ts` gains an array type for it.
- C2: a script in a live session fetches one URL and prints only a summary.
- C3: a script whose web call outlives the 120 s script deadline (`hooks/register.ts`) fails with a ledger that marks the call `unknown`, proved by a test.
- C4: a script calls `tools.WebFetch` in a session where the tool is absent or deferred, and the error names the cause; proved by a test.
- C5: `se-gates check` passes.

### Outcome


(Bash completed with no output)

Shipped in v0.8.0 (pull request #18, merge commit 1fd42d8). C1, C3, C4 and C5 are proved by `claude plugin test .` (234 pass on 2.1.291 and 2.1.332), `npm test` and the quality gate.

C2, verified on 2026-11-27 in a live interactive session with v0.8.0 installed: `ALL_TOOLS` lists WebFetch and WebSearch, and a script's `tools.WebFetch` on an MCP documentation page returned its text. In the same session the permission barrier refused a script's `tools.Write` to `/etc` with the engine's ask reason, and the file was not written; it also refused a nested `Bash` that the auto mode's classifier would have settled, since the verdict was `ask`.
