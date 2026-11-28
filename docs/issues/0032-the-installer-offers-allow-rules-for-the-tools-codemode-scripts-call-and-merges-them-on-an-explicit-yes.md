---
type: Issue
title: The installer offers allow rules for the tools codemode scripts call and merges them on an explicit yes
description: install.sh shows a rule list and merges it into permissions.allow of the install scope settings, idempotent and backed up; the plugin never writes rules.
status: closed
timestamp: 2026-11-27T21:10:19Z
---

## 0032. The installer offers allow rules for the tools codemode scripts call and merges them on an explicit yes

Since issue 0029 a script's nested call runs only on an `allow` verdict, so a tool with no allow rule is refused inside codemode. Other plugins already tell their users to add rules such as `mcp__plugin_living-docs_living-docs__*`. The Claude Code CLI has no command to add a permission rule (`claude --help` shows only the per-run `--allowedTools`), so an installer would merge the rules into the settings file itself. This is the installer, run by the owner, not the plugin at run time: the plugin never edits permission rules.

### Scope

Included:
- `install.sh` offers a list of allow rules, shows them, and on an explicit yes (or a flag) merges them into `permissions.allow` of the settings file for the install scope: idempotent, with a backup, never touching `deny` or other keys.
- The rule list and its default, decided with the owner.
- A test of the merge: an absent file, an existing list, a duplicate, a malformed file (refused, untouched).

Out:
- Any write by the plugin at run time.

### Decision



- Opened on the owner's request, 2026-11-27.
- **Rules offered**: `Read`, `Glob`, `Grep`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `ReadMcpResourceDirTool`, `WebSearch`, and `mcp__<server>__*` for each server the owner set to the codemode exposure mode (`mcpCodemode`). Not taken: the read-only set alone; adding Bash prefixes typed at install. Accepted cost: every tool of those servers is allowed, writing ones included.
- **Asked, not assumed**: the installer shows the list and writes only on an explicit yes, or with a flag in a non-interactive run; it writes the settings file of the install scope, with a backup, and touches nothing but `permissions.allow`.
- Delivery order: this issue, then 0031, 0027, 0025 and 0024. Not taken: 0031 first.

- **Review round before the commit**, closing the four normal findings (a symlink planted at the temporary name, raw stack traces on expected failures, a server glob skipped without notice, missing tests) and two nits (the backup name under the local scope in the README, a repeated call in install-check.sh). Not taken: fixing only the first two; committing with the findings open.

- **The last fix applied by the session**: the round-3 review found that a short write was taken as success (`writeSync` on the descriptor), which could replace the settings file with truncated JSON while reporting success; the owner had the session apply `writeFileSync(descriptor, …)` directly. Not taken: a follow-up task with its own test; holding the issue. Accepted: no automated test pins the short write yet.

### Acceptance

- C1: the merge test passes, and a dry run prints the rules without writing.
- C2: after an install with the rules accepted, a script's nested call of a listed tool runs in a live session.

### Outcome

Shipped on 2026-11-27 over three review rounds and one session fix. `scripts/allow-rules.ts` offers `Read`, `Glob`, `Grep`, the three MCP resource tools, `WebSearch` and `mcp__<server>__*` per `mcpCodemode` server, and with `ALLOW_RULES=ask|yes|no|print` merges them into `permissions.allow` of the install scope's file only: exclusive temporary file, mode kept whatever the umask, backup, atomic rename, one-line failures with no temporary file left, a notice for globbed servers no rule can cover, Ctrl-D counted as no.

Proved: `node --test test/node/allow-rules.spec.ts` 39 pass under the default umask and `umask 077`; `npm test` 322; `claude plugin test .` 234; quality gate pass; `sh scripts/install-check.sh` 11 PASS (outside the sandbox). The short-write defect, reproduced by the reviewer with `ulimit -f 1` on a 350-byte settings file, now exits 1 with the file unchanged and no temporary file (checked by hand, not by a test). Open: acceptance C2, a nested call of a listed tool in a live session after an install.
