---
type: Issue
title: Measure what a codemode script receives when an MCP tool answers with a task
description: A fixture tool answers tools/call with an MCP task, and the issue records what $.tool.call returns to the mod before any waiting is designed.
status: open
timestamp: 2026-11-27T17:32:38Z
---

## 0022. Measure what a codemode script receives when an MCP tool answers with a task

MCP Tasks is the extension `io.modelcontextprotocol/tasks` (SEP-2663): a server may answer `tools/call` with `resultType: "task"` and a `taskId`, and the client polls `tasks/get`. The Claude Code 2.1.332 binary handles it: its strings carry "tasks/get failed for task" and a result `{resultType:"task", taskId, status:"working"}` whose text says the result arrives automatically and to end the turn. Inference, not measured: a codemode script receives that marker instead of the result, and has no timers to wait.

### Scope

Included:
- A tool in `test/fixtures/fake-mcp-server.mjs` that answers with a task; the fixture speaks protocol revision 2026-07-28 (`server/discover`, per-request capabilities in `_meta`) next to its `initialize` handshake.
- The record of what `$.tool.call` returns to the mod for it, and whether any surface the mod can see (the structured `result`, a hook, a session message) carries the completed result.
- Whether Claude Code also moves a slow nested call to a background task on its own, from a server with no task support.

Out:
- The design of the wait. Issue 0026 takes it.

Advisor review, 2026-11-27, from the 2.1.332 strings: the MCP task result says the result "arrives as a task notification", delivered to the model; the MCP task status tool says never to use it to wait or poll. Inference: a nested call gets a marker and the full result lands in the model's context unfiltered.

### Decision

- **Measure first, design after**, over designing the wait now on an unmeasured premise.

### Acceptance

- C1: the Outcome carries the real output of one live call of the fixture tool from a script, and answers both questions of the scope: a mod-visible completion surface, and auto-backgrounding of a slow nested call.
- C2: a spec under `test/node` drives the mod against the fixture, so the proof covers the mod and not the fixture alone.
