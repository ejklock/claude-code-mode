---
type: ADR
title: Codemode adds no Python runtime and steers Python-shaped work into JavaScript scripts
description: No second script runtime; the guideline and the Bash note steer inline Python into JavaScript codemode, measured again after 30 days.
owner: Evaldo Klock
status: Accepted
timestamp: 2026-11-28T02:35:30Z
---

# 0002. Codemode adds no Python runtime and steers Python-shaped work into JavaScript scripts

## Context

Codemode runs model-written JavaScript in the QuickJS sandbox of `@earendil-works/pi-codemode`. The model still writes inline Python through `Bash`: 2.72% of the main session's `Bash` calls over 30 days (638 of 23,432) and 4.21% of subagents' ([research 0004](../research/0004-how-much-inline-python-the-model-still-writes-and-which-sandbox-could-run-python-scripts-for-codemode.md)), above the 1% bar [issue 0025](../issues/0025-research-whether-codemode-scripts-should-also-run-python-measured-from-the-transcripts-before-any-runtime.md) set before measuring. Such a script reaches the disk directly, skips `Edit`, `Write` and the permission barrier of issue 0029, and leaves no failure ledger. After issue 0013 added a note to `Bash` pointing script-shaped work to codemode, inline Python and Node fell from 5.8% to 3.3% of main-session `Bash` calls. The Constitution asks for "the same script API as Pi's codemode", and Pi shows no plan for Python.

## Decision

We will add no second script runtime and instead steer Python-shaped work into JavaScript codemode through the tool's guideline and the `Bash` note, and measure again 30 days after that change ships.

Rejected alternatives:
- **Monty behind the same bridge** (`codemode` taking a language): a sandbox with async host calls, a deadline and a memory cap built in, but a Python subset without third-party packages, about 30 MB plus native binaries, one young vendor product with no third-party audit, and a Constitution amendment for a second API; it loses because the model's inline Python is mostly reached for libraries and idioms the subset lacks (inference, see Open Questions of research 0004) and the guidance route already moved the share.
- **Pyodide with its `js` bridge removed**: full CPython, but the bridge sees `globalThis` by default with no documented switch, an escape through it is on record (CVE-2025-68668), start-up is about 0.75 s and a deadline needs a worker with `SharedArrayBuffer`; it loses on the sandbox guarantee codemode exists to keep.

## Consequences

**Easier / gained:**
- No new dependency, no second sandbox to keep secure, the Constitution unchanged; scripts stay readable as Pi's codemode.

**Harder / accepted trade-offs:**
- Work that genuinely needs Python libraries stays in `Bash`, outside the barrier and the ledger.
- The share may not fall below the bar through guidance alone.

**Follow-ups:**
- An issue that strengthens the guideline and the `Bash` note for data-processing scripts and measures again after 30 days.

## Verification

**Implementation impact:** `hooks/describe.ts` (the guideline and the `Bash` note); no runtime code.

**Verification criteria:**
- `node scripts/transcripts.ts --since <the day the guidance ships>`, run 30 days later, shows inline Python below 1% of the main session's `Bash` calls; at or above it, this ADR is revisited with the Monty and Pyodide options.
- `@earendil-works/pi-codemode` stays the only script runtime in `package.json` (the exact-pin test in `test/node/invariants.spec.ts`).

# References

[1] [Research 0004](../research/0004-how-much-inline-python-the-model-still-writes-and-which-sandbox-could-run-python-scripts-for-codemode.md)
[2] [Issue 0013](../issues/0013-the-model-writes-a-data-processing-script-in-codemode-instead-of-inline-python-or-node-in-bash-measured-before-and-after-a-note-on-bash.md)
