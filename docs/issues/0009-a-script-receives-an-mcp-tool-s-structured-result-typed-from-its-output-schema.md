---
type: Issue
title: A script receives an MCP tool's structured result, typed from its output schema
description: Passes structuredContent to codemode scripts when an MCP tool declares an outputSchema, with the declaration typed from it; needs an ADR and a measurement before code.
status: closed
timestamp: 2026-10-07T03:43:54Z
---

## 0009. A script receives an MCP tool's structured result, typed from its output schema

When an MCP tool declares an `outputSchema`, the engine's result carries `structuredContent` ([research 0002](/research/0002-what-the-mcp-specification-recommends-for-tool-errors-annotations-structured-output-and-client-safety-and-how-codemode-stands.md)). Today a codemode script gets only the joined text and parses it itself. A typed object could shorten scripts and remove parsing mistakes.

### Scope

- The script receives the structured result for a tool that declares an `outputSchema`, and the tool's section declares that type.
- Text-only tools and scripts that read text keep working.
- Since MCP revision 2026-07-28, an `outputSchema` may use any JSON Schema 2020-12 keyword, with `$ref` resolution required, and `structuredContent` may be any JSON value, not only an object. The declaration must resolve `$ref` and fall back to `unknown` for a schema it cannot type.

### Decision

- Types check, 2026-10-07: `structuredContent` appears only on `McpToolResult`, which `$.mcp.call` returns, and CLAUDE.md hard rule 1 forbids that call. On `$.tool.call`, an MCP tool's `result` is typed `unknown` (`ToolResultOf`), and `text` holds the joined text blocks. Whether that `result` carries the structured content is not documented, so a probe must show it first: a fake tool that declares an `outputSchema`, called through `$.tool.call`, with its `result` printed. If `result` does not carry it, the change needs an upstream request, not codemode work.
- Closed without a change, by the owner on 2026-10-07, after the probe below. A script already receives the structured content as JSON text and can `JSON.parse` it. Typed declarations are not possible, because the mods API exposes no `outputSchema`. Two options were not taken: a description line about `JSON.parse` with an upstream request for `outputSchema` on `ToolInfo`, and parsing in the bridge, which would have to guess from the text. The Acceptance below no longer applies.

### Acceptance

- An ADR records the shape, accepted by the owner.
- A measurement shows the effect on script length and tokens.

### Plan

1. Measure how common `outputSchema` is, and write the ADR.
2. Build it, then measure again.

### Probe

- Date: 2026-10-07. Claude Code 2.1.292, model claude-opus-5-5, one headless `claude -p` run with `--plugin-dir` on a throwaway copy of the mod. In the copy, the fake MCP server gained `get_point` (text block `{"x":1,"y":2}`, `structuredContent` `{ x: 1, y: 2 }`) and `get_point_text_differs` (text block `point ready`, `structuredContent` `{ x: 3, y: 4 }`), both declaring the `outputSchema` `{ x, y: number }`, and `CodemodeBridge.execute` appended `PROBE-RESULT ` plus `JSON.stringify` of the whole `ToolCallResult` to the text the script received. The script called both tools through `tools.mcp__fake__*`, which is `$.tool.call`, and never `$.mcp.call`.
- Raw lines the script received:

```
A: {"x":1,"y":2}
PROBE-RESULT {"result":"{\"x\":1,\"y\":2}","text":"{\"x\":1,\"y\":2}"}
B: {"x":3,"y":4}
PROBE-RESULT {"result":"{\"x\":3,\"y\":4}","text":"{\"x\":3,\"y\":4}"}
```

- Answer: for a tool that declares an `outputSchema`, core returns the `structuredContent` serialized as a JSON string, in both `result` and `text`; the two fields are identical and the ToolCallResult holds no other key. For `get_point_text_differs` the server's text block `point ready` never reaches the script: `text` is `{"x":3,"y":4}`, the `structuredContent`, so core replaces the text blocks with the structured value. `result` is a string, not an object, so a script would have to `JSON.parse` it; no field carries a parsed `{ x, y }`. This is one run on one tool-call path and records no decision on the ADR.
