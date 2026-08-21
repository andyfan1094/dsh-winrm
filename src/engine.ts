/**
 * The WinRM engine facade: host lookup, PowerShell exec (UTF-8 envelope),
 * service & process management, directory listing, base64-chunked file
 * transfer, cluster execution and the streaming console. The heavy lifting
 * lives in engine/ (client, console); this class composes them behind one
 * WinRmEngine instance per plugin apply.
 */

import type { ClusterResult, ExecResult, ProcessInfo, RemoteDirEntry, ServiceInfo, TestResult, TransferProgress, WinHostSummary } from './protocol.ts'
import type { HostStore } from './store.ts'
import { connOf, downloadChunks, runScript, testConnection, uploadBuffer } from './engine/client.ts'
import { ConsoleSession } from './engine/console.ts'
import { psKillProcess, psListDir, psListProcesses, psListServices, psServiceAction } from './powershell.ts'

/** JSON-safe parse of the envelope output into a typed value. */
function parseJson<T>(text: string): T {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === 'null') return [] as unknown as T
  return JSON.parse(trimmed) as T
}

/** A tiny per-alias in-flight limiter so GUI bursts do not pile up sockets. */
class AliasGate {
  private queues = new Map<string, Promise<void>>()

  async run<T>(alias: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(alias) ?? Promise.resolve()
    const next = prev.then(() => fn(), () => fn())
    // Keep the chain alive even when fn rejects (the caller observes the rejection).
    this.queues.set(alias, next.then(() => undefined, () => undefined))
    try {
      return await next
    } finally {
      if (this.queues.get(alias) === next.then(() => undefined, () => undefined)) {
        // (The identity check above is intentionally approximate; the queue
        // entry is replaced per run, so stale entries are naturally dropped.)
      }
      void prev
    }
  }
}

/** The engine. One instance per plugin apply; dispose() clears nothing pooled (WinRM is per-call HTTP). */
export class WinRmEngine {
  readonly store: HostStore
  private gate = new AliasGate()

  constructor(store: HostStore) {
    this.store = store
  }

  // ---------------------------------------------------------------- config

  /** Secret-free host list (filtered by the optional query). */
  list(query?: string): WinHostSummary[] {
    const needle = query?.trim().toLowerCase()
    return this.store.list()
      .filter(entry => needle === undefined || needle === ''
        || entry.alias.toLowerCase().includes(needle)
        || (entry.description ?? '').toLowerCase().includes(needle)
        || entry.host.toLowerCase().includes(needle)
        || entry.tags.some(tag => tag.toLowerCase().includes(needle)))
      .map(entry => this.store.summarize(entry))
  }

  /** One host summary by alias. */
  find(alias: string): WinHostSummary | undefined {
    const entry = this.store.find(alias)
    return entry === undefined ? undefined : this.store.summarize(entry)
  }

  // ------------------------------------------------------------------ exec

  /** Run one PowerShell command on `alias`. */
  async exec(alias: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    const entry = this.store.find(alias)
    if (entry === undefined) {
      return { success: false, exitCode: null, timedOut: false, stdout: '', stderr: '', durationMs: 0, error: `alias '${alias}' not found` }
    }
    return this.gate.run(alias, async () => {
      try {
        const result = await runScript(connOf(entry), command, { timeoutMs: timeoutMs ?? 60_000 })
        return {
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        }
      } catch (error) {
        return { success: false, exitCode: null, timedOut: false, stdout: '', stderr: '', durationMs: 0, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  // --------------------------------------------------------------- cluster

  /** Run one command against many hosts concurrently. */
  async cluster(options: {
    command: string
    aliases?: string[]
    environment?: string
    tags?: string[]
    timeoutMs?: number
    maxWorkers?: number
  }): Promise<ClusterResult[]> {
    const hosts = this.store.list()
    let matched = hosts
    if (options.aliases !== undefined && options.aliases.length > 0) {
      const set = new Set(options.aliases)
      matched = matched.filter(entry => set.has(entry.alias))
    }
    if (options.environment !== undefined && options.environment !== '') {
      matched = matched.filter(entry => entry.environment === options.environment)
    }
    if (options.tags !== undefined && options.tags.length > 0) {
      matched = matched.filter(entry => options.tags!.every(tag => entry.tags.includes(tag)))
    }
    const maxWorkers = Math.max(1, Math.min(options.maxWorkers ?? 8, 32))
    const results: ClusterResult[] = []
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++
        const entry = matched[index]
        if (entry === undefined) return
        const started = Date.now()
        const outcome = await this.exec(entry.alias, options.command, options.timeoutMs)
        results.push({
          alias: entry.alias,
          ok: outcome.success,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          durationMs: outcome.durationMs,
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        })
        void started
      }
    }
    await Promise.all(Array.from({ length: Math.min(maxWorkers, matched.length) }, () => worker()))
    return results
  }

  // -------------------------------------------------------------- services

  /** Full service table. */
  async listServices(alias: string): Promise<ServiceInfo[]> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    return this.gate.run(alias, async () => {
      const result = await runScript(connOf(entry), psListServices(), { timeoutMs: 60_000 })
      if (result.exitCode !== 0) throw new Error(result.stdout || 'failed to list services')
      const items = parseJson<Array<{ name?: string; displayName?: string; status?: string; startMode?: string; startName?: string }>>(result.stdout)
      return items.map(item => ({
        name: item.name ?? '',
        displayName: item.displayName ?? '',
        status: item.status ?? '',
        startMode: item.startMode ?? '',
        startName: item.startName ?? '',
      }))
    })
  }

  /** One service action, returning the refreshed service row. */
  async serviceAction(alias: string, name: string, action: 'start' | 'stop' | 'restart' | 'set-auto' | 'set-manual' | 'set-disabled'): Promise<ServiceInfo> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    return this.gate.run(alias, async () => {
      const result = await runScript(connOf(entry), psServiceAction(name, action), { timeoutMs: 60_000 })
      if (result.exitCode !== 0) throw new Error(result.stdout || `service action '${action}' failed`)
      const item = parseJson<Array<{ name?: string; displayName?: string; status?: string; startMode?: string; startName?: string }>>(result.stdout)[0] ?? {}
      return {
        name: item.name ?? name,
        displayName: item.displayName ?? '',
        status: item.status ?? '',
        startMode: item.startMode ?? '',
        startName: item.startName ?? '',
      }
    })
  }

  // ------------------------------------------------------------- processes

  /** Full process table. */
  async listProcesses(alias: string): Promise<ProcessInfo[]> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    return this.gate.run(alias, async () => {
      const result = await runScript(connOf(entry), psListProcesses(), { timeoutMs: 60_000 })
      if (result.exitCode !== 0) throw new Error(result.stdout || 'failed to list processes')
      const items = parseJson<Array<{ id?: number; name?: string; cpu?: number | null; memMB?: number; startTime?: string | null; path?: string | null }>>(result.stdout)
      return items.map(item => ({
        id: item.id ?? 0,
        name: item.name ?? '',
        ...(item.cpu !== undefined && item.cpu !== null ? { cpu: item.cpu } : {}),
        ...(item.memMB !== undefined && item.memMB !== null ? { memMB: item.memMB } : {}),
        ...(item.startTime !== undefined && item.startTime !== null ? { startTime: item.startTime } : {}),
        ...(item.path !== undefined && item.path !== null ? { path: item.path } : {}),
      }))
    })
  }

  /** Kill one process by id. */
  async killProcess(alias: string, id: number): Promise<void> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    return this.gate.run(alias, async () => {
      const result = await runScript(connOf(entry), psKillProcess(id), { timeoutMs: 30_000 })
      if (result.exitCode !== 0) throw new Error(result.stdout || 'failed to kill process')
    })
  }

  // -------------------------------------------------------------------- ls

  /** List a remote directory. */
  async ls(alias: string, dir: string): Promise<RemoteDirEntry[]> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    return this.gate.run(alias, async () => {
      const result = await runScript(connOf(entry), psListDir(dir), { timeoutMs: 60_000 })
      if (result.exitCode !== 0) throw new Error(result.stdout || `failed to list '${dir}'`)
      const items = parseJson<Array<{ name?: string; type?: string; size?: number; mtimeMs?: number }>>(result.stdout)
      return items.map(item => ({
        name: item.name ?? '',
        type: (item.type === 'dir' || item.type === 'file' ? item.type : 'other') as RemoteDirEntry['type'],
        size: item.size ?? 0,
        mtimeMs: item.mtimeMs ?? 0,
      }))
    })
  }

  // -------------------------------------------------------------- transfer

  /** Upload one local file to a remote path (base64 chunks). */
  async upload(alias: string, localPath: string, remotePath: string, onProgress?: (progress: TransferProgress) => void): Promise<{ bytes: number }> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    const { readFileSync } = await import('node:fs')
    const data = readFileSync(localPath)
    return this.gate.run(alias, async () => {
      onProgress?.({ phase: 'connecting', file: remotePath, transferred: 0, total: data.length, percent: 0 })
      const bytes = await uploadBuffer(connOf(entry), remotePath, data, (transferred, total) => {
        onProgress?.({ phase: 'transferring', file: remotePath, transferred, total, percent: total > 0 ? Math.round((transferred / total) * 1000) / 10 : 0 })
      })
      onProgress?.({ phase: 'done', file: remotePath, transferred: bytes, total: bytes, percent: 100 })
      return { bytes }
    })
  }

  /** Download one remote file to a local path (base64 chunks). */
  async download(alias: string, remotePath: string, localPath: string, onProgress?: (progress: TransferProgress) => void): Promise<{ bytes: number }> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    const { createWriteStream } = await import('node:fs')
    return this.gate.run(alias, async () => {
      const sink = createWriteStream(localPath, { mode: 0o600 })
      let bytes = 0
      onProgress?.({ phase: 'connecting', file: remotePath, transferred: 0, total: 0, percent: 0 })
      await new Promise<void>((resolve, reject) => {
        sink.on('error', reject)
        void downloadChunks(
          connOf(entry),
          remotePath,
          (b64) => {
            const buffer = Buffer.from(b64, 'base64')
            bytes += buffer.length
            sink.write(buffer)
          },
          (transferred, total) => onProgress?.({ phase: 'transferring', file: remotePath, transferred, total, percent: total > 0 ? Math.round((transferred / total) * 1000) / 10 : 0 }),
        ).then(
          () => sink.end(resolve),
          (error) => { sink.destroy(); reject(error) },
        )
      })
      onProgress?.({ phase: 'done', file: remotePath, transferred: bytes, total: bytes, percent: 100 })
      return { bytes }
    })
  }

  // --------------------------------------------------------------- console

  /** Open a streaming PowerShell console session (standalone connection). */
  async openConsole(alias: string): Promise<ConsoleSession> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    const session = new ConsoleSession(connOf(entry))
    await session.start()
    return session
  }

  // ------------------------------------------------------------------ misc

  /** Probe connectivity. */
  async test(alias: string): Promise<TestResult> {
    const entry = this.store.find(alias)
    if (entry === undefined) return { ok: false, error: `alias '${alias}' not found` }
    return this.gate.run(alias, async () => {
      const result = await testConnection(connOf(entry))
      return result
    })
  }

  /** No pooled resources to close (WinRM is per-call HTTP). */
  dispose(): void {
    // Nothing to tear down: every operation owns its shell lifecycle.
  }
}
