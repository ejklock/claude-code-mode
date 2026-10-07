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

The transcript cap applies either way. Where the file lives and when it is removed is settled in slice 1 and recorded here.

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
