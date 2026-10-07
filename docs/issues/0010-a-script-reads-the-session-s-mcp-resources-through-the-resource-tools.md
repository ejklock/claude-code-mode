---
type: Issue
title: A script reads the session's MCP resources through the resource tools
description: Exposes ListMcpResourcesTool, ReadMcpResourceTool and ReadMcpResourceDirTool to codemode scripts, so a script can list and read MCP resources and print only what it needs.
status: closed
timestamp: 2026-10-07T03:50:05Z
---

## 0010. A script reads the session's MCP resources through the resource tools

The session has three built-in tools for MCP resources: `ListMcpResourcesTool`, `ReadMcpResourceTool` and `ReadMcpResourceDirTool`. A codemode script cannot call them today. With them, a script could list a server's resources, read several, and print only the part that matters, in one turn. This follows [research 0002](/research/0002-what-the-mcp-specification-recommends-for-tool-errors-annotations-structured-output-and-client-safety-and-how-codemode-stands.md).

### Scope

- The three resource tools are callable from a script through `$.tool.call`, like the other tools, and get a section in the description within its caps.
- Resource templates, subscriptions and change notifications are out.

### Decision

- Types check, 2026-10-07: the installed `claude-code-tools/index.d.ts` declares the three as built-in tools, so `$.tool.call` takes them. `ListMcpResourcesTool` takes `{ server? }` and returns `[{ uri, name, mimeType?, description?, server }]`. `ReadMcpResourceTool` takes `{ server, uri }` and returns `{ contents: [{ uri, mimeType?, text?, blobSavedTo? }], error? }`. `ReadMcpResourceDirTool` takes `{ server, uri }` and returns `{ resources: [{ uri, name, mimeType? }], error? }`. A script receives the text the model would read, as for every other tool.
- They join `EXPOSED_TOOLS` with a section each, like `Read`, always present. The other option was to show them only when an MCP server is connected. It was not taken because a server can have resources without tools, and three short sections fit the budget. This is cheap to reverse, so it needs no ADR.

### Acceptance

- A script lists the fake MCP server's resources and reads one; the test sees only the printed part.
- A permission denial on a resource read reaches the script as a failed call.

### Plan

One slice, after the types check.

### Results

- Done, 2026-10-07: `ListMcpResourcesTool`, `ReadMcpResourceTool` and `ReadMcpResourceDirTool` join `EXPOSED_TOOLS` with a `TOOL_SPECS` entry each, so the child declares them and the `code` description has a section for each, after `Edit`. No change to the bridge.
- End to end, with the stand-in server now offering two text resources: a script lists them, reads `fake://notes/beta` and prints only that text. With a deny rule on `ReadMcpResourceTool` the read fails inside the script, because the engine hides a denied tool as it does a denied MCP tool, and beta's text never appears. The e2e run went from 35 to 41 PASS.
