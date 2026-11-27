---
type: Issue
title: Measure what a codemode script receives from the Skill tool, and expose it only if a script gains from it
description: Skill joins the exposed tools, and the issue records what the Skill tool returns to a script.
status: closed
timestamp: 2026-11-27T17:32:37Z
---

## 0021. Measure what a codemode script receives from the Skill tool, and expose it only if a script gains from it

The Claude Code 2.1.332 binary carries a client of the MCP Skills extension (`io.modelcontextprotocol/skills`): `strings ~/.local/share/claude/versions/2.1.332` shows "the host's copy of skills/list" and "skills/list failed; keeping previous skills". MCP skills therefore reach the session's Skill tool. A script cannot call it: `Skill` is not in `EXPOSED_TOOLS` (`shared/protocol.ts`).

### Scope

Included:
- A measurement, on the same harness as issue 0022, of what `$.tool.call` returns for `Skill`: an inline skill, a forked skill, and an MCP skill.
- `Skill` in `EXPOSED_TOOLS` only when the measurement shows the script receives something it can use.

Out:
- Calling `skills/list` or `skills/get` directly; the mods API sends no raw MCP request.

The typed result of `Skill` carries no skill body: `{success, commandName, allowedTools?, model?, status?, readOnly?}` (`.claude-plugin/types/claude-code-tools/index.d.ts`), and the body is expanded for the model (`skill.prompt`). A forked skill returns an `agentId` and may finish as a task notification.

### Decision

- **Expose `tools.Skill`**, over documenting the path that already works (`ReadMcpResourceTool` on a `skill://` URI). Not taken: abandoning Skill.
- **Measure first, expose only if a script gains from it**, after the advisor review of 2026-11-27 showed the result carries no body. Not taken: exposing it whatever the measurement shows.
- **Not exposed; the issue closes on its measurement.** An inline skill called from a script loses its body to both the script and the model, and a forked skill is the Agent tool by another door. Not taken: exposing it with a note that only forked skills are useful; exposing it as is.

### Acceptance

- C1: the Outcome carries the real result of an inline, a forked and an MCP skill call from a live script, with the command that produced it.
- C2: if exposed, `npm test` passes with a case where a script's `tools.Skill` reaches `$.tool.call`; if not, the Outcome states why and the issue closes.
- C3: `se-gates check` passes.

### Outcome

Measured on 2026-11-27 with Claude Code 2.1.332, headless (`claude -p --plugin-dir <copy> --output-format stream-json`), from a copy of the mod whose `EXPOSED_TOOLS` gained `Skill` and whose bridge also printed the full `$.tool.call` result. Logs kept under `$TMPDIR/probe/logs` for the session only.

- Inline project skill: the script receives `Launching skill: probe-inline` and `{ success: true, commandName }`. The skill body reaches neither the script nor the model (0 matches of the body marker in the stream). Control: a direct model call of `Skill` injects the body as a synthetic user message and the model follows it. Through `$.tool.call` an inline skill is lost.
- Forked skill (`context: fork`): the script receives the sub-agent's final answer, `{ success, commandName, status: "forked", agentId, result }`; the sub-agent ran in the foreground (`is_backgrounded: false`) before the codemode result. The body reaches only the sub-agent's prompt.
- MCP skill: not listed. The session sent the fixture `server/discover`, `resources/list` and `tools/list`, never `skills/list`, although the fixture declared `io.modelcontextprotocol/skills`; `Skill` answered "Unknown skill". Inference from the binary's strings: the MCP skills client sits behind a feature flag and an organisation policy that are off in this session.
