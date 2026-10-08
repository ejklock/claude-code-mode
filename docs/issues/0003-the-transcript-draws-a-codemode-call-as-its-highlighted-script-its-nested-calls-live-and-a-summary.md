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
- On a measured viewport the box is exactly the viewport's columns wide down to 8 columns, and the title is cut with `…` when it does not fit, which replaces "keeps the title's width" for the narrow case. A line is cut by terminal columns (CJK and emoji count two, combining marks none), so a wide character never pushes a line past the border. The owner, 2026-10-06.
- On 2026-10-08 the owner asked for the script to look like code in an editor. A mod sets no font (the terminal's font is used; `CodeProps` has no font prop), so three changes were chosen: the `Code` element numbers the lines (`startLine: 1`), the engine cuts a long line itself (`wrap: 'truncate-end'`, gutter aware) in place of `cutLines`, so the script reaches it whole, and the title reads like an editor tab, `codemode · script.js · N lines`. Reformatting the script for display was rejected: the row shows the exact text that ran. Without a viewport, the content width is the widest of a fixed title floor (the columns of `codemode · script.js · 999 lines`, 32), the longest line plus a 5-column gutter reserve, and the call rows, capped at 100. The floor is fixed because `ToolResult` cannot know the line count and the result box shares the width.

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

On 2026-10-06 the width rule changed after the owner asked for the width of Claude Code's own boxes: when the surface's `viewport.columns` is known, both boxes are `columns` wide (content `columns - 4`), with no 100-column cap and no margin, because the engine's own rules reach the same last column; without a viewport the boxes stay content-sized and capped at 100. Two live captures from `claude --plugin-dir .` in a pane, the pane resized between them (the second shows the script box and the top of the result box; the result box ends at the same column in the full frame):

```
93 columns
╭───────────────────────────────────────────────────────────────────────────────────────────╮
│ codemode · script                                                                         │
│ const c = await tools.Read({ file_path: "/private/tmp/claude-501/demo2c.2662Oy/work/ada.… │
│ console.log(c.length);                                                                    │
│ ───────────────────────────────────────────────────────────────────────────────────────── │
│ ✓ Read …/work/ada.md  10 ms                                                               │
╰───────────────────────────────────────────────────────────────────────────────────────────╯
╭───────────────────────────────────────────────────────────────────────────────────────────╮
│ ✓ 1 call · 120 ms                                                                         │
```

```
139 columns
╭─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ codemode · script                                                                                                                       │
│ const c = await tools.Read({ file_path: "/private/tmp/claude-501/demo2c.2662Oy/work/ada.md" });                                         │
│ console.log(c.length);                                                                                                                  │
│ ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │
│ ✓ Read …/work/ada.md  10 ms                                                                                                             │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
╭─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
```

The editor look, live on 2026-10-08 in a `claude --plugin-dir .` pane 112 columns wide, trimmed. The gutter takes 4 columns for a 17-line script, and the engine cuts a long line at the border:

```
╭────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ codemode · script.js · 17 lines                                                                            │
│   1 const root = '/Volumes/Developer/www/klock-tecnologia/claude-code-mode';                               │
│   2 const files = ['bridge.ts','describe.ts','expose.ts','exposure.ts','register.ts','render.tsx'].map(f … │
│   3 const results = await Promise.allSettled(files.map(f => tools.Read({ file_path: f })));                │
│   4 const rows = [];                                                                                       │
│   5 results.forEach((r, i) => {                                                                            │
│   6   const file = files[i].replace(root + '/', '');                                                       │
│ …                                                                                                          │
│ ────────────────────────────────────────────────────────────────────────────────────────────────────────── │
│ ✓ Read …/hooks/bridge.ts                19 ms                                                              │
```

Tracked from the review of that slice (nit, the owner chose to track it): `test/render.test.tsx` pins `TITLE_FLOOR = 32` by hand, like `WIDTH_CAP`, `FRAME` and `GUTTER`, so a title change must update it too.

### Plan

1. The `$.state` contract for a call's nested calls, and the bridge writing to it.
2. `hooks/render.tsx`: the `ToolUse` and `ToolResult` hooks, drawing the script, the call list and the summary.
3. Kit tests on two surfaces, then the live run.
