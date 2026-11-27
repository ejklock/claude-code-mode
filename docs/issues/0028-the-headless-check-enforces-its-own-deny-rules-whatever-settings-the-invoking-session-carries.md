---
type: Issue
title: The headless check enforces its own deny rules whatever settings the invoking session carries
description: scripts/e2e.ts lets a denied call through when run from an auto-mode session with user, remote and policy settings; find the setting and isolate the run.
status: open
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

### Acceptance

- C1: the Outcome names the setting and the command that proved it.
- C2: `node scripts/e2e.ts` passes every case in this environment, or stops before spending tokens with a message naming the setting.
