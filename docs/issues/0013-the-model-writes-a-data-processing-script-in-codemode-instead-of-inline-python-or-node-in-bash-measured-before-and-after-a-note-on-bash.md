---
type: Issue
title: The model writes a data-processing script in codemode instead of inline Python or Node in Bash, measured before and after a note on Bash
description: Measures how often the model runs inline Python or Node through Bash, in a benchmark task and in the owner's own transcripts, then adds a note to Bash's description that points such scripts to codemode, and measures again.
status: closed
timestamp: 2026-10-09T08:11:10Z
---

## 0013. The model writes a data-processing script in codemode instead of inline Python or Node in Bash, measured before and after a note on Bash

On 2026-10-09 the owner reported that the model often runs inline Python through `Bash` (`python3 - <<EOF`, `python3 -c`). Such a script is already codemode's shape: a script runs and only its printed output returns. But it reaches the disk directly. It cannot call the session's tools or MCP servers, its writes skip `Edit` and `Write`, and no failure ledger records what ran.

This issue measures how often it happens, then adds the fourth layer that [issue 0004](/issues/0004-the-model-picks-codemode-on-its-own-because-the-tool-is-declared-up-front-described-like-pi-s-and-named-in-one-system-prompt-line.md) deferred: a note on a built-in tool's description, here only on `Bash`.

### Scope

Included:
- **A classifier** for an inline script in a `Bash` command: `python`, `python3` or `node` run with `-c`/`-e`, a heredoc (`<<`), or stdin (`-`). It is a pure function with unit tests.
- **A benchmark task** in `scripts/adoption.ts`. Its fixture is a set of JSON files and its prompt asks for an aggregate over them, without naming any tool. Each run is counted as codemode, inline script in `Bash`, or other. It runs with `--baseline` (HEAD) and with the working tree.
- **A transcript scan**, `scripts/transcripts.ts`. It reads the owner's `~/.claude/projects/**/*.jsonl`, read-only. It counts `Bash` calls with an inline script by kind (python `-c`, python heredoc or stdin, node `-e` or heredoc), next to codemode calls and all `Bash` calls, per project and in total, over a date window. It prints counts only, never command text, because commands can hold secrets.
- **The note on Bash.** A `tool.describe` hook on `Bash` appends one paragraph to the description it gets from `next(e)`. The text is fixed, because the engine caches it for the session.

Out of scope:
- A Python runtime for codemode. `@earendil-works/pi-codemode` runs JavaScript only. CPython has no sandbox, so it would break the "no file system, no network" invariant, and a WASM Python is a heavy dependency. It would need an ADR.
- Notes on other built-in tools.
- Scripts saved to a file and then run (`python3 x.py`).

### Decision

- **Measure, then steer.** The owner chose this on 2026-10-09, over a Python runtime (option B) and over measuring only.
- **The transcript scan reads the owner's history.** The owner chose this on 2026-10-09, over a benchmark-only measurement. It prints counts only.
- **Note text:** "To process data, batch tool calls or filter large output with a script, use the codemode tool (JavaScript calling `tools.<name>(args)`) instead of inline python or node in Bash. Keep Bash for running commands." Pi's mode "on" note is a call sample per tool. This note instead names the case it redirects.
- **Go or no-go for the note.** If the benchmark baseline shows no inline script in 5 runs and the transcripts show it in under 1% of `Bash` calls, the counts go to the owner before the note ships.

### Acceptance

- The classifier unit tests pass:
  - positive: `python3 - <<'EOF'`, `python3 -c "…"`, `python -c`, `node -e "…"`, `node <<EOF`, `cat f.json | python3 -`, a prefix such as `cd x && python3 - <<EOF`;
  - negative: `python3 script.py`, `pip install x`, `grep python file`, `node script.js`.
- A kit test through the `tool.describe` hook: `Bash`'s description is the engine's description followed by the note, exactly once; the description of every other tool is unchanged.
- `node scripts/adoption.ts --runs 5 --task data --baseline` and the same run without `--baseline` are recorded here as counts per kind.
- `node scripts/transcripts.ts` counts are recorded here, with the window they cover.
- `npm run typecheck`, `npm test`, `plugin validate .`, `plugin test .` and `se-gates check` pass.

### Results

**Transcripts.** `node scripts/transcripts.ts --since 2026-09-09`, run on 2026-10-09 (30 days, from 00:00 UTC), counts only. The run uses the classifier after the review fix, which also counts an interpreter inside a quoted `bash -c "…"`:

| Session | Bash calls | python `-c` | python stdin/heredoc | node `-e` | node stdin | Inline total | codemode calls |
|---|---|---|---|---|---|---|---|
| Main | 14,823 | 470 | 201 | 192 | 0 | 863 (5.8%) | 330 |
| Sidechain (subagents) | 64,116 | 1,023 | 784 | 1,116 | 2 | 2,925 (4.6%) | 32 |

57 lines were skipped as malformed.

**Benchmark baseline.** `node scripts/adoption.ts --runs 5 --task data --baseline`, run on 2026-10-09 with claude 2.1.292 against HEAD 1b4eb39:
- codemode was used in 5 of 5 runs;
- an inline script in `Bash` appeared in 1 of 5 runs (run 3, python `-c`);
- every run named the top three.

**Benchmark after the note.** `node scripts/adoption.ts --runs 5 --task data`, run on 2026-10-09 with claude 2.1.292 against the working tree with the `Bash` note:
- codemode was used in 5 of 5 runs;
- an inline script in `Bash` appeared in 0 of 5 runs, and no run called `Bash` at all (the baseline had `Bash` calls in 2 runs);
- every run named the top three.

With 5 runs per side, the change from 1 of 5 to 0 of 5 points the expected way but is not significant. Running the transcript scan again after some weeks of use gives the stronger after measure.

**Go.** Inline scripts are 5.8% of the main session's `Bash` calls, above the 1% bar. The synthetic task provokes inline scripts less than real use does, so the transcripts are the stronger signal for the after measure.

### Plan

1. The classifier, the benchmark task and the transcript scan; baseline counts recorded (C).
2. Go or no-go against the counts.
3. The `Bash` note with its kit test; after counts recorded (A).
