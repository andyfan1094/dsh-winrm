/**
 * Processes tab: list processes for a host, filter, and kill by id.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WinrmApi } from '../api.ts'
import type { ProcessInfo } from '../../protocol.ts'
import { errorMessage, tt } from './helpers.ts'
import css from './panel.module.css'

/** Processes tab props. */
export interface ProcessesTabProps {
  api: WinrmApi
}

/** The processes table with host picker and kill actions. */
export function ProcessesTab({ api }: ProcessesTabProps) {
  const [aliases, setAliases] = useState<string[]>([])
  const [alias, setAlias] = useState('')
  const [processes, setProcesses] = useState<ProcessInfo[] | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [killing, setKilling] = useState<number | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  useEffect(() => {
    void api.listHosts().then(list => setAliases(list.map(h => h.alias))).catch(() => { /* ignore */ })
  }, [api])

  const load = useCallback(async (target: string): Promise<void> => {
    try {
      const list = await api.listProcesses(target)
      if (!mountedRef.current) return
      setProcesses(list)
      setError(null)
    } catch (cause) {
      if (!mountedRef.current) return
      setError(errorMessage(cause))
      setProcesses(null)
    }
  }, [api])

  useEffect(() => {
    if (alias === '') return
    setProcesses(null)
    void load(alias)
  }, [alias, load])

  const kill = async (process: ProcessInfo): Promise<void> => {
    if (!window.confirm(tt('processes.killConfirm', { name: process.name, id: process.id }))) return
    setKilling(process.id)
    setNotice(null)
    setError(null)
    try {
      await api.killProcess(alias, process.id)
      setNotice(tt('processes.killed', { id: process.id }))
      void load(alias)
    } catch (cause) {
      setError(tt('processes.killFail', { error: errorMessage(cause) }))
    } finally {
      setKilling(null)
    }
  }

  const needle = filter.trim().toLowerCase()
  const visible = processes === null ? [] : processes.filter(p => p.name.toLowerCase().includes(needle))

  return (
    <div className={css.fillBody}>
      <div className={css.toolbar}>
        <select className={css.input} value={alias} onChange={event => { setAlias(event.target.value) }}>
          <option value="">{tt('processes.select')}</option>
          {aliases.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <input className={css.search} type="search" placeholder={tt('processes.filter')} value={filter} onChange={event => { setFilter(event.target.value) }} />
        <div className={css.toolbarSpacer} />
        <button type="button" className={css.ghostButton} disabled={alias === ''} onClick={() => { void load(alias) }}>{tt('common.refresh')}</button>
      </div>
      {notice !== null && <div className={css.banner} data-kind="ok">{notice}</div>}
      {error !== null && <div className={css.banner} data-kind="error">{error}</div>}
      {processes === null && alias !== '' && error === null && <div className={css.loading}>{tt('common.loading')}</div>}
      {processes !== null && (
        <div className={css.tableWrap}>
          <table className={css.table}>
            <thead>
              <tr>
                <th>{tt('processes.id')}</th>
                <th>{tt('processes.name')}</th>
                <th>{tt('processes.cpu')}</th>
                <th>{tt('processes.memMB')}</th>
                <th>{tt('processes.startTime')}</th>
                <th>{tt('processes.path')}</th>
                <th>{tt('hosts.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(process => (
                <tr key={process.id}>
                  <td className={css.mono}>{process.id}</td>
                  <td>{process.name}</td>
                  <td>{process.cpu ?? ''}</td>
                  <td>{process.memMB ?? ''}</td>
                  <td className={css.cellMuted}>{process.startTime ?? ''}</td>
                  <td className={css.cellMuted} title={process.path ?? ''}>{process.path ?? ''}</td>
                  <td>
                    <button type="button" className={css.linkButton} data-danger disabled={killing === process.id} onClick={() => { void kill(process) }}>
                      {killing === process.id ? tt('common.loading') : tt('processes.kill')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
