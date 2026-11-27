---
type: Issue
title: On an ask verdict the bridge can ask the user once per nested call in an interactive session
description: An opt-in dialog through $.ui.ask and the consent key, so a nested call the engine would ask about can run after approval instead of being refused.
status: open
timestamp: 2026-11-27T21:10:19Z
---

## 0031. On an ask verdict the bridge can ask the user once per nested call in an interactive session

Since issue 0029, a nested call whose engine verdict is `ask` is refused, because a plugin's `$.tool.call` in Claude Code 2.1.328 to 2.1.332 skips the mode's decider (the dialog, the auto-mode classifier) and `$.tool.check` asks neither. In an interactive session the owner may prefer one prompt per such call over a refusal. The mods API offers `$.ui.ask` (the engine's AskUserQuestion dialog; it rejects in a `-p` run) and the reserved `consent` key of `$.tool.call` ("the person's own words for the press that raised the call", read by the permission path as the user's request). MCP elicitation was considered and set aside: it needs a real MCP server of the mod's own, asks the human only, and records no permission.

### Scope

Included:
- On an `ask` verdict, in an interactive session, the bridge asks once with `$.ui.ask`, naming the tool and its arguments and the verdict's reason; on approval it calls `$.tool.call` with a `consent` line; on refusal, dismissal or a `-p` run it refuses as today.
- A setting that turns the dialog on, off by default.

Out:
- An "allow always" that writes a rule; the owner's settings stay the owner's.
- Any change once the engine applies the decision again; then the bridge lets `ask` through to `$.tool.call` and this dialog goes.

### Decision

- Opened on the owner's request, 2026-11-27, after weighing MCP elicitation.
- **The dialog shows outside the auto mode only; in auto mode an `ask` stays refused** until Claude Code lets `$.tool.call` reach the mode's decider again, which the upstream report asks for. The mods API exposes no way to run the auto-mode classifier: `$.tool.check` "asks no PreToolUse hook or classifier", and `$.model.classify` is a generic classifier. Not taken: the dialog in auto mode too (it would interrupt the mode meant to decide alone); a classifier of the mod's own (the mod would decide a permission, against Amendment 1). Open: how the bridge reads the session's permission mode; the committed types show `permissionMode` only on agent records.

### Acceptance

- C1: tests cover approval, refusal, dismissal and a `-p` run; the tool runs only on approval.
- C2: a live interactive session shows the dialog for a nested `Write` with no rule, and the file is written only after approval.
