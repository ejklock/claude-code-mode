---
type: ADR
title: A Claude Code mod hosts the pi-codemode runtime in a Node child process and routes every nested call through the session's tool call
description: A mod registers the codemode tool, runs pinned pi-codemode in a Node child process and sends every nested call back through $.tool.call over a Unix-socket bridge.
owner: Evaldo Klock
status: Proposed
timestamp: 2026-10-06T14:08:54Z
---

# 0001. A Claude Code mod hosts the pi-codemode runtime in a Node child process and routes every nested call through the session's tool call

## Context

Pi 0.99 added codemode: the model writes one JavaScript script that calls the session's tools as `tools.<name>(args)`, and only the script's output returns to the model. The owner wants the same in Claude Code for three goals: fewer tokens and turns per task, the session's MCP servers as a typed API, and parity with Pi, so one procedure runs the same in both harnesses.

Claude Code offers three ways to add such a tool, and only one can call the built-in tools (Read, Bash, Edit, Agent) under the user's permission checks and hooks. That way, a mod, runs its hooks module in an environment with no WebAssembly and no `eval`, while Pi's runtime is QuickJS compiled to WebAssembly. The evidence is in [research 0001](/research/0001-pi-codemode-and-how-to-host-it-in-claude-code.md).

## Decision

We will build a Claude Code mod that registers one `codemode` tool with `$.tool.register`. It runs each script in a Node child process that hosts `@earendil-works/pi-codemode` at an exact pinned version. Each nested `tools.<name>(args)` call travels from the child to the mod, which runs it with `$.tool.call`, never `$.mcp.call`, and returns the result to the child over a Unix socket that the child listens on, reached with `$.http.fetch` and `socketPath`.

The owner confirmed this direction on 2026-10-06. It stays Proposed until the prototype in [issue 0001](/issues/0001-a-prototype-runs-a-script-that-calls-read-and-bash-through-the-mod-and-measures-the-child-process-overhead.md) measures the bridge.

Rejected alternatives:

- **A plugin that ships an MCP server with one execute tool.** It runs as a separate process and cannot call Claude Code's built-in tools. It would have to reimplement read and bash, losing parity and the permission checks, or spawn `claude mcp serve`, which skips the user's permission prompts. It reaches other MCP servers only as an MCP client with its own copy of their config and credentials.
- **Plain settings hooks.** A hook consumes tools and cannot register one, so it cannot host the feature.
- **The Pi harness under Claude Code.** It brings Pi's whole agent loop when only the script runtime is needed. `pi-codemode` has no Pi dependencies.
- **An own QuickJS runtime (for example `quickjs-emscripten`) with an API copied from Pi.** No third-party dependency, but declaration generation, tool search and `store`/`load` would be rewritten, and parity kept by hand. Pinning `pi-codemode` keeps any later swap inside the child process.
- **Nested calls through `$.mcp.call`.** It is simpler for MCP tools, but it shows no permission prompt.

## Consequences

**Easier / gained:**
- One script call replaces many model turns for a multi-call procedure.
- The script API matches Pi's, so a procedure written for one harness runs in the other.
- Every nested call, built-in, Agent or MCP, goes through Claude Code's permission check and hooks.
- MCP servers appear in the script as typed `tools.*` functions, from the declarations `pi-codemode` generates.

**Harder / accepted trade-offs:**
- The mods API is early access and may change without notice.
- Every nested call pays a child-to-mod round trip, and the child needs Node on the machine.
- `pi-codemode` is new (0.99/1.0). Its upgrades are deliberate, one pinned version at a time.
- Script side effects are not rolled back when a later call fails, as in Pi.
- `store()` has no Pi session entries to write to; where it persists is decided in a later issue.

**Follow-ups:**
- [Issue 0001](/issues/0001-a-prototype-runs-a-script-that-calls-read-and-bash-through-the-mod-and-measures-the-child-process-overhead.md): the prototype and its bridge measurement.
- An issue to measure task-level tokens and turns with and without codemode on the same tasks, opened after the prototype.

## Verification

**Implementation impact:** the mod's hooks module (tool registration and the bridge), the child-process entry script, and the package manifest that pins `@earendil-works/pi-codemode`.

**Verification criteria:**
- A script that calls `tools.Read` and `tools.Bash` returns their results, and each call shows Claude Code's permission check (a denied rule denies the nested call).
- No source file of the mod calls `$.mcp.call`.
- The package manifest pins `@earendil-works/pi-codemode` to an exact version, with no range.

# References

[1] [Research 0001 — Pi codemode and how to host it in Claude Code](/research/0001-pi-codemode-and-how-to-host-it-in-claude-code.md)
