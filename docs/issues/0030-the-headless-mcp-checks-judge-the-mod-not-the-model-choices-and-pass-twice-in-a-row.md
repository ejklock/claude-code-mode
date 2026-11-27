---
type: Issue
title: The headless MCP checks judge the mod, not the model choices, and pass twice in a row
description: Four MCP checks of scripts/e2e.ts fail before and after the permission barrier; find whether the mod or the model choice fails each.
status: closed
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
- **Fix the mod and the harness**: the `ALL_TOOLS` description of an MCP tool names its original name for ToolSearch, and the headless checks judge the codemode call that calls the tool, not the first codemode call; the ordering check becomes "ToolSearch with the full name came before the first call of the tool".

### Acceptance

- C1: the Outcome names, per check, the stream lines that show its cause.
- C2: `node scripts/e2e.ts` passes these checks in two runs in a row, or each remaining one is rewritten to judge the mod and says why.

### Outcome


Diagnosed on 2026-11-27 from the stream of the previous commit's headless run (`$TMPDIR/base-*/e2e.log`) and one run of the `mcp arguments loaded` scenario alone on v0.8.0 (`$TMPDIR/e30-*`), session only.

- **The harness judges the wrong call.** In both scenarios the model's first codemode call only lists `ALL_TOOLS` to find the tool; the second does the work (`fake-echo: e2e-ping-31`, `sealed with sealed`). `codemodeResult` in `scripts/e2e.ts` takes the first codemode call, so "the result holds the server answer" and "the script called the tool by its identifier" fail on a run that did both.
- **The mod hides the name ToolSearch needs.** A script sees an MCP tool in `ALL_TOOLS` only by its identifier (`mcp__fake_store__seal_record`). The model, following the guideline, sent ToolSearch `select:mcp__fake_store__seal_record` and got "No matching deferred tools found", because the tool's name is `mcp__fake-store__seal_record`; it then called the tool without its argument (seal log: `without`). The `ALL_TOOLS` description of an MCP tool (`mcpDeclarationOf` in `shared/protocol.ts`) is the server's description alone, while the codemode description's own section names the original name.

Fixed and proved on 2026-11-27: the `ALL_TOOLS` description of an MCP tool ends with "Load its parameters with ToolSearch `select:<original name>`." (server text neutralized by the same `inert`, now in `shared/protocol.ts`), and the headless checks judge the first codemode call that names the tool. `node scripts/e2e.ts` ran twice with 54 PASS and 0 FAIL (coder's runs); `npm test` 283, `claude plugin test .` 234, quality gate pass. Accepted nits from review: no test pins the neutralizing of the tool name in that line (names are limited to letters, digits, `_` and `-`, inference); the ordering check's label says "call of the tool" while it matches calls whose code names the identifier.
