---
type: Issue
title: An ADR decides how codemode could poll MCP events, before any code, comparing a Bash poller with a mod-side client
description: The mod opens its own MCP connection for the Events extension and exposes poll delivery as a registered tool that goes through the permission check.
status: closed
timestamp: 2026-11-27T17:32:40Z
---

## 0024. An ADR decides how codemode could poll MCP events, before any code, comparing a Bash poller with a mod-side client

MCP Events is the extension `io.modelcontextprotocol/events` (SEP-3415, Beta; protocol revision 2026-07-28 or later): the client calls `events/list`, then `events/poll` with a cursor it stores. The Claude Code 2.1.332 binary has no client for it (0 matches for `events/poll` and `io.modelcontextprotocol/events` in its strings), and the mods API sends no raw MCP request: `$.mcp` has only `call` and `connect`. The mod therefore opens its own connection, which the Constitution puts out of scope today ("A tool that reaches the file system, the shell or the network except through the session's tools"). An ADR and a Constitution amendment come before any code.

### Scope

Included:
- An ADR that compares, at least: a poller a script runs through `tools.Bash` on the official MCP SDK; a client inside the mod's hooks behind a registered tool; recording events as blocked until Claude Code ships a client. It decides host process, transport, where server config comes from, authorization, and where the cursor lives (`store()` is not built: `child/main.ts` passes no store).
- The client duties the spec sets: durable cursors, `eventId` deduplication, `truncated`, `nextPollMs`.
- How the ADR stands against ADR 0001, which rejected keeping a copy of the servers' config and credentials.

Out:
- Code. A follow-up issue opens once a real server the owner uses publishes events.
- Push and webhook delivery; a background subscriber that opens turns.

Delivery order of issues 0020 to 0026: 0020 first; the 0021 and 0022 measurements side by side; 0023 at any point; 0026 after 0022; this ADR last; 0025 in parallel.

### Decision

- **The mod's own MCP client** as the direction, over recording events as blocked until Claude Code ships a client (recommended at first, not taken).
- **A registered poll-only tool**, over a background push subscriber that opens turns.
- **Only the ADR now; code gated on a real server**, after the advisor review of 2026-11-27 found host, transport, config, auth and cursor storage undecided. Not taken: ADR and code proved on a fixture.
- **A poller a codemode script runs through `tools.Bash`**, recorded in [ADR 0003](../adr/0003-codemode-polls-mcp-events-through-a-poller-a-script-runs-with-tools-bash-once-a-real-server-needs-it.md). Not taken: a client inside the mod behind a registered `McpEvents` tool; recording events as blocked.

### Risks

- A stdio server runs as a second process; an HTTP server needs its own authorization, since the session's OAuth tokens are not reachable from the mod.

### Acceptance

- C1: the ADR is written with each option's win, cost and the fact that would prove it wrong, and is Accepted by the owner.
- C2: if the ADR needs it, the Constitution amendment is appended.
- C3: `living-docs check docs` passes.

### Outcome

Decided on 2026-11-27 in [ADR 0003](../adr/0003-codemode-polls-mcp-events-through-a-poller-a-script-runs-with-tools-bash-once-a-real-server-needs-it.md), Accepted by the owner: no Constitution amendment is needed, since the poll goes through the session's `Bash` tool. The poller itself is a follow-up issue, opened when a server the owner uses publishes events.
