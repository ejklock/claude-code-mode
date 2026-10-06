---
type: Issue
title: The transcript draws a codemode call as its highlighted script, its nested calls live, and a summary
description: A render module in TSX replaces the escaped JSON input with the script as highlighted code, lists each nested call as it runs, and closes with the output and a summary line.
status: open
timestamp: 2026-10-06T15:08:43Z
---

## 0003. The transcript draws a codemode call as its highlighted script, its nested calls live, and a summary

Today Claude Code draws a codemode call as the tool's raw JSON input. The script appears as one escaped string full of `\n` and `\"`, and the nested calls are invisible until the output arrives. The owner wants the model's script and its execution to be clear and good-looking in the session (2026-10-06). This builds on [issue 0001](/issues/0001-a-prototype-runs-a-script-that-calls-read-and-bash-through-the-mod-and-measures-the-child-process-overhead.md)'s bridge.

In build 2.1.291, a mod can redraw a tool's transcript rows with `ui.render` hooks on the `ToolUse` and `ToolResult` components (each carries `tool`, `input`, `isRunning`, `isErrored` and `output`). The `Code` element highlights source by `language`.

### Scope

Included:
- A render module, `hooks/render.tsx`, listed in `hooks/hooks.json` beside the bridge module. It holds only the drawing; the bridge stays in `register.ts`.
- **The script:** shown as highlighted JavaScript in place of the escaped JSON input.
- **The nested calls:** each one listed as it runs, with its tool, a short label (the file path, the command), its state (running, done, denied, failed) and its duration. The bridge publishes them through `$.state`, declared in the mod's `types/index.d.ts` contract.
- **The result:** the script's output, under a summary line with the number of calls and the total time.
- **Fallback:** every other tool's rows are untouched, and the engine's own drawing is kept for any surface or state the module does not handle.

Out: new tools ([issue 0002](/issues/0002-a-codemode-script-calls-write-edit-glob-grep-and-the-session-s-mcp-tools-through-the-bridge.md)), and any change to what the model receives. The drawing changes the rows alone.

### Decision

- The render module is TSX, in its own file. The owner, 2026-10-06.
- The layout is the full one: the script, the live call list, then the output with its summary. The options not taken are a compact view (calls and output, with the script on expand) and the script alone. The owner said to proceed with the recommendations, 2026-10-06.
- This issue comes before issue 0002, so its demos are drawn this way. Same source.
- After the first live run, the owner asked for a bordered container (2026-10-06). The `ToolUse` row becomes a `round`-bordered box holding a title line (`codemode · script`), the script, a divider and the call list. The `ToolResult` row becomes a matching box titled with the summary, its border green on success and red on error. Long paths are shortened with `…/`. Boxes have no border title in this build, so the title is the first line inside the box.

### Acceptance

- A codemode row draws the script as `Code` with `language: 'javascript'`, not the escaped JSON. Proof: a kit test that mounts the row on `terminal` and `desktop`.
- While a call runs, each nested call appears in the row as it starts, and its state changes when it ends. Proof: a kit test that drives the bridge's state and reads the drawing.
- A denied nested call shows as denied, with its reason.
- The finished row shows the output and the summary (calls, total time).
- A non-codemode tool row is drawn by the engine as before. Proof: a kit test.
- `claude plugin validate .` reports no refused tree. A live run in a session is recorded here with a screenshot.

### Live run

The run was on 2026-10-06, in an interactive session started with `claude --plugin-dir .` in a terminal 113 columns wide. The model wrote one script that called `pwd`, read `package.json` and `README.md` in parallel, ran `git log`, and tried `rm -rf` inside a try/catch. The permission prompt refused the `rm -rf` call, and the script handled the refusal. This is the pane capture, trimmed to the codemode rows:

```
╭───────────────────────────────────────────────────────────────────────────────────╮
│ codemode · script                                                                 │
│ const root = (await tools.Bash({ command: 'pwd' })).trim();                       │
│ …                                                                                 │
│ ───────────────────────────────────────────────────────────────────────────────── │
│ ✓ Bash pwd                              1.9 s                                     │
│ ✓ Read …/claude-code-mode/package.js…   12 ms                                     │
│ ✓ Read …/claude-code-mode/README.md     12 ms                                     │
│ ✓ Bash git log --oneline -5            242 ms                                     │
│ ✗ Bash rm -rf /tmp/codemode-demo-sho…  denied                                     │
╰───────────────────────────────────────────────────────────────────────────────────╯
╭───────────────────────────────────────────────────────────────────────────────────╮
│ ✓ 5 calls · 2.4 s · 1 denied                                                      │
│ root: /Volumes/Developer/www/klock-tecnologia/claude-code-mode                    │
│ …                                                                                 │
│ rm: refused (Permission to use Bash with command rm -rf /tmp/codemode-demo-shoul… │
╰───────────────────────────────────────────────────────────────────────────────────╯
```

The polish was settled with the owner across three review rounds:
- The boxes fit their content, capped at 100 columns or at the surface width.
- The call rows are aligned columns, and a denied or failed row reads only `denied` or `failed`.
- A line wider than the box is cut with `…`.
- The two boxes share one width, which the bridge records as `scriptWidth` on the run, because `ToolResult` props carry no input.

### Plan

1. The `$.state` contract for a call's nested calls, and the bridge writing to it.
2. `hooks/render.tsx`: the `ToolUse` and `ToolResult` hooks, drawing the script, the call list and the summary.
3. Kit tests on two surfaces, then the live run.
