---
type: Issue
title: The benchmark shows how much printed output and how many turns each task spends, before any output filter is built
description: Adds test-failure and log-error tasks to the savings benchmark and a per-run measure of the tool output that entered the context, and traces the write task's turns, so the filter globals pilot is built only if the data shows printed output is the cost.
status: closed
timestamp: 2026-10-07T03:27:52Z
---

## 0007. The benchmark shows how much printed output and how many turns each task spends, before any output filter is built

A reader pointed out that the turn count matters more than the output tokens show, because every turn rereads the whole context. The owner then proposed a pilot after RTK: generic output filters inside the sandbox (`errors`, `collapse`, `clip`) and a bounded `raw` handle, so the model can still see everything. Each filter states what it dropped, and `raw` fetches a range or a search without rerunning the command. This issue measures first, so the pilot is built only if printed output is the cost.

### Scope

- Two new tasks in `scripts/savings.ts`: `test-failures` (a verbose test suite with two failures) and `log-errors` (a long log, mostly repeated info lines, with three distinct errors).
- A per-run measure of the tool output that entered the model's context, in characters, on both sides.
- A per-turn trace of `write-three`, saying why codemode still takes about 6 turns there.
- No change to the plugin.

### Decision

- Measure before building. If the printed output is small on the with side, the filter globals are not built. If it is large, the globals and `raw` get an ADR before any code, because they are a script API that is expensive to reverse.
- Reimplement RTK's generic ideas, never its code or its per-tool parsers. RTK is Apache 2.0, and RTK stays the per-tool option when it is installed.

### Acceptance

- `node scripts/savings.ts --task test-failures --runs 3` and `--task log-errors --runs 3` report correctness, turns, tokens, cost and the context-output measure for both sides.
- The `write-three` trace names each turn's tool calls on the with side.
- The results and a go or no-go reading for the filter pilot are recorded here.

### Plan

1. Measurement: the tasks, the context-output measure, the trace, and the runs.
2. Only on go: an ADR for the filter globals and `raw`, then the pilot, measured on the same tasks.

### Results

Measured on 2026-10-07 with claude 2.1.292, model claude-opus-5-5, 3 runs per side after one discarded warm-up per side. `ctxOut` is the characters of `tool_result` text that reached the model (4 characters is about 1 token). The `test-failures` and `log-errors` runs went at the same time on one machine, so their times are not comparable with `write-three`. Medians and ranges cover the correct runs only.

`test-failures`

```text
side         runs correct  wrong codemode             input output cacheW cacheR            ctxOut      turns  cost$   time
with            3       3      0        1         10 (8-12)    993   5932  96630  5094 (2701-7686)    5 (4-6)  0.089  19.1s
without         3       3      0        -           8 (8-8)    872   7066  73409  7691 (7687-8497)    4 (4-4)  0.089  15.6s
```

Per run, with side (the head of the captured output scrolled out, so run 1 is read from the table ranges and the trace tail that survived): run 1 correct, ctxOut 2701, 6 turns, the one run that used codemode (turns 2-4 `mcp__codemode__codemode` -> 134, 334, 651 chars, then turn 5 `Bash` -> 830 chars, then the answer); run 2 correct, ctxOut 5094, 5 turns, Bash only, $0.087, 15.3s; run 3 correct, ctxOut 7686, 4 turns, Bash only, $0.089, 21.0s. Without side: ctxOut 7687, 8497 and 7691 over 4 turns each.

`log-errors`

```text
side         runs correct  wrong codemode             input output cacheW cacheR            ctxOut      turns  cost$   time
with            3       3      0        0           6 (6-6)    511   4014  53686   1282 (466-1504)    3 (3-3)  0.053   8.9s
without         3       3      0        -           6 (6-8)    525   4502  54989  2474 (2474-2510)    3 (3-4)  0.056  11.1s
```

No with-side run called codemode here.

`write-three`

```text
side         runs correct  wrong codemode             input output cacheW cacheR            ctxOut      turns  cost$   time
with            3       3      0        1           4 (4-4)    463   3672  33696     946 (946-946)    2 (2-2)  0.046   6.7s
without         3       3      0        -           4 (4-4)    445   3592  31776     946 (946-946)    2 (2-2)  0.044   6.8s
```

Trace, with side (the same shape in all three runs; runs 1 and 2 used Bash, run 3 used codemode):

```text
run 1  turn 1: Bash -> 946 chars
       turn 2: (answer)
run 2  turn 1: Bash -> 946 chars
       turn 2: (answer)
run 3  turn 1: mcp__codemode__codemode -> 946 chars
       turn 2: (answer)
```

#### Reading

- Printed output is a small share of what the model reads. On `test-failures` the with side's 5,094 characters (about 1,300 tokens) sit against about 97,000 cache-read tokens and 993 output tokens; on `log-errors` 1,282 characters (about 320 tokens) sit against about 54,000 cache-read tokens. Without side: 7,691 and 2,474 characters against 73,000 and 55,000. Cache-read tokens are the bulk of the cost, and they come from the fixed context reread on every turn, not from tool output.
- Go or no-go: no-go for the filter pilot. On these tasks the printed output is about 3 percent of the cache-read volume or less, and a filter could cut at most that part. Even the verbose 160-test suite printed only about 8,000 characters. The round-1 `test-failures` data was discarded because its fixture failed only one test on Node v26.10.0; the numbers here come from a fixture that fails exactly two.
- Why `write-three` takes its turns: it takes 2 turns, not the 6 assumed when the issue was written. One tool call writes all three files and prints them back, then the model answers. Both sides do the same, and codemode was used in only one of three runs.
- With 3 runs per side, only large differences count, and none shows: input, turns, cacheR and cost differ by less than the spread between runs. On `test-failures` both sides answered all three runs correctly.
