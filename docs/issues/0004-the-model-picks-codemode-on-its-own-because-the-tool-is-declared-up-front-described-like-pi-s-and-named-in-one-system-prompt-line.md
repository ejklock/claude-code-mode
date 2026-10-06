---
type: Issue
title: The model picks codemode on its own, because the tool is declared up front, described like Pi's, and named in one system prompt line
description: Like Pi, the mod keeps codemode out of ToolSearch, gives it a description listing its globals and nested tools, and adds one system prompt guideline, so the model reaches for it without being told.
status: open
timestamp: 2026-10-06T16:50:30Z
---

## 0004. The model picks codemode on its own, because the tool is declared up front, described like Pi's, and named in one system prompt line

On 2026-10-06 the owner checked whether the model uses codemode by default. A session got "List the TypeScript files tracked by git, read them all, and report each file's TODOs." without the word codemode. The model used `Bash` twice, `git ls-files` and then a `for … cat -n` loop, and never codemode.

There are two causes:
- **The tool is deferred.** Claude Code lists `mcp__codemode__codemode` behind ToolSearch, so the model sees only its name.
- **Nothing says when to use it.** The description gives no criterion.

Pi solves this in `extensions/codemode/tool.js` (installed `@earendil-works/pi-coding-agent` 1.0.4):
- the tool is always declared;
- a `promptGuidelines` line in the system prompt;
- a rich description listing the intro, the globals and each nested tool's call and result.

This issue does the same through the build's `tool.describe` and `prompt.compose` hooks. It builds on [issue 0001](/issues/0001-a-prototype-runs-a-script-that-calls-read-and-bash-through-the-mod-and-measures-the-child-process-overhead.md).

### Scope

Included:
- **Declared up front:** a `tool.describe` hook on `mcp__codemode__codemode` answers `isDeferred: false`.
- **Description like Pi's:** the same hook answers a description in Pi's shape.
  - An intro: raw JavaScript, run as an async function body; top-level `await` and `return`; no Node, file system, network or timers.
  - The globals this bridge supports.
  - One section per exposed tool: its call (`tools.Read(args)`), its arguments and what it resolves to.
  - Every claim matches what the child really offers.
- **One system prompt line:** a `prompt.compose` hook appends one `session` section with Pi's guideline: "Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls."

Out of scope:
- Rewriting the built-in tools' descriptions (Pi's mode "on" note, `Codemode: tools.Read(args) resolves to a string.`). It is deferred, because it touches the engine's own tools.
- New tools ([issue 0002](/issues/0002-a-codemode-script-calls-write-edit-glob-grep-and-the-session-s-mcp-tools-through-the-bridge.md)).

### Decision

- **Follow Pi's three layers:** declared up front, a rich description and one system prompt line. The owner, 2026-10-06.
- **Options not taken:**
  - a skill in the plugin (two hops before the tool is usable);
  - a longer system prompt section (a cost on every turn);
  - leaving it explicit-only.
- **The fourth layer**, a note on each built-in tool's description, waits until these three are measured.

### Acceptance

- Codemode is listed in the prompt rather than behind ToolSearch, and its description holds the intro, the globals and the Read and Bash sections. Proof: a kit test through the `tool.describe` hook.
- The system prompt holds the guideline once, as a `session` section after every `shared` one, and the other sections are untouched. Proof: a kit test through the `prompt.compose` hook.
- **Adoption.** A headless run of the task above, without the word codemode, is repeated 5 times. The number of runs that call `mcp__codemode__codemode` is recorded here, with the same count measured before the change. Measured with `node scripts/adoption.ts`, 5 runs each, on 2026-10-06:
  - before the change (`--baseline`, HEAD c9055f3): codemode used in 0 of 5 runs, every run called `Bash` only;
  - after the change: codemode used in 5 of 5 runs, every run called `mcp__codemode__codemode` only.

### Plan

1. The `tool.describe` and `prompt.compose` hooks with kit tests.
2. The adoption script, run before and after; the counts recorded here.
