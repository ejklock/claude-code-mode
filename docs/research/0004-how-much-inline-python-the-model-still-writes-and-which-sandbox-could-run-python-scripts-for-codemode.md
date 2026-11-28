---
type: Research
title: How much inline Python the model still writes and which sandbox could run Python scripts for codemode
description: Transcript counts of inline Python, Node and shell against the go bar of issue 0025, and a comparison of WASM Python sandboxes.
status: Draft
timestamp: 2026-11-28T02:30:58Z
---

# 0004. How much inline Python the model still writes and which sandbox could run Python scripts for codemode

## Question

Does the model still write enough inline Python through `Bash` to justify a second codemode script language, and if so which sandbox could run Python with codemode's shape (no file system, network or process except through injected async tool calls, a deadline, a memory cap, captured output) from the mod's Node child process? Motivated by [issue 0025](../issues/0025-research-whether-codemode-scripts-should-also-run-python-measured-from-the-transcripts-before-any-runtime.md); the go bar, set before measuring, is inline Python at or above 1% of the main session's `Bash` calls over 30 days.

## Method

- Transcripts: `node scripts/transcripts.ts --root ~/.claude-klock/projects` (default window, the 30 days from 2026-10-28 00:00 UTC) and `--since 2026-10-09` (since the `Bash` note of issue 0013), run on 2026-11-27 with the classifier of commit 04b84df (Python, Node and shell kinds, heredoc bodies skipped, commands over 100,000 characters counted apart). Counts only; no command text was read out. The classifier's Python and Node results equal the previous version's on all 108,390 `Bash` commands of these transcripts (a differential run, 0 disagreements).
- Sandboxes: primary sources (project documentation, repositories, npm metadata, a downloaded npm tarball), read on 2026-11-27 by a research agent; vendor documents about their own product are marked.

## Findings

| Finding | Evidence | Confidence |
|---|---|---|
| Main session, 30 days: 23,432 `Bash` calls; inline Python 638 (`python-c` 319, `python-stdin` 319) = 2.72%; inline Node 134 = 0.57%; `shell-loop` 1,488 = 6.35%; `shell-c` 93 = 0.40%; `shell-stdin` 5; codemode calls 5,952. | The command above, total line | high |
| Subagents (sidechain), 30 days: 71,446 `Bash` calls; inline Python 3,010 (`python-c` 382, `python-stdin` 2,628) = 4.21%; `shell-loop` 3,587 = 5.02%; `shell-c` 1,115 = 1.56%; codemode 2,677. | Same | high |
| Since 2026-10-09, main session: inline Python 670 of 25,084 = 2.67%. Issue 0013 measured inline Python and Node at 5.8% of main-session `Bash` calls before the note; Python and Node now stand at 3.29% over 30 days. | The `--since` run; issue 0013 Results | high |
| Inline shell loops are the largest inline-script kind, and they already fit codemode: a script runs a loop and calls `tools.Bash`. Shell counts lean slightly high (a loop shape inside quotes counts; an arithmetic shift is read as a heredoc and hides later shell lines) and slightly low (backticks, `until`, `time for`). | `scripts/inline-script.ts` header; issue 0025 Outcome | medium |
| Monty 1.7.0 (Pydantic) is the closest fit: a Rust Python interpreter with no file system, environment, network or process unless the host injects it; async host functions (`externalLookup`, "sync or async"); limits `maxTurnDurationSecs`, `maxMemory`, `maxRecursionDepth`; Node runs it in native workers or `worker_threads` (WASM). Costs: a Python subset (no `async for`, `async with`, user exception classes, third-party packages), about 30 MB (28.3 MB `.wasm`) plus native binaries, one young vendor product, no third-party audit. Vendor-authored sources. | [1], [2], [3], npm `@pydantic/monty@1.7.0` tarball | medium |
| Pyodide 314.0.8 gives full CPython on WASM (13.9 MB unpacked), but its `js` bridge sees `globalThis` by default with no documented switch to deny it, and CVE-2025-68668 was an escape through that bridge in n8n; a deadline needs a worker with `SharedArrayBuffer` (`setInterruptBuffer`); about 0.75 s to load in Node. | [4], [5], [6] | medium |
| MicroPython's WebAssembly port is small (1.1-2.4 MB) and supports `runPythonAsync` with top-level await, but denying `js` is undocumented and the browser build has no interrupts. RustPython and CPython on WASI document no async host calls. | [7], [8] | low |
| Pi, the codemode author, shows no plan for Python: `@earendil-works/pi-codemode` describes "Sandboxed JavaScript execution", and an issue "codemode: abstract over execution backend" was closed without action on 2026-10-05. | npm metadata; GitHub issue search | medium |

## Implications

- The go bar is met (2.72% ≥ 1%), so issue 0025's decision opens an ADR on a Python runtime. Any runtime is a second one beside QuickJS, outside the Constitution's "same script API as Pi's codemode", so the ADR needs an amendment if it chooses one.
- The ADR should weigh at least: no second runtime, with the guideline steering Python-shaped work into JavaScript codemode (the 5.8% → 3.3% drop after issue 0013's note shows guidance moves the share); Monty behind the same `$.tool.call` bridge; Pyodide with the `js` bridge removed. Shell loops, the larger share, need no runtime.

## Open Questions

- How much of the inline Python is work a codemode script could do (data processing over tool output) versus work that needs Python's libraries (pandas, numpy), which no sandbox here offers.
- The share of `python-stdin` in subagents (2,628) is far above the main session's; which agents write it was not measured.

# References

[1] [Monty security](https://pydantic.dev/docs/monty/concepts/security/). Available at: https://pydantic.dev/docs/monty/concepts/security/. Accessed on: 2026-11-27.
[2] [Monty resource limits](https://pydantic.dev/docs/monty/concepts/resource-limits/). Available at: https://pydantic.dev/docs/monty/concepts/resource-limits/. Accessed on: 2026-11-27.
[3] [Monty limitations](https://pydantic.dev/docs/monty/limitations/). Available at: https://pydantic.dev/docs/monty/limitations/. Accessed on: 2026-11-27.
[4] [Pyodide JavaScript API](https://pyodide.org/en/stable/usage/api/js-api.html). Available at: https://pyodide.org/en/stable/usage/api/js-api.html. Accessed on: 2026-11-27.
[5] [Pyodide keyboard interrupts](https://pyodide.org/en/stable/usage/keyboard-interrupts.html). Available at: https://pyodide.org/en/stable/usage/keyboard-interrupts.html. Accessed on: 2026-11-27.
[6] [CVE-2025-68668](https://feedly.com/cve/CVE-2025-68668). Available at: https://feedly.com/cve/CVE-2025-68668. Accessed on: 2026-11-27.
[7] [MicroPython WebAssembly port](https://github.com/micropython/micropython/tree/master/ports/webassembly). Available at: https://github.com/micropython/micropython/tree/master/ports/webassembly. Accessed on: 2026-11-27.
[8] [RustPython](https://github.com/RustPython/RustPython). Available at: https://github.com/RustPython/RustPython. Accessed on: 2026-11-27.
