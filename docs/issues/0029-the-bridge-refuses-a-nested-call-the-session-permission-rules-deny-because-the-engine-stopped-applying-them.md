---
type: Issue
title: The bridge refuses a nested call the session permission rules deny, because the engine stopped applying them
description: A plugin $.tool.call ignores deny rules in Claude Code 2.1.328-2.1.332; the bridge asks $.tool.check first and refuses a denied call.
status: closed
timestamp: 2026-11-27T19:28:30Z
---

## 0029. The bridge refuses a nested call the session permission rules deny, because the engine stopped applying them

Issue 0028 found that a plugin's `$.tool.call` ignores permission deny rules in Claude Code 2.1.328 to 2.1.332, so a codemode script runs a call the session's rules deny. The Constitution's first non-negotiable assumes `$.tool.call` applies the permission check. Until the engine does again, the bridge asks the engine's own permission decision before each nested call.

### Scope

Included:
- A measurement first: what `$.tool.check` returns on the installed build for a call a deny rule matches, one an allow rule matches, and one no rule matches (ask), and whether `PreToolUse` hooks run for a nested `$.tool.call`.
- The bridge refuses a nested call whose decision is `deny`, with the reason, before calling `$.tool.call`; the ledger lists it as failed, not unknown, since nothing ran.
- The handling of `ask`, decided from the measurement.
- A headless proof that a denied nested call is refused.

Out:
- Any change to how the engine decides; the report upstream, whose text the owner approves.

### Decision

- Opened from issue 0028's diagnosis, by the owner's choice of a barrier in the mod over disabling codemode.
- **The bridge refuses a nested call whose `$.tool.check` verdict is `deny` or `ask`**, with the verdict's reason, and calls `$.tool.call` only on `allow`; a check that throws refuses too, since nothing has run. A script then does only what the session's allow rules and the engine's own checks grant; for anything else the model calls the tool directly and gets the engine's prompt. Not taken: refusing only `deny` (an ask would keep running unasked, as measured); refusing `deny` now and deciding `ask` after an interactive test.
- **Review round before the commit**: a test that an unknown or missing verdict refuses the call, and the hand-built stand-in host typed; not taken: committing with the findings open.
- **The Constitution gains Amendment 1**, recording that the bridge asks the verdict while the engine skips it; not taken: leaving the ratified reason as it stands.
- **Committed with one weak case left open**: not taken: a third round to sharpen it.

### Acceptance

- C1: the Outcome records the `$.tool.check` answers for deny, allow and ask, and whether `PreToolUse` hooks ran, from a live session.
- C2: a codemode script whose nested call a deny rule matches gets an error naming the rule's decision, and the call does not run; proved by a test and by a headless run.
- C3: `npm test`, `claude plugin test .` and `se-gates check` pass.

### Outcome

Measured on 2026-11-27, Claude Code 2.1.332, headless, from a throwaway copy of the mod whose bridge called `$.tool.check({ tool, input })` before each `$.tool.call` and printed the verdict (repro under `$TMPDIR/p29-*`, session only). `$.tool.check` rejects `{ tool, ...args }`: it takes `{ tool, input }`.
| Nested call | Settings | `$.tool.check` | Did `$.tool.call` run it? |
|---|---|---|---|
| `Bash("echo denied")` | `deny: Bash(echo denied:*)` | `deny`, `rule: Bash(echo denied:*)`, reason "Permission to use Bash with command echo denied has been denied." | yes |
| `Bash("echo ok")` | `allow: Bash(echo ok:*)` | `allow`, `rule: Bash(echo ok:*)` | yes |
| `Bash("echo ask")` | no rule | `allow`, no rule (inference: a read-only command the engine allows on its own) | yes |
| `Write` to a new file | no rule | `ask`, "you haven't granted it yet" | **yes, the file was created** |
The same `Write` called directly by the model was refused (`is_error`, no file). A project `PreToolUse` hook on Bash ran for all three nested Bash calls. So `$.tool.call` skips the whole permission decision, deny and ask alike, while hooks still run. Whether an interactive session opens the ask dialog for a nested call was not measured.

Headless check, 2026-11-27, `node scripts/e2e.ts`: on the previous commit (3316f40, no barrier) 42 PASS and 12 FAIL, 8 of them permission cases and 4 MCP cases; with the barrier 50 PASS and 4 FAIL, the same 4 MCP cases (`mcp codemode mode`, `mcp arguments loaded`). The barrier fixes exactly the permission cases and adds no failure; issue 0030 takes the MCP cases.

Review round, 2026-11-27: tests now pin that a verdict of `{ decision: 'unknown' }` or `{}` refuses the call and the tool never runs, and the hand-built stand-in is typed against `BridgeHost` (the reviewer added a member in a copy and typecheck failed there). Open, accepted: the case whose check resolves `undefined` is refused by the catch, so it cannot tell that path from the allow check (the other two cases do); two casts in that stand-in are wider than needed. `claude plugin test .` 234 pass, `npm test` 279 pass, `se-gates check` pass.
