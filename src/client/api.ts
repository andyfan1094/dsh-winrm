/**
 * Browser-side API client for the /api/dsh-winrm route family. The only data
 * access path the panel components use — plain fetch/WebSocket, same origin.
 */

import {
  WINRM_API,
  type ClusterResult,
  type ConsoleClientFrame,
  type ConsoleServerFrame,
  type ExecResult,
  type ProcessInfo,
  type RemoteDirEntry,
  type ServiceInfo,
  type TestResult,
  type TransferProgress,
  type TransferStreamLine,
  type WinHostPayload,
  type WinHostSummary,
} from '../protocol.ts'

/** Minimal File System Access API surface (not in all lib.dom versions). */
interface WindowWithFileSystemAccess {
  showSaveFilePicker?: (options: { suggestedName?: string }) => Promise<{
    createWritable: () => Promise<{ write: (data: Uint8Array) => Promise<void>; close: () => Promise<void> }>
  }>
}

/** Error carrying the route's JSON error message. */
export class WinrmApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WinrmApiError'
  }
}

/** Parse a JSON response or throw a WinrmApiError. */
async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new WinrmApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${response.status}`
    throw new WinrmApiError(message)
  }
  return body as T
}

/** Query-string helper. */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : '?' + text
}

/** One open console connection (WebSocket JSON frames). */
export interface ConsoleConnection {
  onReady: (() => void) | undefined
  onOutput: ((data: string) => void) | undefined
  onExit: ((code: number | null, error?: string) => void) | undefined
  send(data: string): void
  close(): void
}

/** The browser half's only data entry point. */
export class WinrmApi {
  // -------------------------------------------------------------- hosts
  async listHosts(queryText?: string): Promise<WinHostSummary[]> {
    const response = await fetch(WINRM_API.hosts + query({ query: queryText }))
    const body = await readJson<{ hosts: WinHostSummary[] }>(response)
    return body.hosts
  }

  async createHost(payload: WinHostPayload): Promise<WinHostSummary> {
    const response = await fetch(WINRM_API.hosts, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await readJson<{ host: WinHostSummary }>(response)
    return body.host
  }

  async updateHost(alias: string, patch: WinHostPayload): Promise<WinHostSummary> {
    const response = await fetch(WINRM_API.hosts + query({ alias }), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const body = await readJson<{ host: WinHostSummary }>(response)
    return body.host
  }

  async deleteHost(alias: string): Promise<void> {
    const response = await fetch(WINRM_API.hosts + query({ alias }), { method: 'DELETE' })
    await readJson<{ ok: boolean }>(response)
  }

  // ---------------------------------------------------------------- ops
  async testHost(alias: string): Promise<TestResult> {
    const response = await fetch(WINRM_API.test, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias }),
    })
    const body = await readJson<{ result: TestResult }>(response)
    return body.result
  }

  async exec(alias: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    const response = await fetch(WINRM_API.exec, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias, command, timeoutMs }),
    })
    const body = await readJson<{ result: ExecResult }>(response)
    return body.result
  }

  async cluster(options: {
    command: string
    aliases?: string[]
    environment?: string
    tags?: string[]
    timeoutMs?: number
    maxWorkers?: number
  }): Promise<ClusterResult[]> {
    const response = await fetch(WINRM_API.cluster, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options),
    })
    const body = await readJson<{ results: ClusterResult[] }>(response)
    return body.results
  }

  // ------------------------------------------------------------ services
  async listServices(alias: string): Promise<ServiceInfo[]> {
    const response = await fetch(WINRM_API.services, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias, action: 'list' }),
    })
    const body = await readJson<{ services: ServiceInfo[] }>(response)
    return body.services
  }

  async serviceAction(alias: string, name: string, action: string): Promise<ServiceInfo> {
    const response = await fetch(WINRM_API.services, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias, name, action }),
    })
    const body = await readJson<{ service: ServiceInfo }>(response)
    return body.service
  }

  // ----------------------------------------------------------- processes
  async listProcesses(alias: string): Promise<ProcessInfo[]> {
    const response = await fetch(WINRM_API.processes, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias, action: 'list' }),
    })
    const body = await readJson<{ processes: ProcessInfo[] }>(response)
    return body.processes
  }

  async killProcess(alias: string, id: number): Promise<void> {
    const response = await fetch(WINRM_API.processes, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias, action: 'kill', id }),
    })
    await readJson<{ killed: number }>(response)
  }

  // ----------------------------------------------------------------- ls
  async ls(alias: string, dir: string): Promise<RemoteDirEntry[]> {
    const response = await fetch(WINRM_API.ls + query({ alias, path: dir }))
    const body = await readJson<{ entries: RemoteDirEntry[] }>(response)
    return body.entries
  }

  // ------------------------------------------------------------ transfer
  /**
   * Upload one file (raw bytes) to a remote path. Progress arrives through
   * the NDJSON response stream; resolves when the result frame lands.
   */
  async uploadFile(
    file: File,
    alias: string,
    remotePath: string,
    onProgress?: (progress: TransferProgress) => void,
  ): Promise<{ transferredBytes: number }> {
    const response = await fetch(WINRM_API.upload + query({ alias, remotePath }), {
      method: 'POST',
      body: file,
    })
    if (!response.ok || response.body === null) {
      throw new WinrmApiError(`upload failed: HTTP ${response.status}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finalError: string | undefined
    let sawResult = false
    let transferredBytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        let parsed: TransferStreamLine
        try {
          parsed = JSON.parse(line) as TransferStreamLine
        } catch {
          continue
        }
        if (parsed.type === 'progress') {
          onProgress?.(parsed.progress)
        } else if (parsed.type === 'result') {
          sawResult = true
          if (parsed.ok) transferredBytes = parsed.transferredBytes ?? 0
          finalError = parsed.ok ? undefined : parsed.error ?? 'upload failed'
        }
      }
    }
    if (finalError !== undefined) throw new WinrmApiError(finalError)
    if (!sawResult) throw new WinrmApiError('upload ended without a result frame — the transfer did not complete')
    return { transferredBytes }
  }

  /**
   * Download a remote file with client-side progress. Streams straight to
   * disk when the File System Access API is available; otherwise falls back
   * to an in-memory Blob.
   */
  async downloadFile(
    alias: string,
    remotePath: string,
    onProgress?: (progress: TransferProgress) => void,
  ): Promise<{ blob?: Blob; filename: string; streamed: boolean; bytes: number }> {
    const response = await fetch(WINRM_API.download + query({ alias, remotePath }))
    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => '')
      throw new WinrmApiError(text !== '' && text.startsWith('{') ? text : `download failed: HTTP ${response.status}`)
    }
    const total = Number(response.headers.get('content-length') ?? '0')
    const disposition = response.headers.get('content-disposition') ?? ''
    const match = /filename="([^"]+)"/.exec(disposition)
    const filename = match?.[1] ?? remotePath.split(/[\\/]/).pop() ?? 'download'
    const reader = response.body.getReader()
    const picker = typeof window !== 'undefined'
      ? (window as WindowWithFileSystemAccess).showSaveFilePicker
      : undefined
    let streamed = false
    let writable: { write: (data: Uint8Array) => Promise<void>; close: () => Promise<void> } | undefined
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let received = 0
    const progress = (): void => {
      onProgress?.({
        phase: 'transferring',
        file: remotePath,
        transferred: received,
        total,
        percent: total > 0 ? Math.round((received / total) * 1000) / 10 : 0,
      })
    }
    try {
      if (picker !== undefined) {
        const handle = await picker.call(window, { suggestedName: filename })
        writable = await handle.createWritable()
        streamed = true
      }
    } catch {
      // User cancelled the save dialog or the API is unavailable: fall back.
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (writable !== undefined) {
        await writable.write(value as Uint8Array)
      } else {
        chunks.push(value as Uint8Array<ArrayBuffer>)
      }
      received += value.length
      progress()
    }
    if (writable !== undefined) await writable.close()
    onProgress?.({ phase: 'done', file: remotePath, transferred: received, total: received > 0 ? received : total, percent: 100 })
    return {
      blob: streamed ? undefined : new Blob(chunks),
      filename,
      streamed,
      bytes: received,
    }
  }

  // ------------------------------------------------------------ console
  /** Open a WebSocket PowerShell console session. */
  openConsole(alias: string): ConsoleConnection {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = scheme + '://' + window.location.host + WINRM_API.console + query({ alias })
    const socket = new WebSocket(url)
    const connection: ConsoleConnection = {
      onReady: undefined,
      onOutput: undefined,
      onExit: undefined,
      send: (data) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'input', data } satisfies ConsoleClientFrame))
        }
      },
      close: () => {
        try { socket.close() } catch { /* already closed */ }
      },
    }
    socket.onmessage = (event: MessageEvent<string>) => {
      let frame: ConsoleServerFrame
      try {
        frame = JSON.parse(event.data) as ConsoleServerFrame
      } catch {
        return
      }
      if (frame.type === 'ready') connection.onReady?.()
      else if (frame.type === 'output') connection.onOutput?.(frame.data)
      else if (frame.type === 'exit') connection.onExit?.(frame.code, frame.error)
    }
    socket.onclose = () => { connection.onExit?.(null, 'connection closed') }
    socket.onerror = () => { connection.onExit?.(null, 'connection error') }
    return connection
  }
}
