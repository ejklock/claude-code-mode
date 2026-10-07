---
type: Issue
title: Each MCP server takes one of Pi's four exposure modes from the plugin settings, and an unset server keeps Claude Code's default
description: Pi's codemode, deferred, direct and hidden modes per MCP server, set in settings.json pluginConfigs; a server with no mode behaves as Claude Code does today.
status: open
timestamp: 2026-10-07T17:11:16Z
---

## 0011. Each MCP server takes one of Pi's four exposure modes from the plugin settings, and an unset server keeps Claude Code's default

Extends [ADR 0001](/adr/0001-a-claude-code-mod-hosts-the-pi-codemode-runtime-in-a-node-child-process-and-routes-every-nested-call-through-the-session-s-tool-call.md) and [issue 0002](/issues/0002-a-codemode-script-calls-write-edit-glob-grep-and-the-session-s-mcp-tools-through-the-bridge.md). Pi gives each MCP server one of four exposure modes, and its default, `codemode`, makes a tool callable from scripts but not declared to the model ([research 0001](/research/0001-pi-codemode-and-how-to-host-it-in-claude-code.md)). Today this mod leaves every MCP tool visible to the model as well, so the model may call one directly, one turn per call. The owner asked for Pi's modes on 2026-10-07.

The mods API in build 2.1.292 cannot drop a tool from the model's request. The probe below shows four hooks that, together, make the model reach a codemode-only MCP tool through a script alone.

### Scope

Included:
- Pi's four modes per MCP server: `codemode` (callable from scripts, hidden from the model), `deferred` (behind ToolSearch), `direct` (in the model's main list) and `hidden`. The exact meaning of each, `hidden` above all, is read from Pi's source before building, and the mod follows it.
- The setting that assigns them, and a server it does not name, which keeps Claude Code's own placement and stays callable from scripts, as today.
- For `codemode`, the four layers proven by the probe: drop the tool's name from the `deferred_tools_delta` attachment; answer `isDeferred: true` in `tool.describe`; prefix the tool's description with a codemode-only note and add one line to the `mcp_instructions_delta` attachment; deny in `tool.check` a call whose `next.origin.plugin` is `engine`.
- `mcp__codemode__codemode` itself never takes a mode.

Out:
- The output size budget, which is [issue 0012](/issues/0012-a-codemode-result-over-a-size-budget-returns-its-head-and-tail-to-the-model-and-keeps-the-whole-output-in-a-file.md).

### Decision

Confirmed by the owner, 2026-10-07:
- **Pi's four modes per server**, not one on/off switch with an exemption list. The switch was what the probe used; the modes give parity with Pi.
- **Set in Claude Code's settings; nothing set keeps Claude Code's default.** This differs from Pi, whose default is `codemode`: installing the mod changes no server's exposure until the owner names it.
- **The setting's shape:** the manifest's `userConfig`, stored in settings.json `pluginConfigs.codemode.options` and drawn by `/config`. A field holds only a string, number, boolean or string list, not a map, so there is one list of server names per mode (for example `mcpCodemode: ["claude_ai_Gmail", "codegraph"]`). Not taken: a custom top-level settings key read with `$.settings.read`, which `/config` does not draw or validate. A server named in two lists fails the load with a message naming it.

### Acceptance

- With no mode set, every MCP tool is placed and callable exactly as without this change: the existing e2e scenarios pass unchanged.
- A server set to `codemode`: on a prompt that does not name codemode and needs its tool, the model makes no direct call and calls it from a codemode script, in at least 4 of 5 runs.
- A direct call to a `codemode` tool that still happens is refused, its reason names `tools.<name>(args)`, and the server never runs.
- A script's call to a `codemode` tool runs and returns the server's result, and a deny rule on the tool still refuses it.
- A server set to `deferred`, `direct` or `hidden` shows Pi's behavior for that mode, each proven by a scenario.
- A subagent's direct call is recorded: either refused like the main loop's, or the hook lets a subagent without codemode through.
- No source file calls `$.mcp.call`; the invariants check passes.

### Probe

2026-10-07, Claude Code 2.1.292, model claude-opus-5-5, `claude-klock` interactive with `--plugin-dir` on a throwaway copy of the mod; hooks at the end of its `hooks/register.ts`.

- **Origin.** A headless run with the stand-in server: the model's direct `mcp__fake__echo` reached `tool.check` with `next.origin` `{"plugin":"engine","tier":"core"}`, and the script's call with `{"plugin":"codemode","tier":"user"}`. Denying `engine` refused the direct call before the server ran; the script got `OK fake-echo: bridge-2`. The engine's own verdict was `allow` on both.
- **Real servers, `tool.check` alone.** On "Which topics does the Claude Docs guide offer? And how many Gmail labels do I have?", the model called `mcp__claude_ai_Claude_Docs__guide` directly, was refused, then used codemode.
- **Plus the attachment filter and `isDeferred: true`.** `deferred_tools_delta` fell from 3,978 to 552 characters, with no codemode-only name left, and the model found the Gmail tools only through `ALL_TOOLS`. The direct `guide` call still happened: the engine ignores `isDeferred: true` for a server's always-loaded tools (Claude Docs `batch`, `guide`, `update`), whose schemas ride the request's tool list, and the server's instructions tell the model to call `guide(...)` first.
- **Plus the description note and the instructions line.** The model made no direct call: it ran `guide` from a codemode script (655 ms), then Gmail from a second script.
- **Not shown.** A subagent's origin: auto mode refused the probe's Agent call as `[Auto-Mode Bypass]`. Whether a ToolSearch keyword query still finds a hidden tool. One run per layer, so no rate is claimed.
- **Unrelated finding.** Gmail, Calendar and Drive answered `needs to be connected in claude.ai` to a direct call as well; it is the account's connector state, not the bridge.

### Plan

1. Read Pi's four modes from its source and record each one's meaning here.
2. The `userConfig` fields, then the `codemode` mode from the four probe hooks, then the other three modes, each with red-first tests in the plugin kit and an e2e scenario on the stand-in server.
3. The adoption run of [issue 0004](/issues/0004-the-model-picks-codemode-on-its-own-because-the-tool-is-declared-up-front-described-like-pi-s-and-named-in-one-system-prompt-line.md), with an MCP prompt, for the 4-of-5 criterion; then the subagent case.
