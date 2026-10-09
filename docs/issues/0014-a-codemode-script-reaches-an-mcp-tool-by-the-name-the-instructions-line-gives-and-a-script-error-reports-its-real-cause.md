---
type: Issue
title: A codemode script reaches an MCP tool by the name the instructions line gives, and a script error reports its real cause
description: The MCP instructions line names tools with the server's hyphen while the script's tools object uses underscores, and a script that throws while nested calls are pending reports an ENOENT on the bridge socket instead of the script's own error.
status: open
timestamp: 2026-10-09T08:11:10Z
---

## 0014. A codemode script reaches an MCP tool by the name the instructions line gives, and a script error reports its real cause

Two defects were found on 2026-10-09, in a live session. Together they cost the model a turn and hid the cause.

1. **The name mismatch.** The MCP instructions line from `instructionsLine` in `hooks/expose.ts` says that `mcp__agent-memory__*` runs inside codemode as `tools.<name>(args)`. In a script, the tool is `tools.mcp__agent_memory__memory_read`: `ALL_TOOLS` lists the names with underscores. A model that copies the line's name writes `tools.mcp__agent-memory__memory_read`. JavaScript reads that as a subtraction, and the script throws a `ReferenceError`.
2. **The masked error.** The failing script started three nested calls in one array literal, then threw a `ReferenceError` before awaiting them. The codemode result was `the answer to a nested call could not reach the child: … bridge.sock failed: ENOENT`. The script's own error was nowhere in it.

### Scope

- The instructions line names each tool, or server wildcard, by the name the script's `tools` object uses. The same normalization applies wherever the child builds that object.
- When the child fails on a script error, the codemode result leads with that error: its name and message. An answer that could not reach the child after it exited is kept in the ledger as secondary, never as the reported cause.

- A third case, found during round 1: the bridge stops reading the child when a problem is recorded. So a late-answer failure recorded before the child's closing line is read would still hide the script's error. It is fixed here too.

### Decision

- **Names: a copy of the rule with an oracle test.** The script-side rule is `toCodemodeIdentifier` from `@earendil-works/pi-codemode`. The hooks loader refuses any package import. So `shared/` holds a copy of the rule, and a Node spec checks the copy against the package's function over sample names. The owner chose this on 2026-10-09. Not taken: the child computing the names (a protocol change, and no child runs when the line is built); a wording-only line (it leaves the conversion to the model).
- **The race is fixed now, not tracked separately.** The owner, 2026-10-09.
- **A script error's type leads its message** (`ReferenceError: x is not defined`). A plain `Error` keeps its bare message.

### Acceptance

- A unit test: for a connected server named `agent-memory`, the instructions line contains `mcp__agent_memory__*` and not `mcp__agent-memory__*`.
- A test through the bridge: a script that starts a nested call, then throws `ReferenceError` before awaiting it, yields a result whose first line names `ReferenceError` and the undefined identifier. The ledger still lists the call that ran.
- `npm run typecheck`, `npm test`, `plugin validate .`, `plugin test .` and `se-gates check` pass.
