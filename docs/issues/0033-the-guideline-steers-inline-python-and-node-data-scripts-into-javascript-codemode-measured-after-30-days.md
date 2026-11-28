---
type: Issue
title: The guideline steers inline Python and Node data scripts into JavaScript codemode, measured after 30 days
description: Strengthens the codemode guideline and the Bash note per ADR 0002, with a before and after adoption run and a transcript measurement 30 days later.
status: open
timestamp: 2026-11-28T02:35:58Z
---

## 0033. The guideline steers inline Python and Node data scripts into JavaScript codemode, measured after 30 days

[ADR 0002](../adr/0002-codemode-adds-no-python-runtime-and-steers-python-shaped-work-into-javascript-scripts.md) chose guidance over a second runtime: inline Python is 2.72% of the main session's `Bash` calls over 30 days ([research 0004](../research/0004-how-much-inline-python-the-model-still-writes-and-which-sandbox-could-run-python-scripts-for-codemode.md)), and issue 0013's note on `Bash` already moved inline Python and Node from 5.8% to 3.3%.

### Scope

Included:
- The codemode guideline and the `Bash` note (`hooks/describe.ts`) name data-processing and file-transforming scripts written in Python or Node through `Bash` as codemode work, with a short JavaScript example of the usual Python idioms (reading JSON or CSV files through `tools.Read`, grouping and counting, writing through `tools.Write`).
- The adoption benchmark's data task run before and after (`node scripts/adoption.ts --task data`), five runs per side.

Out:
- A Python runtime (ADR 0002).

### Decision

- Opened from ADR 0002.

### Acceptance

- C1: the description snapshot test in `test/node/invariants.spec.ts` carries the new text, and the description stays within its token budget test.
- C2: the adoption data task, five runs per side, is recorded before and after.
- C3: 30 days after the change ships, `node scripts/transcripts.ts --since <that day>` is recorded here; below 1% inline Python in the main session closes the issue, at or above it reopens ADR 0002.
