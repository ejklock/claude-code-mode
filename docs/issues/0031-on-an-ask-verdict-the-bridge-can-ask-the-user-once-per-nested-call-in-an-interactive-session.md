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

- **An opt-in plugin option, `askDialog`, off by default**: the bridge cannot read the permission mode (Outcome), so it does not try; when the owner turns the option on, every nested `ask` becomes a dialog in any mode, and a `-p` run, with no one to ask, refuses as today. This supersedes "outside the auto mode only" in the bullet above, which the measurement showed the mod cannot apply. Not taken: deferring the issue; the owner regenerating the declarations with 2.1.332 to search for a mode call.

- **Show the whole call or refuse**, after two review rounds in which a short form of script-written arguments could hide what runs (a cut JSON, then zero-width padding, forged keys, a target outside `file_path`/`command`): the question shows the tool and its entire input as JSON with sorted keys and every character outside printable ASCII escaped as `\uXXXX`, with no cut; when that text exceeds a cap, the bridge refuses without asking ("too long to show safely"). A run that closes while a dialog is open waits only the grace. Not taken: patching the short form again; dropping the dialog.

- **The last fix applied by the session**: the round-3 review found that a call nested deep enough to overflow the stack in the sorted-key JSON was not refused (the call never ran, but the script waited for its deadline and the host saw an unhandled rejection); the owner had the session catch it and refuse as too long to show. Not taken: a follow-up task with its own test; holding the issue. Accepted: no automated test pins the deep nesting yet; the README now says a script that closes with a dialog open ends as a failure listing the unanswered call.

### Acceptance

- C1: tests cover approval, refusal, dismissal and a `-p` run; the tool runs only on approval.
- C2: a live interactive session shows the dialog for a nested `Write` with no rule, and the file is written only after approval.

### Outcome


Measured on 2026-11-27, Claude Code 2.1.332, headless (`--permission-mode default`, `auto`), from a throwaway copy of the mod whose handler printed the event it receives (repro under `$TMPDIR/p31-*`, session only):
- The `tool.call` event the codemode handler receives carries only `code`, `tool` and `tool_use_id`; no permission mode, in either mode.
- The committed declarations (2.1.291) name the mode only in classic hook input (`permission_mode`), in `agent.spawn` (`permissionMode`) and in a `setMode` permission update; no mods call reads it. The 2.1.332 binary's strings show no `$.<ns>.*mode*` call either.
- A probe that touched `$.session.identity` (present in the 2.1.332 binary, absent from the 2.1.291 declarations) made the engine skip the whole hooks module: the codemode tool was not registered, while `tsc` passed. Control: the unmodified copy registered and answered.
So the bridge cannot tell auto mode from the others today.

Shipped on 2026-11-27 after three review rounds and one session fix. With the plugin option `askDialog` (boolean, off by default) a nested call whose verdict is `ask` opens the engine's dialog showing the tool and the whole input as sorted-key JSON in printable ASCII with `\uXXXX` escapes and no cut; above 1500 shown characters, or nested too deep to show, it is refused without asking. It runs only on `Allow`, with a consent quoting the shown text; Deny, dismissal and `-p` refuse; a late answer runs nothing. Proved: `claude plugin test .` 272 pass (every reproduction of the three reviews held verbatim), `npm test` 322, quality gate pass; the 20000-level nesting refused in 9 ms by hand. Open: the real engine's `$.ui.ask` and `consent` in a live session.
