---
type: Research
title: What the MCP specification recommends for tool errors, annotations, structured output and client safety, and how codemode stands
description: Verbatim quotes from the MCP 2025-06-18 tools page and schema.ts on isError versus protocol errors, tool annotations, outputSchema and structuredContent, and client SHOULDs, checked against the installed Claude Code mods API.
status: Draft
timestamp: 2026-10-07T03:43:10Z
---

# 0002. What the MCP specification recommends for tool errors, annotations, structured output and client safety, and how codemode stands

## Question

Does codemode's handling of nested MCP calls follow what the MCP specification recommends for errors, tool annotations, structured output and client safety? Which recommendations could make retries safer or scripts cheaper, given what the installed Claude Code mods API exposes? This question motivates the ledger's read-only marking (issue 0006 follow-up), the structured-output change (an ADR still to be written), and an upstream request for the annotations.

## Method

On 2026-10-07 I read the MCP specification revision 2025-06-18: the Tools page [1] and `schema.ts` [2], plus the key changes of revision 2026-07-28 [3]. I then searched the installed mods API types, `.claude-plugin/types/claude-code/index.d.ts` for Claude Code 2.1.291 as committed, for `ToolInfo`, `ToolCallResult`, `McpToolResult`, `isReadOnly`, `structuredContent` and the annotation names. Quotes are verbatim.

## Findings

| Finding | Evidence | Confidence |
|---|---|---|
| A tool's own failure belongs in the result: "Any errors that originate from the tool SHOULD be reported inside the result object, with `isError` set to true, _not_ as an MCP protocol-level error response." Protocol errors cover "Unknown tools", "Invalid arguments" and "Server errors". | [2] `CallToolResult.isError`; [1] Error Handling | high |
| The ledger's split matches this: an `isError` result is `failed`, and a thrown call is `unknown`. "Unknown tool" and "invalid arguments" mean the tool never ran, so they would be definite failures. The engine gives the mod only the error message, not the JSON-RPC code, so the ledger cannot tell them apart and stays conservative. | [1]; `hooks/bridge.ts` › `execute`; issue 0006 probe | medium |
| Annotations: `readOnlyHint` ("the tool does not modify its environment", default false), `destructiveHint` (default true, "meaningful only when `readOnlyHint == false`"), `idempotentHint` ("calling the tool repeatedly with the same arguments will have no additional effect", default false) and `openWorldHint` (default true). | [2] `ToolAnnotations` | high |
| "Clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers." | [1] Data Types › Tool | high |
| The mods API exposes `isReadOnly?: true` on a call's result, "for an MCP tool, its server's declaration". It is set only after the call returns. `ToolInfo` has only `name`, `description` and `mcp`. No `idempotentHint` or `destructiveHint` appears anywhere in the types. | installed `index.d.ts` › `ToolCallResult`, `ToolInfo` | high |
| Structured output: when a tool declares `outputSchema`, "Servers **MUST** provide structured results that conform to this schema" and "a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block". The mods API's `McpToolResult` carries `structuredContent?: unknown`, "when its tool declares an output schema". Codemode passes scripts only the joined text today. | [1] Structured Content, Output Schema; installed `index.d.ts` › `McpToolResult` | high |
| Client SHOULDs: "Prompt for user confirmation on sensitive operations", "Implement timeouts for tool calls" and "Log tool usage for audit purposes"; also "there **SHOULD** always be a human in the loop with the ability to deny tool invocations". Codemode meets them through `$.tool.call` (permissions and hooks), the engine's `MCP_TOOL_TIMEOUT` plus the script timeout, and the transcript rows. | [1] User Interaction Model, Security Considerations; CLAUDE.md hard rule 1 | high |
| Revision 2026-07-28 asks for a stable list order: "Servers **SHOULD** return tools from `tools/list` in a deterministic order to enable client-side caching and improve LLM prompt cache hit rates." Codemode already orders each server's sections by name (`hooks/describe.ts`), so its description depends only on which tools exist, not on the order they arrive in. | [3] Minor changes 3; `hooks/describe.ts` › `selectSections` | high |
| Revision 2026-07-28 moves cross-call state into handles: "Servers that need cross-call state use explicit, server-minted handles passed as ordinary tool arguments." A script can hold such a handle in a variable and pass it on without printing it, so the handle never enters the context. | [3] Major changes 1 | high |
| Revision 2026-07-28 moves tasks to an extension: "Move experimental tasks out of the core protocol and into an official extension (`io.modelcontextprotocol/tasks`)", with polling through `tasks/get`. A task handle would let a script check a long or failed operation again instead of redoing it. The installed mods types show no sign of this extension, and the sandbox has no timers to wait between polls. | [3] Major changes 6; installed `index.d.ts` | medium |
| Revision 2026-07-28 loosens the schemas: "Loosen `inputSchema` and `outputSchema` to allow any JSON Schema 2020-12 keywords, and `structuredContent` to allow any JSON value. Add `$ref` resolution requirements." | [3] Minor changes 10 | high |
| Revision 2026-07-28 deprecates three features: "Deprecate the Roots, Sampling, and Logging features." The suggested migration for Sampling is to "integrate directly with LLM provider APIs instead of Sampling". | [3] Deprecated 1 | high |

## Implications

- The ledger can mark a call that returned `isReadOnly` as read-only, so a retry knows what is safe to redo. The marking speaks for that call as run, and per [1] it is only as trustworthy as the server.
- Passing `structuredContent` to scripts, typed from `outputSchema`, could shorten scripts and remove text parsing. It changes what a script receives, so it needs an ADR and a measurement first. Per [1], text-only scripts keep working because the server SHOULD also send the JSON as text.
- An exact retry guard would need `idempotentHint` and `destructiveHint`. The mods API does not expose them, so that is an upstream request, not codemode work.
- The description can tell scripts to hold server-minted handles in variables and pass them on unprinted (issue 0008).
- The structured-output change must handle JSON Schema 2020-12 output schemas, `$ref` included, when it generates a tool's declaration (issue 0009).
- Codemode adopts none of the deprecated features (Roots, Sampling, Logging).
- The tasks extension stays future research until the engine supports it.

## Open Questions

- Whether the engine sets `isReadOnly` for MCP tools whose server declares no `readOnlyHint`. The spec defaults it to false, so the mark should be absent.
- How many connected MCP servers declare `outputSchema` in practice. That decides whether the structured-output change pays.

# References

[1] [Model Context Protocol, Tools (revision 2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/server/tools). Available at: https://modelcontextprotocol.io/specification/2025-06-18/server/tools. Accessed on: 2026-10-07.

[2] [Model Context Protocol, schema.ts (2025-06-18)](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-06-18/schema.ts). Available at: https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-06-18/schema.ts. Accessed on: 2026-10-07.

[3] [Model Context Protocol, Key Changes (revision 2026-07-28)](https://modelcontextprotocol.io/specification/latest/changelog). Available at: https://modelcontextprotocol.io/specification/latest/changelog. Accessed on: 2026-10-07.
