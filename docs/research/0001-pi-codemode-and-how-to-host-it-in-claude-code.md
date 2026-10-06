---
type: Research
title: Pi codemode and how to host it in Claude Code
description: What Pi's codemode is, what it measured, and which Claude Code host form can offer the same script API under the session's permission checks.
status: Draft
timestamp: 2026-10-06T14:08:54Z
---

# 0001. Pi codemode and how to host it in Claude Code

## Question

Can Claude Code offer the same codemode tool as Pi 1.0 (a model-written JavaScript script that calls the session's tools and returns only its output), with the same script API, with the session's MCP servers exposed as a typed API, and with every nested call still under Claude Code's permission checks and hooks? Which host form does it, and what is still unproven? It motivates [ADR 0001](/adr/0001-a-claude-code-mod-hosts-the-pi-codemode-runtime-in-a-node-child-process-and-routes-every-nested-call-through-the-session-s-tool-call.md).

The owner's three goals: fewer tokens and turns per task, MCP servers as a typed API, and parity with Pi so one procedure runs the same in both harnesses.

## Method

Read on 2026-10-06. Pi from the installed package `@earendil-works/pi-coding-agent` v1.0.4 (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`) and from the `earendil-works/pi` repository on GitHub. Claude Code from code.claude.com and from the mods type declarations of the installed build 2.1.291 (`claude-code.d.ts`, the `global` block that lists a hooks module's environment). Prior art from the vendors' own posts. No code was run and no savings were measured.

## Findings

| Finding | Evidence | Confidence |
|---|---|---|
| Codemode lets the model write a JavaScript script that calls Pi's other tools; only the script's output reaches the model, so a script can run calls in parallel and filter large results. | [1] | high |
| Codemode shipped in Pi 0.99.0 (2026-09-29); 1.0.0 (2026-10-01) made it leaner. The packages are published as `@earendil-works/*`; `badlogic/pi-mono` redirects to `earendil-works/pi`. | [3], [6] | high |
| The stated motivation is models like Earendil's Jev, "which work much better with a sandbox that composes tools than with plain tool calls"; the tool is compatible with Codex's `exec` tool. | [2] | high |
| The script runs as the body of an async function in QuickJS compiled to WebAssembly, inside a worker, with no Node APIs, file system, network or timers. The runtime is the MIT package `@earendil-works/pi-codemode`, which has no Pi dependencies. | [1], [3] | high |
| Each tool is `tools.<name>(args)`. TypeScript declarations are generated from JSON Schema and only shape the declarations; values are not validated. Discovery: `searchTools()` (BM25), `describeTool()`, `describeNamespace()`, `ALL_TOOLS`. The inline declarations share a 3000-token budget (`codemode.inlineBudget`). | [3] | high |
| A script can call every tool the session can call; Pi's built-in tools are read, bash, powershell, edit, write, grep, find and ls. An Agent tool comes only from an extension (inferred). | [1], [4] | high (built-ins), medium (Agent) |
| `bash` resolves to `{output, exit_code, …}` with up to 1 MiB of output; an MCP tool resolves to its full `CallToolResult`. | [1] | high |
| MCP servers have four exposure modes: `codemode` (default: callable from scripts, not declared to the model), `deferred` (through `tool_search`), `direct` and `hidden`. Scripts get the complete result; the model sees text over 20 KB with its middle removed. | [5] | high |
| `store()`/`load()` keep JSON values (256 Ki characters each, 1 Mi total). Writes are kept only when the script succeeds and are appended as `codemode-store` session entries, so a resumed session keeps them and each branch sees only its own path. | [1] | high |
| Limits: output capped by `max_output_tokens` (default 10000); `timeout_ms` unset by default; 256 MB VM; no nested codemode; frozen built-ins. Tool calls are real: calls made before a failure are not undone. | [1] | high |
| Nested calls pass through Pi's `tool_call`/`tool_result` hooks and carry `parentToolCallId`. | [5] | high |
| Pi's only published saving is codemode's own prompt overhead (a GPT-5.6 request shrinks from about 5,300 to 3,300 tokens). No measured task-level token or turn saving was found from Pi or Earendil; the launch posts give demos only. | [6], [7], [8] | high |
| Cloudflare Code Mode turns MCP schemas into a TypeScript API run in V8 isolates; it gives no numbers. Anthropic's "150,000 to 2,000 tokens" is an illustrative scenario, not a benchmark. Anthropic's Programmatic Tool Calling measures 43,588 to 27,297 tokens (37%), but it is a Claude API beta, not a Claude Code feature. UTCP cites a third-party 67–88% fewer iterations. Each source sells the approach; none was checked independently. | [10], [11], [12], [21] | medium |
| A Claude Code plugin can ship an MCP server with one execute tool, but that process cannot call Claude Code's built-in tools; spawning `claude mcp serve` reaches them while skipping the user's permission prompts. | [13], [14], [22] | high |
| Plain settings hooks consume tools and cannot register one. | [15] | high |
| A mod registers a tool with `$.tool.register` (named `mcp__<plugin>__<name>`, answered by a `tool.call` hook). `$.tool.call` runs a built-in tool through every other hook, the permission check and its dialog; an Agent call is supported. `$.mcp.call` uses the session's MCP connections with no permission prompt. | [16], [17] | high |
| A mod's hooks module has no WebAssembly, no `eval` and no `new Function`, deliberately; the type declarations say a module that needs compiled code runs it in a process of its own through `$.process.run`. So QuickJS cannot run inside the mod. | [17] (the `global` block of the hooks module) | high |
| `$.process.spawn` takes its standard input as one string, and `$.http.fetch` accepts a `socketPath`; a child process can therefore receive each tool result over a Unix socket it listens on. Not yet run. | [17] | medium |
| Ready-made code-mode MCP servers (UTCP `code-mode`, `cmcp`, `lootbox`, `codemode-mcp`, `mcp-code-mode`) cannot call Claude Code's built-in tools. | [18], [19], [20], [21], [23] | high |
| Claude Code workflows orchestrate subagents only; the script has no file system or shell access. | [24] | high |
| Claude Code's sandbox covers shell commands only; file tools, MCP servers and hooks run outside it. Mod code runs with the user's permissions, and the mods surface is marked early access and may change without notice. Pi has no sandbox beyond the QuickJS VM. | [9], [16], [25] | high |

## Implications

- Only a mod meets all three goals: it reaches the built-in tools, the Agent tool and the MCP servers through `$.tool.call`, which keeps Claude Code's permission checks and hooks on each nested call.
- Reusing `@earendil-works/pi-codemode` keeps the script API identical to Pi's (`tools.*`, `text`, `store`, `load`), which is the parity goal.
- Since the mod environment has no WebAssembly, the runtime must run in a child process (Node), with a bridge back to the mod for each tool call. The bridge's latency is the first unknown to measure.
- `$.mcp.call` must not carry nested calls, because it skips the permission prompt.
- The token and turn saving is a hypothesis: no source measured it on real tasks. The pilot must measure it before the goal is claimed.

## Open Questions

- The cost of one bridged tool call (child process start, round trip per call), and whether a long-lived child is needed.
- Whether `$.tool.call` returns built-in tool results in a shape a script can use (structured, or text only).
- Where `store()` writes persist in Claude Code, which has no Pi session entries.
- How Claude Code's tool search and deferred MCP definitions interact with codemode's declarations budget.
- The measured task-level saving in tokens and turns against the same tasks without codemode.
- The official list of tools `claude mcp serve` exposes; only a bug report lists them [22].

# References

[1] [Pi codemode doc (v1.0.4)](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md). Available at: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md. Accessed on: 2026-10-06.

[2] [Pi PR #10040](https://github.com/earendil-works/pi/issues/10040). Available at: https://github.com/earendil-works/pi/issues/10040. Accessed on: 2026-10-06.

[3] [pi-codemode README](https://github.com/earendil-works/pi/tree/main/packages/codemode). Available at: https://github.com/earendil-works/pi/tree/main/packages/codemode. Accessed on: 2026-10-06.

[4] [Pi settings doc](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md). Available at: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md. Accessed on: 2026-10-06.

[5] [Pi MCP doc](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md). Available at: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md. Accessed on: 2026-10-06.

[6] [Pi changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md). Available at: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md. Accessed on: 2026-10-06.

[7] [Earendil, "Pi 1.0"](https://earendil.com/posts/pi-1-0/). Available at: https://earendil.com/posts/pi-1-0/. Accessed on: 2026-10-06.

[8] [Earendil, "You said no MCP"](https://earendil.com/posts/you-said-no-mcp/). Available at: https://earendil.com/posts/you-said-no-mcp/. Accessed on: 2026-10-06.

[9] [Pi security doc](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md). Available at: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md. Accessed on: 2026-10-06.

[10] [Cloudflare, Code Mode](https://blog.cloudflare.com/code-mode/). Available at: https://blog.cloudflare.com/code-mode/. Accessed on: 2026-10-06.

[11] [Anthropic, Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp). Available at: https://www.anthropic.com/engineering/code-execution-with-mcp. Accessed on: 2026-10-06.

[12] [Anthropic, Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use). Available at: https://www.anthropic.com/engineering/advanced-tool-use. Accessed on: 2026-10-06.

[13] [Claude Code plugin manifest reference](https://code.claude.com/docs/en/plugins-reference). Available at: https://code.claude.com/docs/en/plugins-reference. Accessed on: 2026-10-06.

[14] [Claude Code MCP doc](https://code.claude.com/docs/en/mcp). Available at: https://code.claude.com/docs/en/mcp. Accessed on: 2026-10-06.

[15] [Claude Code hooks doc](https://code.claude.com/docs/en/hooks). Available at: https://code.claude.com/docs/en/hooks. Accessed on: 2026-10-06.

[16] [Claude Code mods API guide](https://code.claude.com/docs/en/plugins/mods/api). Available at: https://code.claude.com/docs/en/plugins/mods/api. Accessed on: 2026-10-06.

[17] [Claude Code mods type declarations](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts). Available at: https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts. Accessed on: 2026-10-06.

[18] [assimelha/cmcp](https://github.com/assimelha/cmcp). Available at: https://github.com/assimelha/cmcp. Accessed on: 2026-10-06.

[19] [jx-codes/lootbox](https://github.com/jx-codes/lootbox). Available at: https://github.com/jx-codes/lootbox. Accessed on: 2026-10-06.

[20] [jx-codes/codemode-mcp](https://github.com/jx-codes/codemode-mcp). Available at: https://github.com/jx-codes/codemode-mcp. Accessed on: 2026-10-06.

[21] [UTCP code-mode](https://github.com/universal-tool-calling-protocol/code-mode). Available at: https://github.com/universal-tool-calling-protocol/code-mode. Accessed on: 2026-10-06.

[22] [Claude Code issue 10031, the tools `claude mcp serve` exposes](https://github.com/anthropics/claude-code/issues/10031). Available at: https://github.com/anthropics/claude-code/issues/10031. Accessed on: 2026-10-06.

[23] [Edison-Watch/mcp-code-mode](https://github.com/Edison-Watch/mcp-code-mode). Available at: https://github.com/Edison-Watch/mcp-code-mode. Accessed on: 2026-10-06.

[24] [Claude Code workflows doc](https://code.claude.com/docs/en/workflows). Available at: https://code.claude.com/docs/en/workflows. Accessed on: 2026-10-06.

[25] [Claude Code sandboxing doc](https://code.claude.com/docs/en/sandboxing). Available at: https://code.claude.com/docs/en/sandboxing. Accessed on: 2026-10-06.
