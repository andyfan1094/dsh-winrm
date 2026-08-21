/**
 * Wire contract between the host half (routes.ts) and the browser half
 * (client/api.ts). Pure types only — imported by both halves, bundled into
 * each, no runtime identity to share.
 */

/** WinRM transport flavors. */
export type WinTransport = 'http' | 'https'

/** One stored host entry (the ~/.dsh/dsh-winrm.json store shape). */
export interface WinHostEntry {
  /** Stable, user-chosen identifier used by every operation. */
  alias: string
  /** Hostname or IP of the target Windows machine. */
  host: string
  /** WinRM port (5985 HTTP, 5986 HTTPS). */
  port: number
  /** Login user. pywinrm uses NTLM/Negotiate for local and domain accounts. */
  user: string
  /** Authentication (WinRM password; transport delegates NTLM/Negotiate to pywinrm). */
  auth: {
    kind: 'password'
    password?: string
  }
  /** http (5985) or https (5986). */
  transport: WinTransport
  /** Whether self-signed HTTPS certificates are accepted. */
  rejectUnauthorized?: boolean
  /** Free-form note. */
  description?: string
  /** Deployment environment label (development / production / ...). */
  environment?: string
  /** Free-form tags. */
  tags: string[]
  /** Physical location note. */
  location?: string
  createdAt: number
  updatedAt: number
}

/** Public (secret-free) projection of an entry, safe for the browser/agent. */
export interface WinHostSummary {
  alias: string
  host: string
  port: number
  user: string
  auth: 'password'
  transport: WinTransport
  rejectUnauthorized?: boolean
  description?: string
  environment?: string
  tags: string[]
  location?: string
  createdAt: number
  updatedAt: number
}

/** Result of one PowerShell command execution. */
export interface ExecResult {
  success: boolean
  /** Remote exit code, or null when the channel died without one. */
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  /** Wall-clock duration of the round trip in ms. */
  durationMs: number
  /** Connection error message when the command never ran. */
  error?: string
}

/** One Windows service entry. */
export interface ServiceInfo {
  name: string
  displayName: string
  status: string
  startMode: string
  startName?: string
}

/** One Windows process entry. */
export interface ProcessInfo {
  id: number
  name: string
  cpu?: number
  memMB?: number
  startTime?: string
  path?: string
}

/** One directory listing entry (remote file browser). */
export interface RemoteDirEntry {
  name: string
  type: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
}

/** One server entry in a cluster run. */
export interface ClusterResult {
  alias: string
  ok: boolean
  exitCode?: number | null
  timedOut?: boolean
  stdout?: string
  stderr?: string
  durationMs?: number
  error?: string
}

/** Transfer progress frame (upload/download). */
export interface TransferProgress {
  phase: 'connecting' | 'transferring' | 'done' | 'error'
  file: string
  transferred: number
  total: number
  percent: number
  speedBps?: number
  error?: string
}

/** Test-connection outcome. */
export interface TestResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

/** Host edit payload (create/update); 'alias' comes from the URL for updates. */
export interface WinHostPayload {
  alias?: string
  host: string
  port?: number
  user: string
  /** Authentication. Required on create; on update an omitted auth keeps the stored password. */
  auth?: WinHostEntry['auth']
  transport?: WinTransport
  rejectUnauthorized?: boolean
  description?: string
  environment?: string
  tags?: string[]
  location?: string
}

/** JSON error body used by every route. */
export interface ApiErrorBody {
  error: string
}

/** WebSocket console protocol frames (host -> client and client -> host). */
export type ConsoleServerFrame =
  | { type: 'ready'; alias: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number | null; error?: string }

export type ConsoleClientFrame =
  | { type: 'input'; data: string }

/** Route paths the client calls (shared literals). */
export const WINRM_API_BASE = '/api/dsh-winrm' as const

export const WINRM_API = {
  hosts: WINRM_API_BASE + '/hosts',
  test: WINRM_API_BASE + '/test',
  exec: WINRM_API_BASE + '/exec',
  cluster: WINRM_API_BASE + '/cluster',
  services: WINRM_API_BASE + '/services',
  processes: WINRM_API_BASE + '/processes',
  ls: WINRM_API_BASE + '/ls',
  upload: WINRM_API_BASE + '/upload',
  download: WINRM_API_BASE + '/download',
  console: WINRM_API_BASE + '/console',
} as const

/** NDJSON transfer stream line shapes (upload). */
export type TransferStreamLine =
  | { type: 'progress'; progress: TransferProgress }
  | { type: 'result'; ok: boolean; transferredBytes?: number; error?: string }
