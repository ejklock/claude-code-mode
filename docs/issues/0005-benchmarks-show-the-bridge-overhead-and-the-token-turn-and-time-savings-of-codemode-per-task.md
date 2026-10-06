---
type: Issue
title: Benchmarks show the bridge overhead and the token, turn and time savings of codemode per task
description: Measures the bridge's fixed and per-call overhead locally, then A/B runs of the same tasks with and without codemode, reporting tokens, turns, cost, time and correctness.
status: closed
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
- **Medians and ranges over five or more runs per side and task**, after one discarded warm-up run per side for the prompt cache. With so few runs only large differences are claimed. **Amended 2026-10-06 (owner):** the first full run uses **3 runs per side** — a run costs ~US$0.16 on claude-opus-5-5 and the five-hour rate window stood at 0.85, and 48 runs could have hit the ceiling — so the run stays inside the window; only large differences are claimed, and a later run can raise the count once the window resets.
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
- **Built and smoked 2026-10-06** (`scripts/savings.ts`; 14 tests over stand-in result streams in `test/node/savings.spec.ts`; npm test 93, typecheck 0, plugin kit 103, se-gates pass):
  - the A/B runs each task's prompt on both sides against the same fixture repository and the same permission rules, the with side alone loading the plugin; the prompt never names codemode, so the with side measures the model's own choice of it;
  - `claude -p --output-format json` was verified on build 2.1.292: the output is one JSON event array ending in the result record (`usage`, `num_turns`, `total_cost_usd`, `duration_ms`, `result`) with the assistant events' tool names in the array, so the decided tool format stands and codemode use is still detected per run;
  - a smoke run (`--runs 1 --task todos`) proved the runner end to end: both sides correct, the with side used codemode, and the single pair already shows the direction the issue demands be published as measured — with codemode, 8 turns against 7 and 1,284 output tokens against 1,002, ~$0.099 against ~$0.086; one run says nothing, which is what the full run is for;
  - the answer checkers are substring-and-disk based, because the harness appends connector notices to the result text.
- **Ran 2026-10-06** (`node scripts/savings.ts --runs 3`, the amended 3 runs per side; 24 runs, every answer correct, none failed; claude 2.1.292, claude-opus-5-5, one discarded warm-up per side and task; the prompt never names codemode):

  ```
  task todos (read 5 tracked files, report their TODOs)
  side         runs correct  wrong codemode             input output cacheW cacheR      turns  cost$   time
  with            3       3      0        3           4 (4-8)    574    530  38188    2 (2-4)  0.023   7.7s
  without         3       3      0        -           6 (6-6)    966   1027  54286    7 (7-7)  0.039  11.9s

  task last-commit (git log, then read each changed file)
  side         runs correct  wrong codemode             input output cacheW cacheR      turns  cost$   time
  with            3       3      0        3           4 (4-4)    443    497  38222    2 (2-2)  0.021   6.3s
  without         3       3      0        -           6 (6-6)    414    558  55041    4 (4-4)  0.024   7.1s

  task write-three (create notes.md, team.md, usage.md)
  side         runs correct  wrong codemode             input output cacheW cacheR      turns  cost$   time
  with            3       3      0        3        12 (10-12)   1229   1674 111935    6 (5-6)  0.062  15.0s
  without         3       3      0        -        10 (10-10)   1321   1710  93581    8 (8-8)  0.059  15.8s

  task grep-port (one git grep for the port line)
  side         runs correct  wrong codemode             input output cacheW cacheR      turns  cost$   time
  with            3       3      0        0           4 (4-4)    164      0  38329    2 (2-2)  0.011   5.3s
  without         3       3      0        -           4 (4-4)    259   2105  32780    2 (2-2)  0.029   6.3s
  ```

  - the codemode tool's declaration adds ~430 tokens (description 1,048 chars + code parameter 670 chars, at 4 chars a token) to every turn on the with side; those tokens are inside the with-side numbers above.

  Reading of the numbers:

  - where many reads batch into one script (`todos`), codemode cut the turns to less than a third (2 against 7), the output tokens to ~60% (574 against 966), the cost to ~60% ($0.023 against $0.039) and the wall time to ~65% (7.7 s against 11.9 s);
  - the chain task (`last-commit`) halved the turns (2 against 4) at level tokens, cost and time;
  - the write task (`write-three`) cut the turns a quarter (6 against 8) at level tokens, cost and time — the script's own confirmation outputs eat part of the saving;
  - the unfavoured single `git grep` (`grep-port`): the model used codemode in 0 of 3 runs and called `Bash` directly, the right choice; that task's differences are run-to-run noise, not a saving or a cost of the tool;
  - input tokens are near zero on both sides because the context rides the prompt cache, so the token story lives in the output and cache columns;
  - with 3 runs per side, only the large differences are claimed; the rest is noise. The README quotes the table and the caveats.

### Plan

1. Slice 1: the overhead microbenchmark, its output recorded here.
2. Slice 2: the A/B script and its pure result parsing, with tests.
3. Slice 3: one full run, the table recorded here, the README updated.
