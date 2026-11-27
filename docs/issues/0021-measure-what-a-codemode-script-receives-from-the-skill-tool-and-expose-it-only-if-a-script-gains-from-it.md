---
type: Issue
title: Measure what a codemode script receives from the Skill tool, and expose it only if a script gains from it
description: Skill joins the exposed tools, and the issue records what the Skill tool returns to a script.
status: open
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

### Acceptance

- C1: the Outcome carries the real result of an inline, a forked and an MCP skill call from a live script, with the command that produced it.
- C2: if exposed, `npm test` passes with a case where a script's `tools.Skill` reaches `$.tool.call`; if not, the Outcome states why and the issue closes.
- C3: `se-gates check` passes.
