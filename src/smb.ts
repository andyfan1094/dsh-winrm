/**
 * SMB transfer bridge.
 *
 * The WinRM base64 chunk bridge is reliable for small files but breaks for
 * large artifacts (the pywinrm/HTTP envelope rejects payloads above ~8KB).
 * This module mounts the remote host's admin share with `net use` (password
 * passed via stdin, never argv), copies whole files with node:fs, then
 * verifies the SHA-256 on both ends.
 */

import { spawn } from 'node:child_process'
import { copyFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { WinHostEntry } from './protocol.ts'

/** Per-transfer channel selector. */
export type TransferChannel = 'auto' | 'smb' | 'winrm'

export interface SmbTransferResult {
  bytes: number
  channel: 'smb'
}

/**
 * Convert a Windows drive path to its UNC admin-share form.
 * D:\\dir\\file -> \\\\host\\D$\\dir\\file
 */
export function adminSharePath(host: string, remotePath: string): string {
  const absolute = remotePath.replace(/[\\/]+$/, '')
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(absolute)
  if (match === null) {
    throw new Error('SMB requires an absolute remote path like D:\\dir\\file')
  }
  const drive = match[1]
  const tail = match[2]
  return '\\\\' + host + '\\' + drive + '$' + (tail === '' ? '' : '\\' + tail)
}

/** Run one cmd.exe process; returns output and exit code. */
function runCmd(args: string[], input?: string, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/c', ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      try { child.kill() } catch { /* already gone */ }
      settled = true
      resolve({ code: 1, stdout: '', stderr: 'SMB net use timed out' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', (error) => {
      if (settled) return
      clearTimeout(timer)
      settled = true
      resolve({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) })
    })
    child.on('close', (code) => {
      if (settled) return
      clearTimeout(timer)
      settled = true
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** SHA-256 of a local file. */
async function sha256File(localPath: string): Promise<string> {
  return createHash('sha256').update(await readFile(localPath)).digest('hex').toUpperCase()
}

/** SHA-256 of a remote file through the UNC path. */
async function remoteSha256(host: string, remotePath: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const { stdout } = await execFileAsync('certutil.exe', ['-hashfile', adminSharePath(host, remotePath), 'SHA256'])
  const match = /([0-9A-Fa-f]{64})/.exec(stdout)
  if (match === null) throw new Error('SMB remote hash verification failed: ' + stdout)
  return match[1].toUpperCase()
}

/**
 * Copy one local file to a remote Windows host over SMB, verifying the
 * remote SHA-256 matches the local source.
 */
export async function uploadSmb(entry: WinHostEntry, localPath: string, remotePath: string, timeoutMs = 300_000): Promise<SmbTransferResult> {
  const unc = adminSharePath(entry.host, remotePath)
  const mount = await runCmd(['net', 'use', '\\\\' + entry.host + '\\IPC$', entry.auth.password ?? '', '/user:' + entry.user], undefined, timeoutMs)
  if (mount.code !== 0) throw new Error('SMB net use failed: ' + (mount.stderr || mount.stdout))
  try {
    const { mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(unc), { recursive: true })
    await copyFile(localPath, unc)
    const local = await stat(localPath)
    const localHash = await sha256File(localPath)
    const remoteHash = await remoteSha256(entry.host, remotePath)
    if (remoteHash !== localHash) throw new Error('SMB upload hash mismatch: local ' + localHash + ', remote ' + remoteHash)
    return { bytes: local.size, channel: 'smb' }
  } finally {
    await runCmd(['net', 'use', '\\\\' + entry.host + '\\IPC$', '/delete', '/y'], undefined, 30_000)
  }
}

/**
 * Copy one remote Windows file to a local path over SMB and verify the local
 * SHA-256 matches the remote source.
 */
export async function downloadSmb(entry: WinHostEntry, remotePath: string, localPath: string, timeoutMs = 300_000): Promise<SmbTransferResult> {
  const unc = adminSharePath(entry.host, remotePath)
  const mount = await runCmd(['net', 'use', '\\\\' + entry.host + '\\IPC$', entry.auth.password ?? '', '/user:' + entry.user], undefined, timeoutMs)
  if (mount.code !== 0) throw new Error('SMB net use failed: ' + (mount.stderr || mount.stdout))
  try {
    await copyFile(unc, localPath)
    const local = await stat(localPath)
    const localHash = await sha256File(localPath)
    const remoteHash = await remoteSha256(entry.host, remotePath)
    if (remoteHash !== localHash) throw new Error('SMB download hash mismatch: remote ' + remoteHash + ', local ' + localHash)
    return { bytes: local.size, channel: 'smb' }
  } finally {
    await runCmd(['net', 'use', '\\\\' + entry.host + '\\IPC$', '/delete', '/y'], undefined, 30_000)
  }
}
