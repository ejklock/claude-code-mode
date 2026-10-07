---
type: Issue
title: The description teaches idempotent writes and targeted search, and the failure ledger marks read-only calls
description: Adds description guidance for writes that are safe to repeat, data-derived idempotency keys and rg or git grep search, and marks a ledger entry read-only when the engine reports isReadOnly.
status: open
timestamp: 2026-10-07T03:43:54Z
---

## 0008. The description teaches idempotent writes and targeted search, and the failure ledger marks read-only calls

The mod cannot make other tools idempotent. It can teach scripts to write in a way that is safe to repeat, and it can tell a retry which past calls were read-only. This follows issue 0006 and [research 0002](/research/0002-what-the-mcp-specification-recommends-for-tool-errors-annotations-structured-output-and-client-safety-and-how-codemode-stands.md).

### Scope

- Description guidance: prefer writes that are safe to repeat (overwrite, `mkdir -p`, upsert, check then act). When a tool takes an id or an idempotency key, derive it from the data, never at random. Search with `rg` or `git grep` through `Bash`, print only the matches, then read only the files that matter. When a tool returns a server-minted handle (MCP revision 2026-07-28), keep it in a variable and pass it to the next call; never print it.
- The ledger marks a done call `(read-only)` when the engine's result carries `isReadOnly`.

### Decision

- Guidance and marking only. No retry guard in the mod: the mods API exposes no `idempotentHint` or `destructiveHint`, and no measurement has shown a duplicate yet (issue 0006). The owner chose this on 2026-10-07.
- An upstream request to expose those hints to mods is recorded in research 0002, not built here.

### Acceptance

- A done call whose result has `isReadOnly` renders with `(read-only)`; one without it renders as today.
- The description carries the idempotency and search guidance within its caps.

### Plan

One slice.
