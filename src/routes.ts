/**
 * The /api/dsh-winrm route family: host CRUD, exec, cluster, services,
 * processes, remote listing, NDJSON upload progress, binary download, and
 * the WebSocket PowerShell console upgrade. Every route carries a
 * loopback-only trust fence (plus browser same-origin markers) — these
 * endpoints execute commands on remote machines, so LAN-exposed dsh web
 * deployments must not serve them.
 */

import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { WinRmEngine } from './engine.ts'
import { isLoopbackRequest } from './loopback.ts'
import { WINRM_API, type ConsoleClientFrame, type ConsoleServerFrame, type WinHostPayload } from './protocol.ts'
import type { HostStore } from './store.ts'

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** Cap on declared upload bodies (staged to disk before chunking out). */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024

/** One noServer WebSocket server for console upgrades. */
const consoleWss = new WebSocketServer({ noServer: true })

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** URL query helper (first value, decoded). */
function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Route family dependencies. */
export interface WinrmRoutesDeps {
  store: HostStore
  engine: WinRmEngine
  stagingDir?: string
  maxUploadBytes?: number
}

/**
 * Build every /api/dsh-winrm route plus the console upgrade.
 * @param deps - store, engine, staging dir.
 */
export function makeRoutes(deps: WinrmRoutesDeps): { routes: WebRoute[]; upgrade: WebUpgradeRoute } {
  const { store, engine } = deps
  const staging = deps.stagingDir ?? join(tmpdir(), 'dsh-winrm-uploads')
  const maxUploadBytes = deps.maxUploadBytes ?? MAX_UPLOAD_BYTES
  mkdirSync(staging, { recursive: true, mode: 0o700 })

  /** Guard helper: fence + method check. */
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  const routes: WebRoute[] = [
    // ------------------------------------------------------------ hosts
    {
      kind: 'exact',
      path: WINRM_API.hosts,
      handler: async (req, res) => {
        const method = req.method ?? 'GET'
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'GET') {
          writeJson(res, 200, { hosts: engine.list(queryParam(url, 'query')) })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const entry = store.create(body as unknown as WinHostPayload)
            writeJson(res, 201, { host: store.summarize(entry) })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (method !== 'PATCH' && method !== 'DELETE') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const alias = queryParam(url, 'alias')
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const entry = store.update(alias, body as unknown as Partial<WinHostPayload>)
            writeJson(res, 200, { host: store.summarize(entry) })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (method === 'DELETE') {
          try {
            store.delete(alias)
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        writeJson(res, 405, { error: `method not allowed: ${method}` })
      },
    },
    // ------------------------------------------------------------ ops
    {
      kind: 'exact',
      path: WINRM_API.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          writeJson(res, 200, { result: await engine.test(alias) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: WINRM_API.exec,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        const command = typeof body?.command === 'string' ? body.command : ''
        if (alias === '' || command === '') {
          writeJson(res, 400, { error: 'alias and command are required' })
          return
        }
        const timeoutMs = typeof body?.timeoutMs === 'number' ? body.timeoutMs : undefined
        try {
          writeJson(res, 200, { result: await engine.exec(alias, command, timeoutMs) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: WINRM_API.cluster,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const command = typeof body?.command === 'string' ? body.command : ''
        if (command === '') {
          writeJson(res, 400, { error: 'command is required' })
          return
        }
        const aliases = Array.isArray(body?.aliases) ? body.aliases.filter((x): x is string => typeof x === 'string') : undefined
        const tags = Array.isArray(body?.tags) ? body.tags.filter((x): x is string => typeof x === 'string') : undefined
        const environment = typeof body?.environment === 'string' ? body.environment : undefined
        const timeoutMs = typeof body?.timeoutMs === 'number' ? body.timeoutMs : undefined
        const maxWorkers = typeof body?.maxWorkers === 'number' ? body.maxWorkers : undefined
        try {
          writeJson(res, 200, { results: await engine.cluster({ command, aliases, environment, tags, timeoutMs, maxWorkers }) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---------------------------------------------------------- services
    {
      kind: 'exact',
      path: WINRM_API.services,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        const name = typeof body?.name === 'string' ? body.name : ''
        const action = typeof body?.action === 'string' ? body.action : 'list'
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          if (action === 'list' || name === '') {
            writeJson(res, 200, { services: await engine.listServices(alias) })
          } else {
            const service = await engine.serviceAction(alias, name, action as 'start' | 'stop' | 'restart' | 'set-auto' | 'set-manual' | 'set-disabled')
            writeJson(res, 200, { service })
          }
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // --------------------------------------------------------- processes
    {
      kind: 'exact',
      path: WINRM_API.processes,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        const action = typeof body?.action === 'string' ? body.action : 'list'
        const id = typeof body?.id === 'number' ? body.id : undefined
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          if (action === 'kill' && id !== undefined) {
            await engine.killProcess(alias, id)
            writeJson(res, 200, { killed: id })
          } else {
            writeJson(res, 200, { processes: await engine.listProcesses(alias) })
          }
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ----------------------------------------------------------------- ls
    {
      kind: 'exact',
      path: WINRM_API.ls,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const dir = queryParam(url, 'path') ?? 'C:\\'
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        try {
          writeJson(res, 200, { entries: await engine.ls(alias, dir) })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // --------------------------------------------------------- upload
    {
      kind: 'exact',
      path: WINRM_API.upload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const remotePath = queryParam(url, 'remotePath')
        if (alias === undefined || remotePath === undefined) {
          writeJson(res, 400, { error: 'alias and remotePath query parameters are required' })
          return
        }
        const channel = queryParam(url, 'channel') ?? 'auto'
        const declared = Number(req.headers['content-length'])
        if (Number.isFinite(declared) && declared > maxUploadBytes) {
          writeJson(res, 413, { error: 'upload body too large' })
          return
        }
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-cache',
          'referrer-policy': 'no-referrer',
        })
        const emit = (line: unknown): void => {
          try { res.write(JSON.stringify(line) + '\n') } catch { /* client gone */ }
        }
        const tmp = join(staging, `upload-${randomBytes(6).toString('hex')}`)
        const sink = createWriteStream(tmp, { mode: 0o600 })
        let settled = false
        const fail = (error: unknown): void => {
          if (settled) return
          settled = true
          emit({ type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) })
          const cleanup = (): void => {
            void unlink(tmp).catch(() => undefined).finally(() => {
              try { res.end() } catch { /* closed */ }
            })
          }
          if (sink.destroyed) {
            cleanup()
          } else {
            sink.once('close', cleanup)
            try { sink.destroy() } catch { cleanup() }
          }
        }
        const done = (): void => {
          if (settled) return
          settled = true
          try { res.end() } catch { /* closed */ }
        }
        sink.on('error', (error) => fail(error))
        req.on('error', (error) => fail(error))
        req.on('aborted', () => fail('upload aborted by the client'))
        res.on('error', () => fail('response stream closed'))
        res.on('close', () => { if (!res.writableEnded) fail('connection closed') })
        let received = 0
        let capped = false
        req.on('data', (chunk: Buffer) => {
          received += chunk.byteLength
          if (received > maxUploadBytes && !capped) {
            capped = true
            fail('upload body too large')
            res.on('finish', () => { try { req.destroy() } catch { /* closed */ } })
            req.resume()
          }
        })
        req.pipe(sink)
        sink.on('finish', async () => {
          if (settled) return
          emit({ type: 'progress', progress: { phase: 'connecting', file: remotePath, transferred: 0, total: 0, percent: 0 } })
          try {
            const outcome = await engine.upload(alias, tmp, remotePath, progress => emit({ type: 'progress', progress }), channel as 'auto' | 'smb' | 'winrm')
            emit({ type: 'result', ok: true, transferredBytes: outcome.bytes })
          } catch (error) {
            emit({ type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) })
          } finally {
            await unlink(tmp).catch(() => undefined)
            done()
          }
        })
      },
    },
    // ------------------------------------------------------- download
    {
      kind: 'exact',
      path: WINRM_API.download,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const remotePath = queryParam(url, 'remotePath')
        if (alias === undefined || remotePath === undefined) {
          writeJson(res, 400, { error: 'alias and remotePath query parameters are required' })
          return
        }
        const channel = queryParam(url, 'channel') ?? 'auto'
        const tmp = join(staging, `download-${randomBytes(6).toString('hex')}`)
        try {
          closeSync(openSync(tmp, 'w', 0o600))
          const outcome = await engine.download(alias, remotePath, tmp, undefined, channel as 'auto' | 'smb' | 'winrm')
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(outcome.bytes),
            'content-disposition': `attachment; filename="${basename(remotePath).replace(/"/g, '')}"`,
            'referrer-policy': 'no-referrer',
          })
          await new Promise<void>((resolve, reject) => {
            const source = createReadStream(tmp)
            source.on('error', reject)
            res.on('error', reject)
            source.pipe(res)
            source.on('end', resolve)
          })
        } catch (error) {
          if (!res.headersSent) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          } else {
            res.destroy()
          }
        } finally {
          await unlink(tmp).catch(() => undefined)
        }
      },
    },
  ]

  // ---------------------------------------------- console (upgrade)
  const upgrade: WebUpgradeRoute = {
    path: WINRM_API.console,
    handler: (req, socket, head) => {
      if (!isLoopbackRequest(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const alias = queryParam(url, 'alias')
      if (alias === undefined) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      consoleWss.handleUpgrade(req, socket, head, (ws) => {
        let session: Awaited<ReturnType<WinRmEngine['openConsole']>> | undefined
        let closed = false
        const sendFrame = (frame: ConsoleServerFrame): void => {
          if (closed || ws.readyState !== WebSocket.OPEN) return
          ws.send(JSON.stringify(frame))
        }
        const closeSession = (): void => {
          const opened = session
          session = undefined
          if (opened !== undefined) opened.close()
        }
        engine.openConsole(alias).then((opened) => {
          if (ws.readyState !== WebSocket.OPEN) {
            opened.close()
            return
          }
          session = opened
          sendFrame({ type: 'ready', alias })
          opened.onData = (data) => sendFrame({ type: 'output', data })
          opened.onExit = (code, error) => {
            sendFrame({ type: 'exit', code, error })
            closed = true
            try { ws.close(1000) } catch { /* already closed */ }
          }
        }).catch((error) => {
          sendFrame({ type: 'exit', code: null, error: error instanceof Error ? error.message : String(error) })
          closed = true
          try { ws.close(1000) } catch { /* already closed */ }
        })
        ws.on('message', (data) => {
          let frame: ConsoleClientFrame
          try {
            frame = JSON.parse(String(data)) as ConsoleClientFrame
          } catch {
            return
          }
          if (frame.type === 'input') {
            session?.send(frame.data)
          }
        })
        ws.on('close', () => {
          closed = true
          closeSession()
        })
        ws.on('error', () => {
          closed = true
          closeSession()
        })
      })
    },
  }

  return { routes, upgrade }
}
