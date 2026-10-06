// A stand-in MCP server for the end-to-end run: stdio, newline-delimited JSON-RPC, one `echo` tool.
import { createInterface } from 'node:readline'

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)

function handle({ id, method, params }) {
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
      },
    })
  }
  if (method === 'tools/list') {
    const inputSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    return send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'echo', description: 'Echoes the text back.', inputSchema }] } })
  }
  if (method === 'tools/call') {
    const text = `fake-echo: ${params?.arguments?.text ?? ''}`
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } })
}

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() !== '') handle(JSON.parse(line))
}
