---
type: Issue
title: The headless check enforces its own deny rules whatever settings the invoking session carries
description: scripts/e2e.ts lets a denied call through when run from an auto-mode session with user, remote and policy settings; find the setting and isolate the run.
status: closed
timestamp: 2026-11-27T19:00:57Z
---

## 0028. The headless check enforces its own deny rules whatever settings the invoking session carries

On 2026-11-27, `node scripts/e2e.ts` failed every case that relies on a deny rule or on the missing-permission denial, on pi-codemode 1.1.0 and 1.7.0 alike: a call the run's settings deny returned `NOT-DENIED` (issue 0023's Outcome). The script already passes `--setting-sources project` and its own `--settings` file. The session that ran it uses `CLAUDE_CONFIG_DIR`, the `auto` default permission mode, and remote and policy settings. Inference, not verified: one of those still applies to the headless run and overrides the run's deny rules.

### Scope

Included:
- Find which setting lets a denied call through in the headless run, with the command that shows it.
- Make `scripts/e2e.ts` produce the same verdict whatever the invoking session's settings, or fail with a message naming the setting it cannot isolate.

Out:
- Any change to the mod's permission path; every nested call already goes through `$.tool.call`.

### Decision

- Opened from issue 0023, whose headless check was accepted in part.
- **A barrier in the mod and a report upstream**, over disabling codemode until Claude Code is fixed and over only reporting upstream; issue 0029 carries the barrier, and the report's text goes to the owner before it is sent.
- The owner keeps using codemode in their sessions meanwhile, over pausing it until the barrier ships; accepted risk: a script can run what a deny rule forbids.

### Acceptance

- C1: the Outcome names the setting and the command that proved it.
- C2: `node scripts/e2e.ts` passes every case in this environment, or stops before spending tokens with a message naming the setting.

### Outcome

Diagnosed on 2026-11-27 (repro under `$TMPDIR/e2eh2-*`, session only). The failure is not the test environment: **a plugin's `$.tool.call` does not apply permission deny rules in Claude Code 2.1.328, 2.1.329 and 2.1.332.**

| Case | Settings | Result |
|---|---|---|
| The model calls `Bash("echo denied")` directly | `deny: Bash(echo denied:*)` | denied, with a `permission_denials` entry |
| A codemode script calls `tools.Bash("echo denied")` | same | `NOT-DENIED` |
| A codemode script calls `tools.Bash("echo h4")` | `deny: ["Bash"]` (Bash is gone from the model's tool list) | `NOT-DENIED` |
| The nested case on 2.1.328 and 2.1.329 | same | `NOT-DENIED` |

Refuted on the way: plugins from remote settings (`prependPlugins` is empty); the inherited `CLAUDE_CODE_*` session variables (stripped, same result). The mod calls `$.tool.call(input)` plainly (`hooks/register.ts`), and its `tool.check` hook only denies the hidden exposure mode. The committed declarations (2.1.291) say `$.tool.call` runs "the permission check and its dialog"; issue 0010 recorded the e2e deny case passing in October 2026. Not bisected: 2.1.291 does not start in this sandbox, so the first bad version lies between about 2.1.292 and 2.1.328. Not measured: whether `PreToolUse` hooks and the ask dialog are skipped too.

Closed: the permission cases of the headless check pass once the bridge asks the verdict (issue 0029: 50 PASS, 4 FAIL, the four being MCP checks that predate it, issue 0030).
