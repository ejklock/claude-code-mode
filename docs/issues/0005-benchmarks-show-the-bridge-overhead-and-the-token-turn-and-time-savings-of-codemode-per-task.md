---
type: Issue
title: Benchmarks show the bridge overhead and the token, turn and time savings of codemode per task
description: Measures the bridge's fixed and per-call overhead locally, then A/B runs of the same tasks with and without codemode, reporting tokens, turns, cost, time and correctness.
status: open
timestamp: 2026-10-06T19:02:56Z
---

## 0005. Benchmarks show the bridge overhead and the token, turn and time savings of codemode per task

The README says the bridge overhead and the task-level savings are not measured. This issue measures both, so the README can state numbers. It absorbs slice 2 of [issue 0001](/issues/0001-a-prototype-runs-a-script-that-calls-read-and-bash-through-the-mod-and-measures-the-child-process-overhead.md), the overhead measurement. The owner asked for benchmarks once issue 0002 is done (2026-10-06).

### Scope

Included:
- **Bridge overhead.** A local microbenchmark with no model: the fixed cost of one codemode run (child start, socket, close) and the cost of each nested call, for scripts of 1, 10 and 100 calls, as medians over repeated runs.
- **Task savings.** An A/B of the same tasks, with and without the plugin, through `claude -p --output-format json`, reporting input, output and cache tokens, turns, cost, wall time and whether the final answer is correct. It builds on `scripts/adoption.ts`.
- **Tasks.** Three or four that codemode should favour (read many files and filter, chain `git` with reads, write several files) and one that it should not (a single `git grep`), so the result also shows where it does not help.
- **Fixed cost.** The tool's schema adds tokens to every turn. The report states it and counts it in the totals.

Out:
- Other models, other Claude Code builds, and tuning the description to win a benchmark.

### Decision

- **Correctness gates the numbers.** A run whose answer is wrong or missing is reported apart, not averaged in: fewer tokens from less work is not a saving.
- **Medians and ranges over five or more runs per side and task**, after one discarded warm-up run per side for the prompt cache. With so few runs only large differences are claimed.
- **Results are published as measured.** Where codemode costs more, the README says so.

### Acceptance

- The overhead benchmark prints the fixed and per-call medians for 1, 10 and 100 calls, and runs without a model.
- The A/B prints one table per task with both sides' tokens, turns, cost, time and correct-answer count, and the README quotes it with the date, build and model.
- A script that discards wrong answers is proven by a test with a stand-in result.

### Plan

1. Slice 1: the overhead microbenchmark, its output recorded here.
2. Slice 2: the A/B script and its pure result parsing, with tests.
3. Slice 3: one full run, the table recorded here, the README updated.
