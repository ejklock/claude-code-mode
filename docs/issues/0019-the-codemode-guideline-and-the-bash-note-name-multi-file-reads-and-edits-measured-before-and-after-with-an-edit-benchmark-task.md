---
type: Issue
title: The codemode guideline and the Bash note name multi-file reads and edits, measured before and after with an edit benchmark task
description: Adds multi-file reads and edits to the system-prompt guideline and the Bash note, and measures codemode use on a rename task and the data task in auto permission mode, before and after.
status: closed
timestamp: 2026-10-13T21:37:21Z
---

## 0019. The codemode guideline and the Bash note name multi-file reads and edits, measured before and after with an edit benchmark task

On 2026-10-13 another session (se-configs) reported that codemode is about 1% of tool calls in the owner's transcripts. Its proposed causes were checked against the code:
- Read and Edit were already nested tools (`shared/protocol.ts` › `EXPOSED_TOOLS`), and no exposure setting removes a built-in.
- Grep and Glob do not exist in build 2.1.292.
- The test of a hook that denies a nested call already exists (`test/codemode.test.ts`, the PreToolUse denials of a nested Write and of a nested MCP tool).

The remaining cause is wording. In auto permission mode, Claude Code itself injects text that tells the model to read files with `cat`, `head` or `sed -n`, and to make small edits with `sed` or heredocs through Bash. Codemode's guideline and its Bash note ([issue 0013](/issues/0013-the-model-writes-a-data-processing-script-in-codemode-instead-of-inline-python-or-node-in-bash-measured-before-and-after-a-note-on-bash.md)) name batching, chaining and filtering, but not multi-file reads or edits. The owner asked on 2026-10-13 to change the wording now, measured before and after.

### Scope

Included:
- New text for `GUIDELINE` and `BASH_NOTE` in `hooks/describe.ts`.
- A benchmark task `edit` in `scripts/adoption.ts`: rename a constant across four of five TypeScript files, a prompt that names no tool, and a classifier that counts codemode, direct `Edit`/`Write` calls and Bash edits, and checks the files on disk.
- A `--permission-mode` flag on the benchmark, so it runs in auto mode as the owner does.

Out:
- Notes on Read, Edit or other built-in tools.
- The transcript re-scan after weeks of use.
- Exposing Grep or Glob.

### Decision

- **Wording:**
  - `GUIDELINE`: "Use codemode to read, search or edit several files in one pass, batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls."
  - `BASH_NOTE`: "To read or edit several files, process data, batch tool calls or filter large output with a script, use the codemode tool (JavaScript calling `tools.<name>(args)`) instead of cat, sed, or inline python or node in Bash. Keep Bash for running commands."
  - Option not taken: a note on Read's description. Issue 0013 kept notes to Bash only.
- **Go or no-go.** The wording ships when, on the `edit` task, codemode is used in more runs after the change than before, the `data` task does not drop, and the answers are not less correct. Otherwise the counts go to the owner before it ships.

### Acceptance

- C1: the kit tests assert the new `GUIDELINE` and that `Bash`'s description ends with the new note exactly once. Every other description is unchanged.
- C2: the `edit` classifier unit tests pass: a codemode-only run, a direct-Edit run, a `sed -i` run, a run that leaves one old name, a run that changes the fifth file, and an invalid run.
- C3: `node scripts/adoption.ts --runs 5 --task edit --permission-mode auto` and the `data` task, each before and after the wording, are recorded here with claude's version.
- C4: `npm run typecheck`, `npm test`, `plugin validate .`, `plugin test .`, `living-docs check docs` and `se-gates check` pass.

### Results

Run on 2026-10-13 with claude 2.1.292, 5 runs per side, `--permission-mode auto`. HEAD has no `edit` task, so the "before" side ran against the working tree with the old `hooks/describe.ts`, not with `--baseline`.

| Task | Before: codemode | After: codemode | Correct (before / after) | Other path |
|---|---|---|---|---|
| `edit` (rename across 4 of 5 files) | 0 of 5 | 0 of 5 | 5 / 5 | a shell edit in Bash (`sed -i`, `perl -i`) in 5 of 5, both sides |
| `data` (aggregate 12 JSON files) | 3 of 5 | 5 of 5 | 5 / 5 | no inline script in Bash on either side |

**The go rule was not met:** the `edit` task did not move. On a rename, one `sed -i` across the files is a single Bash call, and codemode cannot beat it, so the task measures a case where Bash is the right choice. The `data` gain (3 to 5) is not significant with 5 runs per side. The owner chose on 2026-10-13 to ship the wording and the task anyway: neither task got worse, and the task stays for later measurement. A task where codemode wins, such as reading several files and filtering the output, is the better test of the wording.

The coder refactored `flagError` and `main` after the measurements, to bring `se-gates check` under its complexity limit. The unit tests cover the refactor, but the benchmark was not rerun.
