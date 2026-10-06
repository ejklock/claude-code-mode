---
type: Issue
title: A prototype runs a script that calls Read and Bash through the mod and measures the child process overhead
description: A first mod and bridge expose only Read and Bash to a script, to prove the design and measure its per-call overhead before the ADR is accepted.
status: open
timestamp: 2026-10-06T14:08:54Z
---

## 0001. A prototype runs a script that calls Read and Bash through the mod and measures the child process overhead

Implements the first slice of [ADR 0001](/adr/0001-a-claude-code-mod-hosts-the-pi-codemode-runtime-in-a-node-child-process-and-routes-every-nested-call-through-the-session-s-tool-call.md). The ADR stays Proposed until this prototype shows that the bridge works and what it costs. The design has unknowns that only a running prototype can answer: whether the mod can start the child and reach it over a Unix socket, the cost of one bridged call, and the shape of a built-in tool's result under `$.tool.call`. They are listed in [research 0001](/research/0001-pi-codemode-and-how-to-host-it-in-claude-code.md).

### Scope

Included:
- A mod that registers one `codemode` tool.
- A Node child process running `@earendil-works/pi-codemode` at an exact pinned version, with only `tools.Read` and `tools.Bash` exposed.
- The bridge: a call request from the child goes to the mod, which runs it with `$.tool.call` and returns the result over the child's Unix socket.
- A measurement of the bridge's overhead.

Out: MCP tools, other built-in tools, `store()`/`load()`, tool search, the declarations budget, and task-level savings. Each is a later issue.

### Decision

- One child process per script call for the prototype. A long-lived child is the option not taken, kept for the case where the measurement shows start-up dominates.
- Tool names in the script follow Claude Code's (`tools.Read`, `tools.Bash`), not Pi's lower-case names. Pi aliases are a parity question for a later issue.
- The plugin is named `codemode`, because `claude plugin validate` reserves names that start with `claude-`. The repository keeps its name. `$.tool.register` exposes the tool to the model as `mcp__codemode__codemode`, and "the `codemode` tool" in these docs means that name. Owner, 2026-10-06.
- `typescript` and `@types/node` are exact-pinned devDependencies, so `npm run typecheck` covers the mod, the child and the tests. Owner, 2026-10-06.
- The repository root is the plugin (`.claude-plugin/` at the root), loaded with `claude --plugin-dir .`; owner, 2026-10-06.
- npm is the package manager, with a committed lockfile; owner, 2026-10-06.
- The child entry script is TypeScript run directly by Node's type stripping, with no build step; owner, 2026-10-06.
- `@earendil-works/pi-codemode` is pinned at `1.0.4`, the latest version on 2026-10-06 (needs Node >=22.19).
- Proof is layered, because `claude plugin test` in build 2.1.291 runs no process (`HooksError: no implementation for process.spawn`, and no fs or network in the test environment). `claude plugin test` covers the mod's side with the child stood in by the test's `process.spawn` and `http.fetch` hooks. `node --test` covers the real child on a real socket. A headless `claude -p --plugin-dir .` run, with real allow and deny rules, proves the whole path. The stand-in counts only because the headless run proves the real path. Owner, 2026-10-06.

### Acceptance

- A `codemode` call whose script reads a file with `tools.Read` and runs `echo` with `tools.Bash` returns both results to the model in one tool result. Proof: the layered tests (see Decision), and one live run recorded here.
- A permission rule that denies the nested Bash command denies it inside the script, and the script sees the denial. Proof: a live run recorded here.
- The overhead is measured and recorded here: the child's start-up time, and the median and 95th-percentile round trip of one bridged `tools.Read`, against a direct Read, over at least 20 runs.
- No mod source file calls `$.mcp.call`, and the package manifest pins `@earendil-works/pi-codemode` with no version range. Proof: a test or a check that fails otherwise.

### Plan

1. Scaffold the mod (manifest, hooks module, types) and register the `codemode` tool.
2. Child entry script: start `pi-codemode` with the two tool declarations, listen on a Unix socket, and write call requests to its output.
3. The mod's bridge loop: read requests, run `$.tool.call`, post the result to the socket.
4. Tests, the live runs, and the measurement.
