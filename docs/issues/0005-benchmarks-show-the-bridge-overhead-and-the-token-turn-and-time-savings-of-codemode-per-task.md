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
- **Measured 2026-10-06** (`node scripts/overhead.ts --runs 15`, one discarded warm-up run per size; node v26.10.0, `@earendil-works/pi-codemode` 1.0.4):

  **Method.** The benchmark spawns the real codemode child (`child/main.ts`) once per run, with no model and no engine in the loop. The benchmark itself reads each nested-call line the child prints and answers instantly over the child's own Unix socket, so the numbers cover the bridge's mechanics alone — child start, sandbox, socket, each call's round trip, close — with three things deliberately outside: the engine's serve loop (it runs inside the Claude Code engine, a different runtime), the tool's own work (every answer is instant) and the model. Three measures come out of it:

  - the **fixed cost** is the median total of the 0-call runs: child start, sandbox, socket, close;
  - the **per-call cost** is the median span between one call line and the next, measured inside each run: each span is one full answer round trip. A single call spans nothing, so the 1-call size has no span;
  - the **diff/call** column, (median(n) − fixed) / n, is the naive per-call estimate from totals. It is noise-bound below ~10 calls: run-to-run boot noise is ±3 ms while 100 calls add only ~3 ms, so a negative or zero diff/call means the signal is smaller than the noise, not that calls are free. The span is the per-call number to quote.

  Every run must end right to count — exit 0, a well-ended script, the expected output, the right call count, the socket file removed — and a failed run is reported apart, never averaged in. No run failed in this measurement.

  ```
  calls   runs   failed     median          min            max         per call          diff/call
      0     15        0       98.4         97.0          100.4            fixed                  -
      1     15        0       97.9         95.9          100.9                -               -0.4
     10     15        0       97.9         96.2          102.7              0.3               -0.0
    100     15        0      101.3         97.4          103.1              0.1                0.0
  ```

  **Conclusion, as measured.** The bridge is expensive to open and nearly free to use:

  - the fixed cost of one codemode run is ~98 ms — one child process per call, paid once per script;
  - each nested call adds ~0.1–0.3 ms; a single call adds nothing measurable over the fixed cost, and 100 sequential calls add ~3 ms, within the run-to-run noise;
  - so a codemode script buys no per-call latency saving — the mechanics are already near-free — and its saving, if any, is in turns and tokens: ten reads in one codemode call pay one ~98 ms fixed cost and one model turn, against ten direct tool calls' ten turns. Whether that trade wins is what the task-savings A/B below measures; the overhead alone cannot say it.
- The A/B prints one table per task with both sides' tokens, turns, cost, time and correct-answer count, and the README quotes it with the date, build and model.
- A script that discards wrong answers is proven by a test with a stand-in result.

### Plan

1. Slice 1: the overhead microbenchmark, its output recorded here.
2. Slice 2: the A/B script and its pure result parsing, with tests.
3. Slice 3: one full run, the table recorded here, the README updated.
