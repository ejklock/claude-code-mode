---
type: Issue
title: A nested call whose result arrives later is reported as deferred, not done
description: One ledger state for MCP tasks, auto-backgrounded calls, forked skills and backgrounded Bash, designed from the measurement of issue 0022.
status: open
blocked_by: [0022]
timestamp: 2026-11-27T17:49:36Z
---

## 0026. A nested call whose result arrives later is reported as deferred, not done

Calls whose result reaches the session later — an MCP task, a nested call Claude Code moved to the background, a forked Skill, a backgrounded Bash — are reported to the script and in the failure ledger as `done`, because the bridge reads only `result.text` (advisor review, 2026-11-27; inference until issue 0022 measures it).

### Scope

Included:
- One ledger and transcript state for a deferred result, detected on the structured `result`, not on text.
- What the script receives for a deferred call, decided from issue 0022's measurement: hold the nested call open in the existing bridge when the mod can observe completion, or fail it with the handle.

Out:
- Replay of a run past the codemode call (pi-codemode `start()`), unless the measurement shows the wait must outlive the call.

### Decision

- **Opened now, designed after issue 0022**, over designing it now and over leaving it out of scope.

### Acceptance

- C1: a test per producer the measurement found shows the deferred state instead of `done`.
- C2: `npm test` and `se-gates check` pass.
