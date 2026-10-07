---
type: Issue
title: A script receives an MCP tool's structured result, typed from its output schema
description: Passes structuredContent to codemode scripts when an MCP tool declares an outputSchema, with the declaration typed from it; needs an ADR and a measurement before code.
status: open
timestamp: 2026-10-07T03:43:54Z
---

## 0009. A script receives an MCP tool's structured result, typed from its output schema

When an MCP tool declares an `outputSchema`, the engine's result carries `structuredContent` ([research 0002](/research/0002-what-the-mcp-specification-recommends-for-tool-errors-annotations-structured-output-and-client-safety-and-how-codemode-stands.md)). Today a codemode script gets only the joined text and parses it itself. A typed object could shorten scripts and remove parsing mistakes.

### Scope

- The script receives the structured result for a tool that declares an `outputSchema`, and the tool's section declares that type.
- Text-only tools and scripts that read text keep working.
- Since MCP revision 2026-07-28, an `outputSchema` may use any JSON Schema 2020-12 keyword, with `$ref` resolution required, and `structuredContent` may be any JSON value, not only an object. The declaration must resolve `$ref` and fall back to `unknown` for a schema it cannot type.

### Decision

- Not started. It changes what a script receives, so an ADR comes first. Before that ADR, a measurement checks how many connected servers declare `outputSchema` and whether scripts get shorter.

### Acceptance

- An ADR records the shape, accepted by the owner.
- A measurement shows the effect on script length and tokens.

### Plan

1. Measure how common `outputSchema` is, and write the ADR.
2. Build it, then measure again.
