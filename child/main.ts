import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import type { CodemodeResult, CodemodeTool } from '@earendil-works/pi-codemode'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OUTPUT_BUDGET, withinBudget } from '../shared/budget.ts'
import {
  ANSWER_PATH,
  EXPOSED_TOOLS,
  declarationOf,
  mcpDeclarationOf,
  parseCallAnswer,
  parseRunRequest,
} from '../shared/protocol.ts'
import type { CallAnswer, ChildMessage, McpTool } from '../shared/protocol.ts'

function send(message: ChildMessage): Promise<void> {
  return new Promise(resolve => process.stdout.write(`${JSON.stringify(message)}\n`, () => resolve()))
}

/** Calls the script makes, waiting for the mod's answer to each over the socket. */
class AnswerBoard {
  private readonly waiting = new Map<number, (answer: CallAnswer) => void>()
  private nextId = 1

  async ask(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const id = this.nextId++
    const answered = new Promise<CallAnswer>((resolve, reject) => {
      this.waiting.set(id, resolve)
      signal.addEventListener('abort', () => reject(new Error('the script ended')), { once: true })
    })
    await send({ type: 'call', id, tool, input })
    const answer = await answered.finally(() => this.waiting.delete(id))
    if (!answer.ok) throw new Error(answer.error)
    return answer.text
  }

  /** Returns whether `answer` matched a waiting call. */
  deliver(answer: CallAnswer): boolean {
    const resolve = this.waiting.get(answer.id)
    resolve?.(answer)
    return resolve !== undefined
  }
}

class AnswerSocket {
  private readonly directory = mkdtempSync(join(tmpdir(), 'codemode-'))
  readonly path = join(this.directory, 'bridge.sock')
  private readonly server: Server

  constructor(board: AnswerBoard) {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const answer = parseCallAnswer(Buffer.concat(chunks).toString('utf8'))
        const isAccepted = req.method === 'POST' && req.url === ANSWER_PATH && answer !== undefined
        res.statusCode = isAccepted && board.deliver(answer) ? 204 : 400
        res.end()
      })
    })
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.path, resolve)
    })
  }

  close(): Promise<void> {
    return new Promise<void>(resolve => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    }).finally(() => rmSync(this.directory, { recursive: true, force: true }))
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function outputText(result: CodemodeResult): string {
  return result.output.flatMap(item => (item.type === 'text' ? [item.text] : [])).join('\n')
}

/** A folder of its own per run, so two runs never share or overwrite a file. */
function spillToFile(whole: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'codemode-output-')), 'output.txt')
  writeFileSync(path, whole, 'utf8')
  return path
}

class CodemodeChild {
  async run(): Promise<void> {
    const request = parseRunRequest(await readStdin())
    if (request === undefined) {
      await send({ type: 'done', ok: false, error: 'the run request on standard input is malformed', output: '' })
      return
    }
    const board = new AnswerBoard()
    const socket = new AnswerSocket(board)
    const sandbox = new CodemodeSandbox({ tools: this.tools(board, request.mcpTools), timeoutMs: request.timeoutMs })
    try {
      await socket.listen()
      await send({ type: 'listening', socketPath: socket.path })
      const result = await sandbox.execute(request.code)
      await socket.close()
      await send(this.closing(result))
    } catch (error) {
      await socket.close()
      const message = error instanceof Error ? error.message : String(error)
      await send({ type: 'done', ok: false, error: message, output: '' })
    } finally {
      await sandbox.close()
    }
  }

  private tools(board: AnswerBoard, mcpTools: readonly McpTool[]): CodemodeTool[] {
    const builtIn = EXPOSED_TOOLS.map(name => ({ name, ...declarationOf(name) }))
    const mcp = mcpTools.map(tool => ({ name: tool.name, ...mcpDeclarationOf(tool) }))
    return [...builtIn, ...mcp].map(declared => ({
      ...declared,
      execute: (args, { signal }) => board.ask(declared.name, this.asInput(args), signal),
    }))
  }

  private asInput(args: unknown): Record<string, unknown> {
    const isObject = typeof args === 'object' && args !== null && !Array.isArray(args)
    return isObject ? (args as Record<string, unknown>) : {}
  }

  private closing(result: CodemodeResult): ChildMessage {
    const output = withinBudget(outputText(result), OUTPUT_BUDGET, spillToFile)
    return result.ok
      ? { type: 'done', ok: true, output }
      : { type: 'done', ok: false, error: result.error.message, output }
  }
}

await new CodemodeChild().run()
process.exit(0)
