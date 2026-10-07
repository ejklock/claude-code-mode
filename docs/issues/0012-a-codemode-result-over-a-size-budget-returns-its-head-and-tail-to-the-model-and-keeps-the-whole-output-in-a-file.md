---
type: Issue
title: A codemode result over a size budget returns its head and tail to the model and keeps the whole output in a file
description: Caps what a codemode script's output costs the model and the transcript, without losing the middle.
status: open
timestamp: 2026-10-07T17:11:16Z
---

## 0012. A codemode result over a size budget returns its head and tail to the model and keeps the whole output in a file

Found in the [issue 0011](/issues/0011-each-mcp-server-takes-one-of-pi-s-four-exposure-modes-from-the-plugin-settings-and-an-unset-server-keeps-claude-code-s-default.md) probe on 2026-10-07: a script printed the whole Claude Docs guide, about 32,000 characters. All of it reached the model, and the transcript box of [issue 0003](/issues/0003-the-transcript-draws-a-codemode-call-as-its-highlighted-script-its-nested-calls-live-and-a-summary.md) drew every line, filling the owner's screen. Today nothing bounds either.

Pi bounds the model's side: text over 20 KB reaches the model with its middle removed, while the script itself gets the complete result ([research 0001](/research/0001-pi-codemode-and-how-to-host-it-in-claude-code.md)). pi-codemode also parses an `// @options: {"max_output_tokens": N}` line and leaves acting on it to the host.

### Scope

Included:
- A size budget on the output the model receives from one codemode call.
- A line cap on the output the transcript box draws, with a count of the lines left out.
- Over the budget, where the left-out part goes, as decided below.

Out:
- `store()`/`load()`, which keep values between scripts, not one call's output.
- The nested calls' results inside the script, which stay complete, as in Pi.

### Decision

Confirmed by the owner, 2026-10-07: **C, Pi's head-and-tail cut plus the whole output in a file.** Over 20 KB, the model gets the head and the tail, and a marker naming the size removed and the file's path, so it can `Read` the middle with `offset`/`limit` or search it. Options not taken:
- A, Pi's cut alone: the middle is lost, and seeing it means rerunning the script with a filter.
- B, the file alone with a short head: progressive disclosure too, but a different shape from Pi's.

The transcript cap applies either way.

Settled for slice 1, 2026-10-07:
- **Where the cut happens:** in the child, on the output it sends back (`child/main.ts`), so the success result and the "Output before the failure" of a failed run are both bounded.
- **The budget:** 20 KB read as 20,480 JavaScript string characters; the head and tail split it evenly, and a surrogate pair is never split.
- **The file:** the child writes it to a new folder `codemode-output-*` under the operating system's temp folder (`os.tmpdir()`, which honors `TMPDIR`). The mod does not remove it, because the mods API offers no file removal; the operating system's temp cleanup does. Not taken: a folder in the project, which would litter the repository.

Settled for slice 2, 2026-10-07:
- **The line cap:** the result box, success and error alike, draws the first 10 lines of the output and then one dim line `… N more lines`. The `ToolResult` render props carry no `isExpanded` in build 2.1.292, so ctrl+o cannot unfold the box as it does a Bash result; the whole output stays in the model's result and, over the budget, in the file.

### Acceptance

- A script that prints more than 20 KB returns its head and tail to the model, with a marker that names the size removed and the file's path.
- The file holds the whole output byte for byte.
- A script under the budget returns its output unchanged, and no file is written.
- The transcript box draws at most the line cap and states how many lines it left out.
- An `// @options: {"max_output_tokens": N}` line, if adopted, lowers the budget for that script.

### Plan

1. Where the file lives and its cleanup, recorded in the Decision.
2. The budget in the bridge, the cap in `hooks/render.tsx`, with red-first tests at each layer.
3. Rerun the issue 0011 Claude Docs prompt and record what the model and the transcript received.

### Outcome

2026-10-07, slices 1 and 2 built and reviewed (each approved, its review points fixed at the owner's word and re-reviewed):
- Slice 1: `shared/budget.ts` › `withinBudget` and the child's spill in `child/main.ts`. Tests: `test/node/budget.spec.ts` and three runs of the real child in `test/node/child.spec.ts`, each shown red by an assertion against a pass-through stub.
- Slice 2: the result box draws 10 lines and `… N more lines`, dim and cut to the box width, in `hooks/render.tsx`. Tests appended to `test/render.test.tsx`.
- Counts: `npm test` 127 → 140, `claude plugin test .` 139 → 152, typecheck clean, `se-gates check` pass.
- Still open: the `// @options` line, not adopted; plan step 3, the live rerun.
