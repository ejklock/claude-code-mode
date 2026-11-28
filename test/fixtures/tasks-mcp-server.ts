// A stand-in MCP server for the tasks-extension check: stdio, newline-delimited JSON-RPC. Its `long_job` tool
// answers with a task instead of a result, and `tasks/get` reports it working once, then completed. The
// answers follow the MCP tasks extension schema (2026-07-28: Task, CreateTaskResult, GetTaskResult).
// With TASKS_REQUEST_LOG set, every request is appended to that file as one JSON line.
// It answers `tools/call` with a task whatever the client declared, though the specification says never to
// return a task to a client that did not declare support: that is deliberate, so a build that does not
// declare the extension shows the error it produces when handed a task.
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const TASK_ID = 'task-1'
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'
const SERVER_INFO = { name: 'tasks', version: '1.0.0' }
const TASK_TTL_MS = 60_000
let createdAt: string | undefined
let polls = 0

type TaskStatus = 'working' | 'completed'
type TaskFields = {
  taskId: string
  status: TaskStatus
  createdAt: string
  lastUpdatedAt: string
  ttlMs: number | null
  pollIntervalMs: number
}
type CallToolResult = { resultType: 'complete'; content: { type: 'text'; text: string }[] }
type CreateTaskResult = TaskFields & { resultType: 'task' }
type GetTaskResult = TaskFields & { resultType: 'complete'; result?: CallToolResult }
type Cacheable = { resultType: 'complete'; ttlMs: number; cacheScope: 'public' | 'private'; _meta: { [SERVER_INFO_KEY]: typeof SERVER_INFO } }
type DiscoverResult = Cacheable & {
  supportedVersions: string[]
  capabilities: { tools: object; extensions: Record<string, object> }
}
type ListToolsResult = Cacheable & { tools: { name: string; description: string; inputSchema: object }[] }

const send = (message: unknown): boolean => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id: unknown, result: unknown): boolean => send({ jsonrpc: '2.0', id, result })

const taskFields = (status: TaskStatus, now: Date): TaskFields => ({
  taskId: TASK_ID,
  status,
  createdAt: createdAt ?? now.toISOString(),
  lastUpdatedAt: now.toISOString(),
  ttlMs: TASK_TTL_MS,
  pollIntervalMs: 100,
})

export function createTaskResult(now: Date = new Date()): CreateTaskResult {
  createdAt = now.toISOString()
  return { resultType: 'task', ...taskFields('working', now) }
}

export function taskAnswer(poll: number, now: Date = new Date()): GetTaskResult {
  if (poll === 1) return { resultType: 'complete', ...taskFields('working', now) }
  const result: CallToolResult = { resultType: 'complete', content: [{ type: 'text', text: 'long-job-finished' }] }
  return { resultType: 'complete', ...taskFields('completed', now), result }
}

const cacheable = (): Cacheable => ({
  resultType: 'complete',
  ttlMs: 0,
  cacheScope: 'public',
  _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
})

export const discoverResult = (): DiscoverResult => ({
  ...cacheable(),
  supportedVersions: ['2026-07-28'],
  capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } },
})

export const toolsListResult = (): ListToolsResult => ({
  ...cacheable(),
  tools: [{ name: 'long_job', description: 'Starts a long job and answers with a task.', inputSchema: { type: 'object', properties: {} } }],
})

type Request = { id?: unknown; method?: string; params?: { protocolVersion?: string } }

function handle(request: Request): void {
  const { id, method, params } = request
  if (process.env['TASKS_REQUEST_LOG']) appendFileSync(process.env['TASKS_REQUEST_LOG'], `${JSON.stringify(request)}\n`)
  if (method === 'server/discover') {
    reply(id, discoverResult())
    return
  }
  if (method === 'initialize') {
    reply(id, { protocolVersion: params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: SERVER_INFO })
    return
  }
  if (method === 'tools/list') {
    reply(id, toolsListResult())
    return
  }
  if (method === 'tools/call') {
    reply(id, createTaskResult())
    return
  }
  if (method === 'tasks/get') {
    polls += 1
    reply(id, taskAnswer(polls))
    return
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.trim() !== '') handle(JSON.parse(line) as Request)
  }
}
