---
type: Issue
title: Research whether codemode scripts should also run Python, measured from the transcripts before any runtime
description: Measures how much inline shell and Python the model still writes, and compares WASM Python sandboxes, before any second language is decided.
status: open
timestamp: 2026-11-27T17:33:49Z
---

## 0025. Research whether codemode scripts should also run Python, measured from the transcripts before any runtime

Agents favour shell and Python for ad-hoc scripts. Today a codemode script is JavaScript only (the QuickJS runtime of `@earendil-works/pi-codemode`); shell already runs inside a script through `tools.Bash`. Issue 0013 measured inline Python and Node in `Bash` at 5.8% of the main session's `Bash` calls (`node scripts/transcripts.ts --since 2026-09-09`, run on 2026-10-09) and added a note to `Bash` that points such scripts to codemode. The Constitution puts "a runtime of our own that copies Pi's API" out of scope and asks for "the same script API as Pi's codemode".

### Scope

Included:
- A research note in `docs/research`: the share of inline shell and Python in the owner's transcripts since issue 0013, measured again with `scripts/transcripts.ts`.
- A comparison of WASM Python sandboxes that could expose the session tools as functions behind the same `$.tool.call` bridge, and whether Pi plans a second language.

Out:
- Any runtime code; a go decision opens its own issue with an ADR and a Constitution amendment.

### Decision

- **Research first**, over Python as a second codemode language now (a second runtime, an ADR and an amendment on an unmeasured gain), over a shell mode (a real shell reaches the disk directly, against the Non-negotiables) and over keeping JavaScript only with no measurement.

### Acceptance

- C1: the research note records the transcript counts with the command that produced them; `scripts/transcripts.ts`, which counts Python and Node kinds only, gains shell kinds first.
- C2: each sandbox claim cites its source.
- C3: the note states a go bar before measuring; issue 0013 used 1% of `Bash` calls.
- C4: `living-docs check docs` passes.
