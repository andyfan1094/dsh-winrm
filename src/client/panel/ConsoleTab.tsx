/**
 * Console tab: a streaming PowerShell console over the /api/dsh-winrm
 * WebSocket. Output renders into a monospace pre; commands are sent as stdin
 * lines. Non-ASCII output may garble (transport decodes as ASCII) — the
 * exec route/tool carries the UTF-8 envelope instead.
 */
import { useEffect, useRef, useState } from 'react'
import type { ConsoleConnection, WinrmApi } from '../api.ts'
import { errorMessage, tt } from './helpers.ts'
import css from './panel.module.css'

/** Console tab props. */
export interface ConsoleTabProps {
  api: WinrmApi
  /** Alias to auto-connect (from the hosts tab). */
  presetAlias?: string
  /** Increments when a new connect request arrives. */
  requestId?: number
}

interface SessionState {
  alias: string
  lines: string[]
  connected: boolean
  error?: string
}

/** The streaming PowerShell console. */
export function ConsoleTab({ api, presetAlias, requestId }: ConsoleTabProps) {
  const [aliases, setAliases] = useState<string[]>([])
  const [session, setSession] = useState<SessionState | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const connRef = useRef<ConsoleConnection | null>(null)
  const linesRef = useRef<string[]>([])
  const bottomRef = useRef<HTMLDivElement | null>(null)

  // Load host aliases once.
  useEffect(() => {
    void api.listHosts().then(list => setAliases(list.map(h => h.alias))).catch(() => { /* ignore */ })
  }, [api])

  const pushLines = (text: string): void => {
    linesRef.current = [...linesRef.current, ...text.split('\n')].slice(-5000)
    setSession(prev => prev === null ? prev : { ...prev, lines: [...linesRef.current] })
  }

  // Auto-connect when the hosts tab requests it.
  useEffect(() => {
    if (presetAlias !== undefined && presetAlias !== '' && requestId !== undefined) {
      connect(presetAlias)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetAlias, requestId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [session?.lines])

  useEffect(() => () => {
    connRef.current?.close()
    connRef.current = null
  }, [])

  const connect = (alias: string): void => {
    connRef.current?.close()
    linesRef.current = []
    setSession({ alias, lines: [], connected: false })
    setBusy(true)
    const connection = api.openConsole(alias)
    connRef.current = connection
    connection.onReady = () => {
      setBusy(false)
      setSession(prev => prev === null ? prev : { ...prev, connected: true })
      pushLines(tt('console.connected', { alias }))
    }
    connection.onOutput = (data) => { pushLines(data) }
    connection.onExit = (code, error) => {
      connRef.current = null
      setBusy(false)
      setSession(prev => prev === null ? prev : {
        ...prev,
        connected: false,
        error: error !== undefined ? errorMessage(error) : tt('console.disconnected'),
      })
    }
  }

  const disconnect = (): void => {
    connRef.current?.close()
    connRef.current = null
    setSession(prev => prev === null ? prev : { ...prev, connected: false, error: tt('console.disconnected') })
  }

  const send = (): void => {
    const command = input
    if (command.trim() === '' || connRef.current === null) return
    connRef.current?.send(command + '\r\n')
    setInput('')
  }

  return (
    <div className={css.fillBody}>
      {session === null && (
        <div className={css.controls}>
          <select className={css.input} value="" onChange={event => { if (event.target.value !== '') connect(event.target.value) }}>
            <option value="">{tt('console.select')}</option>
            {aliases.map(alias => <option key={alias} value={alias}>{alias}</option>)}
          </select>
        </div>
      )}
      {session !== null && (
        <div className={css.consoleWrap}>
          <div className={css.consoleHeader}>
            <span className={css.mono}>{session.alias}</span>
            {session.connected && <span className={css.badge} data-kind="ok">{tt('console.connected', { alias: session.alias }).split('—')[0]}</span>}
            <div className={css.toolbarSpacer} />
            {busy && <span className={css.loading}>{tt('console.connecting', { alias: session.alias })}</span>}
            <button type="button" className={css.ghostButton} onClick={disconnect}>{tt('console.disconnect')}</button>
          </div>
          <pre className={css.consoleOutput}>
            {session.lines.join('\n')}
            <div ref={bottomRef} />
          </pre>
          {session.error !== undefined && <div className={css.banner} data-kind="error">{session.error}</div>}
          <div className={css.consoleInputRow}>
            <input
              className={css.input}
              value={input}
              placeholder={tt('console.inputPlaceholder')}
              disabled={!session.connected}
              onChange={event => { setInput(event.target.value) }}
              onKeyDown={event => { if (event.key === 'Enter') send() }}
            />
            <button type="button" className={css.primaryButton} disabled={!session.connected} onClick={send}>{tt('console.send')}</button>
          </div>
          <div className={css.utf8Note}>{tt('console.utf8Note')}</div>
        </div>
      )}
    </div>
  )
}
