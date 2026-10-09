// A stand-in MCP server for the end-to-end run: stdio, newline-delimited JSON-RPC, two text resources,
// an `echo` tool and a `create_record` tool that fails once, on its fourth call, and logs every call to a ledger file.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const FAILING_CALL = 4
let creates = 0

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)

const LOST = process.env.FAKE_LOST_ANSWER

const RESOURCES = [
  { uri: 'fake://notes/alpha', name: 'alpha', mimeType: 'text/plain', text: 'alpha-note-text-first' },
  { uri: 'fake://notes/beta', name: 'beta', mimeType: 'text/plain', text: 'beta-note-text-second' },
]

function listRecords(id) {
  const ledger = process.env.FAKE_LEDGER
  if (ledger) appendFileSync(ledger, 'list\t\n')
  const lines = ledger && existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n') : []
  const names = [...new Set(lines.filter(line => line.startsWith('ok\t')).map(line => line.slice(3)))]
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: names.length === 0 ? 'no records' : names.join('\n') }] } })
}

// With FAKE_LOST_ANSWER set, the fourth create is stored and logged `ok` but its answer is lost:
// `exit` ends the server, `hang` never answers, `rpc-error` answers with a JSON-RPC error.
function loseAnswer(id, name) {
  if (LOST === 'exit') process.exit(0)
  if (LOST === 'rpc-error') send({ jsonrpc: '2.0', id, error: { code: -32000, message: `connection lost while creating ${name}` } })
}

function createRecord(id, name) {
  creates += 1
  const lost = LOST !== undefined && LOST !== '' && creates === FAILING_CALL
  const failed = creates === FAILING_CALL && !lost
  if (process.env.FAKE_LEDGER) appendFileSync(process.env.FAKE_LEDGER, `${failed ? 'fail' : 'ok'}\t${name}\n`)
  if (lost) {
    if (process.env.FAKE_LEDGER) appendFileSync(process.env.FAKE_LEDGER, `lost\t${name}\n`)
    return loseAnswer(id, name)
  }
  const text = failed ? `store unavailable while creating ${name}` : `created ${name}`
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], ...(failed ? { isError: true } : {}) } })
}

// `seal_record` needs a `seal` its description never names: a call without it is an error result.
// With FAKE_SEAL_LOG set, every call is logged `with` or `without` the argument, in order.
function sealRecord(id, seal) {
  const given = typeof seal === 'string' && seal !== ''
  if (process.env.FAKE_SEAL_LOG) appendFileSync(process.env.FAKE_SEAL_LOG, `${given ? 'with' : 'without'}\n`)
  const text = given ? `sealed with ${seal}` : 'missing required argument'
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], ...(given ? {} : { isError: true }) } })
}

function handle({ id, method, params }) {
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
      },
    })
  }
  if (method === 'resources/list') {
    const resources = RESOURCES.map(({ uri, name, mimeType }) => ({ uri, name, mimeType }))
    return send({ jsonrpc: '2.0', id, result: { resources } })
  }
  if (method === 'resources/read') {
    const found = RESOURCES.find(resource => resource.uri === params?.uri)
    if (found === undefined) return send({ jsonrpc: '2.0', id, error: { code: -32002, message: `no resource ${params?.uri}` } })
    const contents = [{ uri: found.uri, mimeType: found.mimeType, text: found.text }]
    return send({ jsonrpc: '2.0', id, result: { contents } })
  }
  if (method === 'tools/list') {
    const inputSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    const recordSchema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
    const sealSchema = { type: 'object', properties: { seal: { type: 'string', description: 'The seal to apply; any text is accepted.' } }, required: ['seal'] }
    const tools = [
      { name: 'echo', description: 'Echoes the text back.', inputSchema },
      { name: 'create_record', description: 'Creates a record in the fake store; takes { name }.', inputSchema: recordSchema },
      { name: 'list_records', description: 'Lists the names of the records in the fake store.', inputSchema: { type: 'object', properties: {} } },
      { name: 'seal_record', description: 'Seals the records of the fake store.', inputSchema: sealSchema },
    ]
    return send({ jsonrpc: '2.0', id, result: { tools } })
  }
  if (method === 'tools/call' && params?.name === 'list_records') return listRecords(id)
  if (method === 'tools/call' && params?.name === 'seal_record') return sealRecord(id, params.arguments?.seal)
  if (method === 'tools/call' && params?.name === 'create_record') return createRecord(id, params.arguments?.name ?? '')
  if (method === 'tools/call') {
    const text = `fake-echo: ${params?.arguments?.text ?? ''}`
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } })
}

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() !== '') handle(JSON.parse(line))
}
