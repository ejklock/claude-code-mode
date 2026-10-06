# claude-code-mode

A Claude Code mod that gives the model one `codemode` tool, after Pi's codemode: the model writes a JavaScript script that calls the session's tools as `tools.<name>(args)`, and only the script's output returns. The script runtime is `@earendil-works/pi-codemode` in a Node child process; every nested call returns to the mod and runs through `$.tool.call`. A pilot, started on 2026-10-06.

Start at the [Constitution](docs/constitution.md). The decisions and the open work are in [docs/index.md](docs/index.md).

## Living Docs

```
enforcement: guided   # strict | guided | lite
onboarded: 2026-10-06
```

Write an ADR only when a decision is expensive to reverse; every other decision lives in the issue that carries the work. Load-bearing decisions are confirmed with the owner before an ADR is recorded. `living-docs check docs` must pass; numbering, frontmatter and index rows are CLI-owned (`living-docs new/set/supersede/index/fmt`).

| Artifact | Location |
|---|---|
| Constitution | `docs/constitution.md` |
| ADRs | `docs/adr/` |
| Issues | `docs/issues/` |
| Research | `docs/research/` |

## Hard rules

1. **Every nested call goes through `$.tool.call`.** Never `$.mcp.call`: it skips the permission prompt.
2. **`@earendil-works/pi-codemode` is pinned to an exact version.** An upgrade is its own change.
3. **All artifacts in English.** Conversation follows the owner's language.
4. **Diagrams are Mermaid.**
5. **The mods API is early access.** Read the installed build's type declarations before using a call; never trust memory of the API.

## Commit authorship

Git `Author` is `Evaldo Klock <neto.nemesis@gmail.com>`.
