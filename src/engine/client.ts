/**
 * WinRM transport bridge.
 *
 * This Windows host has pywinrm 0.5.0 available, and its mature requests/NTLM
 * stack successfully executes WinRM against 192.168.71.13 where the Node
 * winrm-client implementation fails. The bridge sends credentials through
 * stdin (not process arguments), preserves stdout/stderr as base64, and keeps
 * the DSH engine API unchanged.
 */

import { spawn } from 'node:child_process'
import type { WinHostEntry } from '../protocol.ts'
import { parseEnvelope, psFileSize, psReadChunk, psWriteChunk, winrmPowerShellScript } from '../powershell.ts'

export interface WinRMParams {
  host: string
  port: number
  path: string
  username: string
  password: string
  useHttps?: boolean
  rejectUnauthorized?: boolean
}

interface BridgeResult {
  ok: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
  error?: string
}

const PYTHON_BRIDGE = String.raw`import sys,json,base64,winrm
try:
    req=json.loads(sys.stdin.read())
    scheme='https' if req.get('useHttps') else 'http'
    endpoint=f"{scheme}://{req['host']}:{req['port']}{req.get('path','/wsman')}"
    timeout_ms=max(5000,int(req.get('timeoutMs',60000)))
    timeout_sec=max(10,int((timeout_ms+999)//1000))
    transports=['basic'] if req.get('useHttps') else ['ntlm','basic']
    last_error=None
    result=None
    for transport in transports:
        try:
            session=winrm.Session(endpoint, auth=(req['username'],req['password']), transport=transport, server_cert_validation='ignore' if not req.get('rejectUnauthorized',True) else 'validate', operation_timeout_sec=timeout_sec, read_timeout_sec=timeout_sec+15)
            result=session.run_ps(req['script'])
            break
        except Exception as exc:
            last_error=exc
    if result is None:
        raise last_error or RuntimeError('all WinRM authentication modes failed')
    print(json.dumps({'ok':True,'exitCode':int(result.status_code),'stdout':base64.b64encode(result.std_out).decode('ascii'),'stderr':base64.b64encode(result.std_err).decode('ascii')}, separators=(',',':')))
except Exception as exc:
    print(json.dumps({'ok':False,'error':str(exc)}, separators=(',',':')))
`

function pythonCandidates(): string[] {
  const configured = process.env.DSH_WINRM_PYTHON?.trim()
  return [...new Set([configured, 'python', 'py'].filter((value): value is string => Boolean(value)))]
}

async function runBridge(params: WinRMParams, script: string, timeoutMs: number): Promise<BridgeResult> {
  const request = JSON.stringify({
    host: params.host,
    port: params.port,
    path: params.path,
    username: params.username,
    password: params.password,
    useHttps: params.useHttps ?? false,
    rejectUnauthorized: params.rejectUnauthorized ?? true,
    script,
    timeoutMs,
  })

  let lastError: unknown
  for (const executable of pythonCandidates()) {
    const result = await new Promise<BridgeResult | undefined>((resolve, reject) => {
      const args = executable === 'py' ? ['-3', '-c', PYTHON_BRIDGE] : ['-c', PYTHON_BRIDGE]
      const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        try { child.kill() } catch { /* already gone */ }
        settled = true
        resolve({ ok: false, error: 'pywinrm request timed out' })
      }, Math.max(10_000, timeoutMs + 5000))
      child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
      child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
      child.on('error', error => {
        if (settled) return
        clearTimeout(timer)
        settled = true
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') resolve(undefined)
        else reject(error)
      })
      child.on('close', () => {
        if (settled) return
        clearTimeout(timer)
        settled = true
        const raw = Buffer.concat(stdout).toString('utf8').trim()
        if (raw === '') {
          resolve({ ok: false, error: Buffer.concat(stderr).toString('utf8').trim() || 'pywinrm returned no result' })
          return
        }
        try {
          resolve(JSON.parse(raw) as BridgeResult)
        } catch {
          resolve({ ok: false, error: raw.slice(0, 1000) })
        }
      })
      child.stdin.end(request, 'utf8')
    })
    if (result !== undefined) return result
    lastError = new Error(executable + ' was not found')
  }
  return { ok: false, error: 'Python with pywinrm is required; set DSH_WINRM_PYTHON or install pywinrm. ' + String(lastError ?? '') }
}

function decode(value: string | undefined): string {
  return value === undefined ? '' : Buffer.from(value, 'base64').toString('utf8')
}

export async function runScript(
  conn: WinRMParams,
  script: string,
  options: { timeoutMs?: number; onChunk?: (chunk: { output: string; stderr: string }) => void } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number }> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? 60_000
  const result = await runBridge(conn, winrmPowerShellScript(script), timeoutMs)
  if (!result.ok) {
    const message = result.error ?? 'pywinrm request failed'
    if (/timed out/i.test(message)) return { stdout: '', stderr: '', exitCode: null, timedOut: true, durationMs: Date.now() - started }
    throw new Error(message)
  }
  const raw = decode(result.stdout)
  options.onChunk?.({ output: raw, stderr: decode(result.stderr) })
  const parsed = parseEnvelope(raw)
  return {
    stdout: parsed !== null ? parsed.text : raw,
    stderr: decode(result.stderr),
    exitCode: parsed !== null ? parsed.exitCode : result.exitCode ?? null,
    timedOut: false,
    durationMs: Date.now() - started,
  }
}

export function connOf(entry: WinHostEntry): WinRMParams {
  return {
    host: entry.host,
    port: entry.port,
    path: '/wsman',
    username: entry.user,
    password: entry.auth.password ?? '',
    useHttps: entry.transport === 'https',
    rejectUnauthorized: entry.rejectUnauthorized ?? true,
  }
}

export async function testConnection(conn: WinRMParams): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now()
  try {
    const result = await runScript(conn, 'Write-Output ok', { timeoutMs: 30_000 })
    return { ok: result.exitCode === 0 && result.stdout.trim() !== '', latencyMs: Date.now() - started }
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
  }
}

export const TRANSFER_CHUNK = 48 * 1024

export async function remoteFileSize(conn: WinRMParams, remotePath: string, timeoutMs = 60_000): Promise<number> {
  const result = await runScript(conn, psFileSize(remotePath), { timeoutMs })
  const value = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(value) ? value : 0
}

export async function downloadChunks(
  conn: WinRMParams,
  remotePath: string,
  onChunk: (b64: string, bytes: number) => void,
  onProgress?: (transferred: number, total: number) => void,
  timeoutMs = 60_000,
): Promise<number> {
  const total = await remoteFileSize(conn, remotePath, timeoutMs)
  if (total === 0) return 0
  let offset = 0
  for (;;) {
    const result = await runScript(conn, psReadChunk(remotePath, offset, TRANSFER_CHUNK), { timeoutMs })
    const b64 = result.stdout.trim()
    const bytes = Buffer.from(b64, 'base64').length
    if (bytes === 0) break
    onChunk(b64, bytes)
    offset += bytes
    onProgress?.(offset, total)
    if (offset >= total || bytes < TRANSFER_CHUNK) break
  }
  return offset
}

export async function uploadBuffer(
  conn: WinRMParams,
  remotePath: string,
  data: Buffer,
  onProgress?: (transferred: number, total: number) => void,
  timeoutMs = 60_000,
): Promise<number> {
  let written = 0
  let first = true
  for (let offset = 0; offset < data.length; offset += TRANSFER_CHUNK) {
    const chunk = data.subarray(offset, Math.min(offset + TRANSFER_CHUNK, data.length))
    await runScript(conn, psWriteChunk(remotePath, chunk.toString('base64'), !first), { timeoutMs })
    written += chunk.length
    first = false
    onProgress?.(written, data.length)
  }
  return written
}
