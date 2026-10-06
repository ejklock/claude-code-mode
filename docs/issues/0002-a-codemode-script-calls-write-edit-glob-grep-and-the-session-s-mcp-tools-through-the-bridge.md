---
type: Issue
title: A codemode script calls Write, Edit, Glob, Grep and the session's MCP tools through the bridge
description: Widens the script's tools from Read and Bash to the file-writing built-ins and every connected MCP tool, each still through $.tool.call.
status: open
timestamp: 2026-10-06T15:00:30Z
---

## 0002. A codemode script calls Write, Edit, Glob, Grep and the session's MCP tools through the bridge

Extends [ADR 0001](/adr/0001-a-claude-code-mod-hosts-the-pi-codemode-runtime-in-a-node-child-process-and-routes-every-nested-call-through-the-session-s-tool-call.md) past the pilot's two tools. Today a script can only read and run shell commands, so a real coding task still calls Write, Edit and MCP tools one model turn at a time. The owner asked for this before more demos (2026-10-06). It builds on [issue 0001](/issues/0001-a-prototype-runs-a-script-that-calls-read-and-bash-through-the-mod-and-measures-the-child-process-overhead.md)'s bridge and needs its slice 1 merged first.

A constraint shapes the design. In build 2.1.291, `$.tool.list()` returns only `{ name, description, mcp }`, with no input schema. The `$.mcp` noun offers only `call` (forbidden here) and `connect`. So the mod cannot read an MCP tool's input schema at run time. The engine writes MCP input types only to `.claude-plugin/types/claude-code-mcp/index.d.ts`, at a save of the mod with a server connected.

### Scope

Included:
- The built-ins `Write`, `Edit`, `Glob` and `Grep` as `tools.*`, with declarations taken from the build's `claude-code-tools` types.
- Every MCP tool connected in the session, discovered with `$.tool.list()` at the start of each codemode call.
- Every nested call still runs through `$.tool.call`, with its own permission check.

Out:
- `Agent`, interactive tools (`AskUserQuestion`, plan mode), and `codemode` itself (no nesting).
- `store()`/`load()`, tool search, the declarations budget, and the task-level measurement. Each is a later issue.

### Decision

Confirmed by the owner, 2026-10-06:
- **MCP declarations:** each MCP tool is declared with its description and an open argument object, because no schema is available at run time. The model already sees the MCP tool's real schema in its own tool list. The option not taken is to parse the engine-written `claude-code-mcp` types, which is fragile and present only after a save with servers connected.
- **MCP naming:** the flat name, `tools.mcp__server__tool(args)`, built with `toCodemodeIdentifier`, and `tools["<name>"](args)` too, exactly as Pi does. Corrected by the owner on 2026-10-06: the first decision chose `tools.<server>.<tool>` believing it was Pi's form, but Pi's tools stay flat (pi-codemode 1.0.4 `runtime/prelude-source.js:208-218`), and a namespace only groups sections in the description. The option not taken is a nested object built by our child, which diverges from Pi.
- **Order:** this issue comes before issue 0001's slice 2 (the overhead measurement), so richer demos come first.

Found during slicing, 2026-10-06:
- **Glob and Grep do not exist in build 2.1.291.** The build's `claude-code-tools` types list `Write` and `Edit` but no `Glob` or `Grep`; search goes through `Bash`. Slice 1 is therefore `Write` and `Edit`. Glob and Grep join if a later build brings them back.
- **The description is capped.** The build sends at most 2,048 characters of any tool's description to the model. The codemode description must stay under that as tools are added. Like Pi's inline budget, a tool that does not fit is still callable and listed in `ALL_TOOLS`, but it gets no section in the description.
- **The budget follows Pi.** Confirmed by the owner after the slice 1 review: when sections do not fit, the description behaves as Pi's `createCodemodeDescription` does, with no warning about the limit and no error. Slice 2 adopts Pi's selection for MCP tools: the cheapest section first, one per group in turn, and a namespace heading marked `(some tools not listed)` or `(tools not listed)`. Slice 1 keeps its order-based drop, which leaves a bare "Nested tools:" header when nothing fits, as Pi's does.
- **Tool sections move to the input schema, with Pi's 3,000-token budget.** The owner asked for Pi's budget. The engine cuts a tool's description at 2,048 characters, but sends its `inputSchema` whole, so in slice 2 the description keeps the intro and the globals under 2,048, and the tool sections go into the `code` parameter's description, within 3,000 estimated tokens (characters ÷ 4) as in Pi. Options not taken: the sections in the system prompt (issue 0004 rejected a longer prompt section) and keeping the 2,048 cap. Slice 2 proves the model still reads them: the adoption count of issue 0004 does not drop.
- **Slices:** slice 1 adds `Write` and `Edit`, with a proof that the session's permission mode and rules hold for a script's edits. Slice 2 adds the MCP tools.

### Acceptance

- A script that writes a file with `tools.Write`, edits it with `tools.Edit`, finds it with `tools.Glob` and `tools.Grep`, and reads it back returns the final content in one tool result.
- A script calls a connected MCP tool by its namespaced name and gets the tool's text result. A deny rule on that MCP tool reaches the script as a denial.
- The declarations the child receives list only the connected tools: a disconnected server's tools are absent.
- No source file calls `$.mcp.call`. Proof: the existing invariants check still passes.
- A live demo is recorded here: a coding task in a scratch folder that uses MCP, writes and reads in one script. **Recorded 2026-10-06** (build 2.1.291, `claude -p`, `--plugin-dir` this repo, `--mcp-config` with `@modelcontextprotocol/server-memory@2026.8.31` writing its graph under `$TMPDIR`, `--strict-mcp-config`, rules allowing `Read`, `Write`, `Edit`, the codemode tool and four memory tools):
  - the prompt: "In this folder, write three short notes, ada.md, grace.md and linus.md, one sentence each about that person. Then record each person as an entity of type person in the memory knowledge graph, with that sentence as its observation. Finally read the graph back and tell me which entities it holds and that each file exists." It does not name codemode;
  - the model made one `mcp__codemode__codemode` call and no other tool call. The script wrote the three files with `tools.Write` under `Promise.allSettled`, called `tools.mcp__memory__create_entities` and `tools.mcp__memory__read_graph`, and listed the files with `tools.Bash`;
  - the result: 2 turns, 11.9 s, 0.079 USD; the graph file on disk holds the three `person` entities with their observations, and the three files exist with the same sentences;
  - **A server that connects after `session.start`**, shown in an interactive session on 2026-10-06 (build 2.1.291, the same config): `/mcp` disabled the memory server, and the prompt "With one codemode script, print the names in ALL_TOOLS that contain the word memory, and how many there are." printed `(none)` and `Count: 0`. After `/mcp` enabled the server again, the same prompt printed the nine `mcp__memory__*` names and `Count: 9`. This proves the per-run discovery: `ALL_TOOLS` comes from the `$.tool.list()` the mod reads when each script starts, so a server that connects later is callable at once. It does not prove the re-register at `turn.start`, because `ALL_TOOLS` does not come from the registered schema; whether the model's next request carries the new sections stays unshown.
- Slice 2b, the sections in the `code` parameter's description, within 3,000 estimated tokens and following the connected tools:
  - adoption, `node scripts/adoption.ts` with 5 runs on 2026-10-06 (no change from issue 0004): codemode used in 5 of 5 valid runs, every run called `mcp__codemode__codemode` only;
  - the mod registers at `session.start` and again at `turn.start` only when the rendered sections differ from the last registered, so the prompt cache is spent on a change alone;
  - the e2e scenario `mcp from the schema` passes: a headless run asked, without the tool's name, for the connected echo tool's answer got `fake-echo: e2e-ping-31` from a script that named `mcp__fake__echo`. The request's tool definition cannot be read from the headless stream, and the model also holds the MCP tool's own definition, so the scenario does not isolate the `code` text as the source of the name.

### Plan

1. The tool registry: the mod builds the exposed tool list (the static built-in declarations, plus `$.tool.list()` MCP entries) and sends it to the child in the run request.
2. The child declares those tools in `CodemodeSandbox`, with MCP tools in namespaces.
3. Tests at each layer (plugin kit, `node --test`, headless e2e with a real MCP server), then the live demo.
