---
type: Issue
title: The codemode tool declares the four MCP tool hints once the mods API takes them, and a check tells the day it does
description: A quality scan asks for readOnlyHint, destructiveHint, idempotentHint and openWorldHint on codemode; build 2.1.296's $.tool.register takes none, so the values are recorded, a check watches the declarations, and a request to Anthropic is drafted.
status: open
timestamp: 2026-10-10T13:20:00Z
---

## 0016. The codemode tool declares the four MCP tool hints once the mods API takes them, and a check tells the day it does

A quality scan of the plugin, read on 2026-10-10, reports two items on the `codemode` tool: no tool carries a read-only or destructive annotation, "so hosts can warn users before invoking", and the tool misses all four hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), which OpenAI's directory rejects when any is missing or non-boolean. The hints are the MCP `ToolAnnotations` of [research 0002](/research/0002-what-the-mcp-specification-recommends-for-tool-errors-annotations-structured-output-and-client-safety-and-how-codemode-stands.md), where the mods API was found to expose none of them for nested calls. This issue is about the registered tool itself.

Verified on 2026-10-10:
- `ToolSpec`, what `$.tool.register` takes, holds `name`, `description` and `inputSchema` in the committed declarations (`.claude-plugin/types/claude-code/index.d.ts`, written by build 2.1.291). No `annotations` field, and none of the four names appears in `ToolSpec`, `ToolInfo` or `ToolDescribeResult`.
- In the installed build 2.1.296, `$.tool.register` validates `name`, `description`, `inputSchema` and `isDeferred`, and forwards exactly those four to the `tool.register` event; any other field on the spec is dropped before the event fires. A hint passed today would fail the typecheck (an excess property on `ToolSpec`) and, past the types, would reach nothing.
- `tool.describe` answers `description` and `isDeferred` only, so a hook cannot add the hints after registration either.
- `claude plugin validate .` on 2.1.296 passes with the one known warning (the root `CLAUDE.md`).

What the four hints are for codemode, from the handler's behaviour (`hooks/register.ts`, `tool.call`):
- `readOnlyHint: false`. A script calls `Write`, `Edit`, `Bash` and MCP tools, so the tool modifies its environment whenever the script does.
- `destructiveHint: true`. A nested `Write` replaces a file, `Bash` runs any command, an MCP tool may delete. The guard is the permission check each nested call takes, not the hint.
- `idempotentHint: false`. The same script run twice repeats its nested calls; the failure ledger of issue 0006 exists because a rerun is not free.
- `openWorldHint: true`. Nested calls reach the session's MCP servers and, through `Bash`, the network.

All four equal the MCP defaults for an absent annotation, so a host that reads the defaults already treats codemode as the hints would say. The scan wants them explicit, which the mods API does not allow yet.

### Scope

Included:
- The four values above, recorded here and in the README, with the reason each holds.
- A check in the invariants spec that reads the installed build's `ToolSpec` declaration: it passes while `ToolSpec` takes no hint and `register.ts` declares none, and fails naming this issue on the first build whose `ToolSpec` takes a hint that `register.ts` does not declare. It also fails when `register.ts` declares a hint the build does not take, since the engine would drop it silently.
- A request to Anthropic for `annotations` on `ToolSpec`, drafted here for the owner to file.

Out:
- The hints of nested tools, read by the ledger as `isReadOnly` (issue 0008); the missing `idempotentHint` and `destructiveHint` for them stay the research 0002 request.
- The other items of the scan, not yet in this repository; each gets its own issue when its text is at hand.
- A warning of the mod's own before a codemode call: the engine's permission check already prompts per nested call, which is what the hints exist to enable.

### Decision

Not load-bearing: nothing here is expensive to reverse, so it lives in this issue. **B, record the values, add the check and draft the request**, over:
- A, declare the hints now: impossible as the types stand, and a hint the engine drops would claim a declaration the model's host never sees.
- C, note the gap and do nothing: the scan returns on every run, and nobody would notice the day the API takes the hints.

The declarations file is rewritten by the engine each time it loads the mod from the owner's folder, so the check runs against the build the owner actually uses.

### Acceptance

- C1: `npm test` passes on the committed declarations, and a stand-in `ToolSpec` that takes `annotations` or any of the four hints fails the check with a message naming this issue, unless `register.ts` declares the hints it takes.
- C2: the README states the four values and why they are not declared.

### Plan

1. The values, the check and the README note (this change).
2. The request to Anthropic: drafted below, filed by the owner.

### Request to Anthropic (draft)

For the owner to file, through `/feedback` or the Claude Code issue tracker; not sent from here.

> **Mods API: let `$.tool.register` carry MCP tool annotations.**
> In builds 2.1.291 and 2.1.296, `ToolSpec` takes `name`, `description`, `inputSchema` and `isDeferred`; `tool.describe` answers `description` and `isDeferred`. A mod's tool therefore cannot declare `readOnlyHint`, `destructiveHint`, `idempotentHint` or `openWorldHint`, the MCP `ToolAnnotations` that tool directories now require on every tool and that hosts use to warn before a call. Asked: an optional `annotations` field on `ToolSpec` with the four booleans and `title`, kept on the registered tool so `$.tool.list()` and `tool.describe` see it, and read by the permission check the way an MCP server's declaration is (`isReadOnly` on the call's result).

### Results

Slice 1 shipped on 2026-10-10. The invariants spec holds `hintsProblem`, which reads the `ToolSpec` block of the installed declarations and compares the hints it takes with those `register.ts` declares; the real tree passes and five stand-in cases cover a build that takes all four, one that takes two, a registration with no hints against either, a registration with hints against a build that takes none, and declarations with no `ToolSpec`. The README carries the four values under "How it works". `register.ts` is unchanged. Slice 2 waits on the owner.
