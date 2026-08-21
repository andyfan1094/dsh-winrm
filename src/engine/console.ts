/**
 * WebSocket PowerShell console backed by pywinrm one-shot commands.
 *
 * pywinrm is the working SPNEGO implementation on Windows. Each submitted
 * command is executed through the same UTF-8 envelope as winrm_exec; the
 * WebSocket remains open while commands are serialized. This is intentionally
 * a command console rather than a persistent remote process, so every line
 * is authenticated and isolated.
 */

import type { WinRMParams } from './client.ts'
import { runScript } from './client.ts'

export class ConsoleSession {
  private conn: WinRMParams
  private running = false
  private exited = false
  private queue: Promise<void> = Promise.resolve()
  onData: ((data: string) => void) | undefined
  onExit: ((code: number | null, error?: string) => void) | undefined

  constructor(conn: WinRMParams) {
    this.conn = conn
  }

  async start(): Promise<void> {
    this.running = true
  }

  send(data: string): void {
    const command = data.replace(/\r?\n/g, '').trim()
    if (!this.running || command === '') return
    if (command.toLowerCase() === 'exit') {
      this.close()
      return
    }
    this.queue = this.queue.then(async () => {
      if (!this.running) return
      try {
        const result = await runScript(this.conn, command, { timeoutMs: 120_000 })
        if (result.stdout !== '') this.onData?.(result.stdout + (result.stdout.endsWith('\n') ? '' : '\n'))
        if (result.stderr !== '') this.onData?.(result.stderr + (result.stderr.endsWith('\n') ? '' : '\n'))
        if (result.timedOut) this.onData?.('[timed out]\n')
      } catch (error) {
        this.onData?.('[error] ' + (error instanceof Error ? error.message : String(error)) + '\n')
      }
    })
  }

  close(): void {
    if (!this.running) return
    this.running = false
    this.exited = true
  }

  private finish(code: number | null, error?: string): void {
    if (this.exited) return
    this.exited = true
    this.running = false
    this.onExit?.(code, error)
  }
}
