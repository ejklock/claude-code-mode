---
type: Issue
title: An MCP tool's section in codemode tells the model to load the tool's arguments with ToolSearch before a first call
description: Ends the guessing of an MCP tool's arguments inside codemode, which failed memory_write 231 times in 59 sessions; the mods API gives no input schema.
status: open
timestamp: 2026-10-09T08:56:26Z
---

## 0015. An MCP tool's section in codemode tells the model to load the tool's arguments with ToolSearch before a first call

Every MCP tool section in the `code` description says `tools.<id>(args)` "takes an open object of arguments" (`hooks/describe.ts`, `mcpSection`); the tool's input schema never reaches the model. With the owner's `mcpCodemode: ["*"]`, every MCP tool reaches the model only through codemode, so the model guesses the arguments and fails on the first try: agent-memory's `memory_write` failed 231 times in 59 sessions over 14 days.

Verified on 2026-10-09 against build 2.1.292:
- The mods API gives no MCP tool's input schema at run time. `ToolInfo`, what `$.tool.list()` returns, holds `name`, `description` and `mcp` only; `tool.describe` carries no schema either.
- `$.tool.list()` cuts an MCP tool's description to 300 characters: every long description in `ALL_TOOLS` is exactly 300. Neither this plugin nor pi-codemode 1.0.4 cuts it.
- When the model calls ToolSearch (`select:<name>`), it receives the tool's `<function>` block: the description capped near 2048 characters and the whole `parameters` schema. Seen in a live session on `mcp__agent-memory__memory_write`.
- A hook that calls ToolSearch through `$.tool.call` receives the names only, as the spike below measured: the schema is added when the result reaches the model.
- pi-codemode 1.0.4 exports `schemaToType(schema, { maxChars })` and `renderToolSignature`, Pi's JSON Schema to TypeScript rendering ([research 0001](/research/0001-pi-codemode-and-how-to-host-it-in-claude-code.md)), ready for the day the engine hands a hook the schema.

### Scope

Included:
- In each MCP tool's section, in place of "an open object of arguments", the instruction to load the tool's arguments with ToolSearch `select:<full name>` before a first call, within the 3000-token sections budget.
- The same rule once in the codemode tool's globals.
- A request to Anthropic for the input schema on `ToolInfo`, drafted here and filed by the owner.

Out:
- The built-in tools' sections, already declared from `TOOL_SPECS`.
- Validating a script's arguments against the schema; the tool's own validation stays the only one.
- The 300-character cut of `$.tool.list()`, the engine's; ToolSearch also gives the model the longer description.
- Declarations of the arguments inside the sections and in `ALL_TOOLS`: they wait until the engine gives a hook the schema.
- Changes to agent-memory's schemas, made in that repository.

### Decision

Confirmed by the owner, 2026-10-09, after the spike: **G, the section tells the model to load the tool's arguments with ToolSearch before a first call**, and **B, a request to Anthropic for `inputSchema` on `ToolInfo`**, in parallel. Options not taken:
- A, the hook reads each schema through `$.tool.call` to ToolSearch: the spike showed the hook gets the names only.
- C, each server words its arguments in its first 300 characters: only for servers we own, and only what fits.
- D, keep "an open object of arguments": no work, and the failures stay.

The first choice, A with declarations in Pi's `schemaToType` form, a 600-character inline rule and the whole declaration in `ALL_TOOLS`, returns as its own issue when the engine gives a hook the schema.

Settled with G, 2026-10-09:
- **The cost accepted:** one more model turn and the schema's tokens in context at the first use of each tool.
- **The name in the instruction:** the tool's full name as ToolSearch takes it (`mcp__agent-memory__memory_write`), not the script identifier (`mcp__agent_memory__memory_write`).
- **Sequencing:** the slice touches `hooks/describe.ts`, so it waits until issue 0014 (not yet on this branch) lands, and rebases on it.
- **The spike's code** (`hooks/schemas.ts`, its spec and `scripts/schema-probe.ts`) was removed: nothing in the engine feeds it. Its figures stay below.

### Acceptance

- Every MCP tool's section, in place of "an open object of arguments", tells the model to load the arguments with ToolSearch `select:<full name>` before a first call, and still says what the call resolves to. Cases: a name equal to its identifier; a name with `-` whose identifier differs, where `select:` carries the original name; a name holding a backtick, kept inert.
- The globals of the codemode tool's description state the rule once.
- The rendered sections stay within the 3000-token budget.
- Headless, with a stand-in MCP server whose tool needs an argument its description does not name, the model calls ToolSearch for that tool before its codemode call, and the first nested call to that tool succeeds.

### Plan

1. The section and globals text, with its e2e scenario (after issue 0014 lands).
2. The request to Anthropic: drafted in this issue for the owner to file.

### Request to Anthropic (draft)

For the owner to file, through `/feedback` or the Claude Code issue tracker; not sent from here.

> **Mods API: expose an MCP tool's input schema and whole description to hooks.**
> In build 2.1.292, `ToolInfo` from `$.tool.list()` holds `name`, `description` and `mcp`, and an MCP tool's description is cut to 300 characters. A mod that runs MCP tools from inside its own tool (here, a codemode tool after Pi's) cannot tell the model what arguments a tool takes, so the model guesses: one server's write tool failed 231 times in 59 sessions over 14 days. `$.tool.call` to ToolSearch returns the names only, because the schema is added when the result reaches the model. Asked: `inputSchema` (and `outputSchema`) on `ToolInfo` or on the `tool.describe` input, and the description uncut or with its cap documented.

### Spike

Measured 2026-10-09 on build 2.1.292, model claude-opus-5-5, with `node scripts/schema-probe.ts` (a headless `claude -p` run with a stand-in MCP server of two tools and a probe plugin whose hook calls ToolSearch through `$.tool.call`).

- `$.tool.call({ tool: "ToolSearch", query: "select:mcp__stub__long_tool,mcp__stub__small_tool", max_results: 2 })` is allowed and resolves, but to `{"result":{"matches":["mcp__stub__long_tool","mcp__stub__small_tool"],"query":"...","total_deferred_tools":14},"text":""}`: the tool names only and an empty `text`. The `<functions>` block with each tool's `parameters` is built when the engine turns the result into the model's tool_result, so a hook never receives it.
- The schema deep-equals `tools/list` for neither tool: no schema was read. The description length ToolSearch gave for the long tool: none read (the server sent 2891 characters).
- `isLoaded` before and after the call: `long_tool=false (1227 tokens)`, `small_tool=false (82 tokens)` both times. The call did not load the schemas, and it returned none.
- The next turn's tool list size is not in the json output; not measured.

Route A as written does not deliver a schema. The parser the spike wrote passed its unit cases against the `<functions>` form, but `$.tool.call` gives it no such text; the probe exited 1 with that cause. Both were removed afterwards.
