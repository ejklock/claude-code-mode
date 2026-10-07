---
type: Issue
title: A failed codemode script reports which nested calls already ran, so a retry does not repeat side effects
description: On failure the codemode result lists each nested call with its state, and the description tells scripts with writes how to fail safely; a headless measurement counts duplicated writes before and after.
status: closed
timestamp: 2026-10-06T22:58:28Z
---

## 0006. A failed codemode script reports which nested calls already ran, so a retry does not repeat side effects

A reader raised partial side effects: a script creates three records, throws on the fourth, and the model only sees the error. Its retry reruns the whole script and duplicates the first three. Today the failed result carries the error and the printed output (`hooks/bridge.ts` › `outcome`), but not the nested calls the bridge already recorded for the transcript.

### Scope

- On a failed run, the result the model reads lists the run's nested calls in order, each with its tool, a short label, its state and a short answer or reason.
- The codemode description tells a script with writes to print its progress, to catch each item's failure apart, and to pass an idempotency key when a tool takes one.
- A headless measurement counts duplicated writes when a create tool fails once mid-batch, before and after the change.

### Decision

- Report what ran instead of an idempotency key on every write tool or a dry-run sandbox: the tools belong to the session and to MCP servers, and Bash and MCP side effects cannot be staged. Replaying identical calls on a retry is not taken; it would hide calls repeated on purpose.

### Acceptance

- A run whose fourth nested call fails returns an error that lists calls 1–3 as done and call 4 as failed with its reason.
- A run with more calls than the kept limit says how many calls were left out.
- The description carries the write guidance within the sections budget.
- The measurement reports duplicated writes per run for the baseline and for the change.

### Plan

1. The ledger in the failed result, the description guidance, and the measurement script, run once on the baseline and once on the change.
2. The ledger tells a definite failure from an unknown outcome. A call whose tool returned an error result stays `failed`. A call whose `$.tool.call` threw (a transport error, a timeout, an abort), or that never got an answer, is `unknown`: it may have taken effect, so it should be checked before it is redone. The description says so. The measurement gains an ambiguous task: the fourth create takes effect, but its answer is lost. Owner's choice on 2026-10-06, over a write-through script store, which waits for a real long-script case and an ADR.

### Results

**Measured 2026-10-06** (`node scripts/partial.ts --runs 3`, headless `claude -p` with the plugin and the fake store, whose `create_record` tool fails once, on its fourth call of a run; the prompt asks for records r1..r6 and never names codemode or retries). A first baseline attempt, in which the model passed `{ id }` instead of `{ name }` because the tool's description did not say its argument, was discarded; the fake tool's description now states `takes { name }`, and both result sets below use it.

Baseline (before the ledger and the description guidance):

```
run 1: codemode, creates 7, distinct 6, duplicates 0, all six exist yes, 3 turns, out 420, $0.066, 9.6s
run 2: codemode, creates 7, distinct 6, duplicates 0, all six exist yes, 3 turns, out 444, $0.022, 9.1s
run 3: codemode, creates 7, distinct 6, duplicates 0, all six exist yes, 3 turns, out 430, $0.022, 9.4s
medians: creates 7, distinct 6, duplicates 0, turns 3, out 430, $0.022, 9.4s
```

On the change:

```
run 1: codemode, creates 7, distinct 6, duplicates 0, all six exist yes, 3 turns, out 409, $0.153, 8.7s
run 2: codemode, creates 7, distinct 6, duplicates 0, all six exist yes, 3 turns, out 457, $0.023, 9.1s
run 3: codemode, creates 7, distinct 6, duplicates 0, all six exist yes, 3 turns, out 436, $0.020, 8.8s
medians: creates 7, distinct 6, duplicates 0, turns 3, out 436, $0.023, 8.8s
```

**Reading.** Both sides show no duplicated write: in every run the model batched the six creates with `Promise.allSettled`, so a failure on the fourth call left the other five done and the retry redid only the failed record. With 3 runs per side and a model that already catches each item's failure, this task does not reproduce the duplication the readers reported; the measurement cannot show a gain from the ledger here, and none is claimed. The ledger's behaviour is proved by the plugin kit cases instead. A task that makes the model write a sequential script that throws on the failure would be the next measurement.

**Slice 2, measured 2026-10-07** (`node scripts/partial.ts --task ambiguous --runs 3`, same prompt; the fake store takes the fourth create, logs it as stored, and never answers it, so the call ends on `MCP_TOOL_TIMEOUT` set to 5 s; the store also has a `list_records` tool). A probe with the same fake server showed that the three ways of losing the answer, the server exiting after the write (`Connection closed`), a JSON-RPC error (`connection lost while creating r4`) and no answer under a short timeout (`MCP server "fake" tool "create_record" timed out after 3s`), each reach the `failed` ledger line with an engine message rather than the server's own error text, so each takes the throw branch of `execute`. The task uses the timeout, the case where the outcome is truly unknown.

Baseline (slice 1 only, a thrown call renders `failed`):

```
run 1: codemode, creates 6, distinct 6, duplicates 0, all six exist yes, listed before redo yes, 2 turns, out 303, $0.060, 10.0s
run 2: codemode, creates 6, distinct 6, duplicates 0, all six exist yes, listed before redo yes, 2 turns, out 334, $0.016, 10.3s
run 3: codemode, creates 6, distinct 6, duplicates 0, all six exist yes, listed before redo yes, 2 turns, out 321, $0.016, 11.1s
medians: creates 6, distinct 6, duplicates 0, turns 2, out 321, $0.016, 10.3s
```

On the change (a thrown call renders `unknown: ... (it may have taken effect; check before redoing it)`, and the description says to read the state first):

```
run 1: codemode, creates 6, distinct 6, duplicates 0, all six exist yes, listed before redo yes, 2 turns, out 346, $0.149, 10.7s
run 2: codemode, creates 6, distinct 6, duplicates 0, all six exist yes, listed before redo yes, 2 turns, out 317, $0.016, 13.4s
run 3: codemode, creates 6, distinct 6, duplicates 0, all six exist yes, listed before redo yes, 2 turns, out 333, $0.016, 10.2s
medians: creates 6, distinct 6, duplicates 0, turns 2, out 333, $0.016, 10.7s
```

**Reading.** No difference: no run duplicated a write on either side, and every run listed the store before touching r4 again (no run created r4 twice, so "listed before redo" here means it listed after the lost answer). The model reads a timeout as ambiguous without being told, so the unknown marking and the description line show no gain in this task; with 3 runs per side only a large difference could be claimed, and there is none. The marking's behaviour is proved by the plugin kit cases. The `$0.149` and `$0.060` first runs are cache creation on a cold start, not a property of either side.

**Rerun by the session, 2026-10-07** (review nit N2: the slice 1 numbers came from the coder alone). `node scripts/partial.ts --runs 3` on the tree with both slices: 3 of 3 runs used codemode, creates 7, distinct 6, duplicates 0, all six exist in every run, medians 3 turns, out 420, $0.023, 7.2 s. This matches the slice 1 tables; the default task is unchanged by slice 2.
