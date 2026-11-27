---
type: Issue
title: The headless MCP checks judge the mod, not the model choices, and pass twice in a row
description: Four MCP checks of scripts/e2e.ts fail before and after the permission barrier; find whether the mod or the model choice fails each.
status: open
timestamp: 2026-11-27T19:56:40Z
---

## 0030. The headless MCP checks judge the mod, not the model choices, and pass twice in a row

On 2026-11-27, `node scripts/e2e.ts` failed four MCP checks both on commit 3316f40 and with the permission barrier of issue 0029, so they predate the barrier: `mcp codemode mode: the result holds the server answer`, and three `mcp arguments loaded` checks (ToolSearch `select:` with the full name before the first codemode call; the script called the tool by its identifier; the first call carried its argument). In one earlier run the model ended with "I couldn't seal the records". Inference: some checks judge what the model chooses, which varies by run and by model.

### Scope

Included:
- For each of the four checks, whether it fails on the mod's behavior or on the model's choice, from the run's stream.
- A fix of the mod where the mod is at fault; otherwise a check that judges only what the mod controls.

Out:
- The permission cases, fixed by issue 0029.

### Decision

- Opened from issue 0029's headless check.

### Acceptance

- C1: the Outcome names, per check, the stream lines that show its cause.
- C2: `node scripts/e2e.ts` passes these checks in two runs in a row, or each remaining one is rewritten to judge the mod and says why.
