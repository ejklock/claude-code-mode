---
type: ADR
title: Codemode polls MCP events through a poller a script runs with tools.Bash, once a real server needs it
description: A poller on the official MCP SDK, run by a codemode script through tools.Bash with its own cursor file; no events code until a real server publishes events.
owner: Evaldo Klock
status: Accepted
timestamp: 2026-11-28T02:35:30Z
---

# 0003. Codemode polls MCP events through a poller a script runs with tools.Bash, once a real server needs it

## Context

MCP Events (`io.modelcontextprotocol/events`, SEP-3415, Beta, protocol 2026-07-28 or later) lets a client list event types (`events/list`) and receive occurrences by poll (`events/poll` with a cursor), push or webhook. Claude Code 2.1.332 has no client for it, and the mods API sends no raw MCP request (`$.mcp` offers only `call` and `connect`), so codemode can reach events only through a client of its own ([issue 0024](../issues/0024-an-adr-decides-how-codemode-could-poll-mcp-events-before-any-code-comparing-a-bash-poller-with-a-mod-side-client.md)). [ADR 0001](0001-a-claude-code-mod-hosts-the-pi-codemode-runtime-in-a-node-child-process-and-routes-every-nested-call-through-the-session-s-tool-call.md) rejected keeping a copy of the servers' config and credentials inside the mod, and the Constitution keeps the script off the network except through the session's tools. The spec puts durable cursors, `eventId` deduplication, `truncated` and `nextPollMs` on the client. No server the owner uses publishes events today.

## Decision

We will poll MCP events, when a real server needs it, through a small poller on the official MCP SDK that a codemode script runs with `tools.Bash`, keeping its cursor in a file the poller owns; no events code ships until such a server exists.

Rejected alternatives:
- **A client inside the mod behind a registered `McpEvents` tool**: a named tool with its own permission rule, but it keeps server config and credentials in the mod against ADR 0001's reasoning, needs a Constitution amendment, and the hooks loader cannot import the SDK.
- **Recording events as blocked until Claude Code ships a client**: no code and a check like issue 0027's, but events stay out of reach even when a server the owner uses publishes them.

## Consequences

**Easier / gained:**
- The poll goes through `$.tool.call` as a `Bash` call, so the permission barrier and the user's rules apply; no Constitution amendment; the mod stays free of MCP client code.

**Harder / accepted trade-offs:**
- Permission rules name a `Bash` command, not an events tool.
- The poller holds its own connection and a second copy of the server's credentials; the cursor lives in a file, since `store()` is not built.

**Follow-ups:**
- An issue to write the poller and its README section, opened when a server the owner uses publishes events.

## Verification

**Implementation impact:** none until the follow-up; then a script under `scripts/` and a README section.

**Verification criteria:**
- `git grep -n '\$\.mcp\.call' -- child hooks` finds nothing, and no events client appears under `hooks/` or `child/`.
- The follow-up's poller passes a test against a fixture that serves `events/list` and `events/poll`, resuming from its stored cursor and dropping a repeated `eventId`.

# References

[1] [MCP Events extension overview](https://modelcontextprotocol.io/extensions/events/overview.md)
[2] [Issue 0024](../issues/0024-an-adr-decides-how-codemode-could-poll-mcp-events-before-any-code-comparing-a-bash-poller-with-a-mod-side-client.md)
