---
type: Issue
title: A check tells the day Claude Code declares the MCP tasks extension
description: A headless check against a logging fixture reports whether the session declares io.modelcontextprotocol/tasks, so deferred-result work reopens on the build that needs it.
status: open
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

### Acceptance

- C1: run against the installed build, the script prints that the tasks extension is not declared and quotes the error the script received.
- C2: a unit test covers the request-log classifier: a log with the extension declared, one without, and one with no `clientCapabilities`.
- C3: `npm test` and `se-gates check` pass.
