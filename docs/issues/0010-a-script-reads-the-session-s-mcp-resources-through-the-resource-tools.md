---
type: Issue
title: A script reads the session's MCP resources through the resource tools
description: Exposes ListMcpResourcesTool, ReadMcpResourceTool and ReadMcpResourceDirTool to codemode scripts, so a script can list and read MCP resources and print only what it needs.
status: open
timestamp: 2026-10-07T03:50:05Z
---

## 0010. A script reads the session's MCP resources through the resource tools

The session has three built-in tools for MCP resources: `ListMcpResourcesTool`, `ReadMcpResourceTool` and `ReadMcpResourceDirTool`. A codemode script cannot call them today. With them, a script could list a server's resources, read several, and print only the part that matters, in one turn. This follows [research 0002](/research/0002-what-the-mcp-specification-recommends-for-tool-errors-annotations-structured-output-and-client-safety-and-how-codemode-stands.md).

### Scope

- The three resource tools are callable from a script through `$.tool.call`, like the other tools, and get a section in the description within its caps.
- Resource templates, subscriptions and change notifications are out.

### Decision

- Not started. First check, in the installed build's types, that the three tools are reachable through `$.tool.call` and what they return.

### Acceptance

- A script lists the fake MCP server's resources and reads one; the test sees only the printed part.
- A permission denial on a resource read reaches the script as a failed call.

### Plan

One slice, after the types check.
