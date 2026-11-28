---
type: Issue
title: A check tells the day Claude Code declares the MCP tasks extension
description: A headless check against a logging fixture reports whether the session declares io.modelcontextprotocol/tasks, so deferred-result work reopens on the build that needs it.
status: closed
timestamp: 2026-11-27T18:47:34Z
---

## 0027. A check tells the day Claude Code declares the MCP tasks extension

Issue 0022 measured that Claude Code 2.1.332 never declares the MCP Tasks extension (`io.modelcontextprotocol/tasks`): a tool that answers with a task becomes the error `Unsupported result type 'task' for tools/call`, and no call is moved to the background. Codemode has nothing to handle today, so issue 0026 closed. This check tells the day a build declares the extension, so the deferred-result work can reopen.

### Scope

Included:
- A script under `scripts/` that runs one headless session against a stdio fixture that logs every request, and reports whether any request's `_meta` `clientCapabilities` declares `io.modelcontextprotocol/tasks`, and what a script receives from a tool that answers with a task.
- A README line on when to run it: after a Claude Code upgrade.

Out:
- Any handling of tasks in the bridge; issue 0026 reopens for that.

### Decision

- **A runnable check**, over leaving issue 0026 open and blocked with no signal (nobody would notice the day it changes).
- **A third round on the fixture** after the round-2 approval: the fields the 2026-07-28 core schema requires (`ttlMs` and `cacheScope` on `server/discover`, `serverInfo` in `_meta`, `resultType` on the nested call result and on `tools/list`), the fixture as `.ts` so its types come from the file and the hand-written `.d.mts` stub goes, and `createdAt` taken at task creation so the task is not born expired. Not taken: committing with them as open items.
- **Committed with one test risk moved to a follow-up**: the fixture-wiring test puts a stand-in `claude` first on PATH; on a host whose temporary directory is mounted `noexec`, the PATH search would skip it and run the real `claude`, spending tokens. Not on this host or in CI. A follow-up adds an executable check before the spawn. Not taken: holding the commit for it.

### Acceptance

- C1: run against the installed build, the script prints that the tasks extension is not declared and quotes the error the script received.
- C2: a unit test covers the request-log classifier: a log with the extension declared, one without, and one with no `clientCapabilities`.
- C3: `npm test` and `se-gates check` pass.

### Outcome

Shipped on 2026-11-27 after three review rounds. `node scripts/tasks-check.ts` runs one headless session against `test/fixtures/tasks-mcp-server.ts`, a typed fixture in the 2026-07-28 shapes (CreateTaskResult and GetTaskResult with the Task fields, `server/discover` advertising the extension with the cache fields and `_meta` serverInfo, `createdAt` at task creation), and prints whether the session declares `io.modelcontextprotocol/tasks`, the protocol, the capabilities it sent and what the codemode script received. On Claude Code 2.1.332:

```
tasks extension: not declared
protocol: 2026-07-28
capabilities sent: {"roots":{"listChanged":true},"elicitation":{"form":{},"url":{}}}
script received: "ERROR: Unsupported result type 'task' for tools/call"
```

Proved: `node --test test/node/tasks-check.spec.ts` 26 pass; `npm test` 348; `claude plugin test .`; quality gate pass. Open: the noexec fall-through in the wiring test (follow-up).
