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
- Pi's four modes, as Pi's MCP guide (`packages/coding-agent/docs/mcp.md`, "Control tool exposure", read 2026-10-07) defines them:

  | Mode | Pi's meaning | In this mod |
  |---|---|---|
  | `codemode` | Callable from scripts; neither declared to the model nor listed in the codemode description. `codemode-deferred` is an alias. | Probe layers 1 to 3 below. A direct call that still happens runs, as in Pi, where a tool loaded by `tool_search` is callable. |
  | `deferred` | Not declared until `tool_search` loads it; also callable from scripts. | `isDeferred: true` in `tool.describe`; the name stays in `deferred_tools_delta`. |
  | `direct` | Declared like a built-in tool and callable from scripts. | `isDeferred: false` in `tool.describe`. |
  | `hidden` | Registered but unreachable. | Layers 1 to 3, a `tool.check` deny on every origin, scripts included, and the tool left out of the codemode description and of `ALL_TOOLS`. |

- Per-tool modes, Pi's `toolExposure`: a list entry names a server (`codegraph`) or a server and a tool pattern where `*` matches any characters (`claude_ai_Gmail__trash_*`).
- The setting that assigns them, and a server it does not name, which keeps Claude Code's own placement and stays callable from scripts, as today.
- The `codemode` layers proven by the probe: drop the tool's name from the `deferred_tools_delta` attachment (1); answer `isDeferred: true` in `tool.describe` (2); prefix the tool's description with a codemode-only note and add one line to the `mcp_instructions_delta` attachment (3). The probe's fourth layer, a `tool.check` deny of the `engine` origin, is not taken (see Decision).
- `mcp__codemode__codemode` itself never takes a mode.

Out:
- The output size budget, which is [issue 0012](/issues/0012-a-codemode-result-over-a-size-budget-returns-its-head-and-tail-to-the-model-and-keeps-the-whole-output-in-a-file.md).
- Pi's `mcp_servers` system prompt section: the `mcp_instructions_delta` line of layer 3 does its work here.
- Pi's rule that the resource tools take the widest exposure: Claude Code's `ListMcpResourcesTool` and `ReadMcpResourceTool` are built-in tools, not a server's.
- `searchTools()` and `describeTool()`, which this mod's scripts do not have.

### Decision

Confirmed by the owner, 2026-10-07:
- **Pi's four modes per server**, not one on/off switch with an exemption list. The switch was what the probe used; the modes give parity with Pi.
- **Set in Claude Code's settings; nothing set keeps Claude Code's default.** This differs from Pi, whose default is `codemode`: installing the mod changes no server's exposure until the owner names it.
- **The setting's shape:** the manifest's `userConfig`, stored in settings.json `pluginConfigs.codemode.options` and drawn by `/config`. A field holds only a string, number, boolean or string list, not a map, so there is one list of server names per mode (for example `mcpCodemode: ["claude_ai_Gmail", "codegraph"]`). Not taken: a custom top-level settings key read with `$.settings.read`, which `/config` does not draw or validate. A server named in two lists fails the load with a message naming it.

Confirmed by the owner, 2026-10-07, after reading Pi's guide:
- **A direct call to a `codemode` tool runs, as in Pi.** Layers 1 to 3 keep the model from seeing the tool; the probe's run with them made no direct call. Not taken: the `tool.check` deny of the `engine` origin, stricter than Pi. `hidden` still refuses every call.
- **Per-tool modes go in the same lists.** An entry naming an exact tool wins over a pattern, and a pattern over a bare server name, as in Pi. Not taken: server-only modes, with per-tool left for later.
- **A `codemode` tool stays in the codemode description's sections**, unlike Pi: this mod's scripts have no `searchTools()` or `describeTool()`, and the sections let the model find a tool without spending a call on `ALL_TOOLS`. A `hidden` tool is left out.

Found on 2026-10-07 with a throwaway plugin installed in build 2.1.292: the manifest has no list type, and `claude plugin validate` accepts a list only as `"type": "string", "multiple": true`. `/config` draws a plugin's choice, boolean and text fields but not a `multiple` one, and draws nothing for a `--plugin-dir` plugin. `/plugin configure <plugin>` draws it as one text line and stores what is typed as one string (`"codegraph, claude_ai_Gmail"`), which `register` receives as a string. So each setting is read as either a list or one comma-separated string.

Confirmed by the owner, 2026-10-07, after the slice 3 e2e: **`deferred` keeps its limit.** The hook answers `isDeferred: true`, but with `ENABLE_TOOL_SEARCH=auto` the engine lists the small stand-in server up front and ignores that answer: the tool's schema stays in the request and the model called it directly, with no ToolSearch. Where the engine already defers a tool (`ENABLE_TOOL_SEARCH=true`), the mode changes nothing. The mods API cannot drop a schema from the request, so `deferred` takes effect only for a tool the engine is willing to defer; its proof is the kit test of the describe answer, and no e2e scenario claims more. Not taken: also removing the tool's `<function>` line from the always-loaded block, which would hide the text while the schema stays callable; and dropping the mode.

Settled for the build, cheap to reverse: when two patterns from different lists match one tool, the lists are read in the order `mcpHidden`, `mcpCodemode`, `mcpDeferred`, `mcpDirect`, each in its written order, and the first match wins; `hidden` first fails safe. The same entry in two lists fails the load.

### Acceptance

- With no mode set, every MCP tool is placed and callable exactly as without this change: the existing e2e scenarios pass unchanged.
- A server set to `codemode`: on a prompt that does not name codemode and needs its tool, the model makes no direct call and calls it from a codemode script, in at least 4 of 5 runs.
- A script's call to a `codemode` tool runs and returns the server's result, and a deny rule on the tool still refuses it.
- A server set to `deferred`, `direct` or `hidden` shows Pi's behavior for that mode, each proven by a scenario; a `hidden` tool is refused from the model and from a script, and the server never runs.
- A per-tool entry overrides its server's mode, and an exact tool name wins over a pattern.
- A subagent's view of a `codemode` tool is recorded: whether it sees the tool and how it reaches it.
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

1. Read Pi's four modes from its source and record each one's meaning here. Done 2026-10-07, in Scope.
2. The `userConfig` fields (slice 1 done 2026-10-07: `hooks/exposure.ts` › `readExposure`, `modeOf`; tests in `test/node/exposure.spec.ts` and `test/codemode.test.ts`), then the `codemode` mode (slice 2 done 2026-10-07: `hooks/expose.ts` › `registerExposure`, `exposureSync`; the null-text guard in its `prompt.attachment` hook has no test, because the plugin kit never hands a hook a null text, so a test of it cannot fail) from the four probe hooks, then the other three modes, each with red-first tests in the plugin kit and an e2e scenario on the stand-in server.
3. The adoption run of [issue 0004](/issues/0004-the-model-picks-codemode-on-its-own-because-the-tool-is-declared-up-front-described-like-pi-s-and-named-in-one-system-prompt-line.md), with an MCP prompt, for the 4-of-5 criterion, plus control runs of the same prompt with no mode set, since the e2e scenario "mcp codemode mode" alone cannot show the model would otherwise call the tool directly; then the subagent case.
