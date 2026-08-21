/**
 * Services tab: list Windows services for a host, filter, and run
 * start/stop/restart/startup-type actions.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WinrmApi } from '../api.ts'
import type { ServiceInfo } from '../../protocol.ts'
import { errorMessage, tt } from './helpers.ts'
import css from './panel.module.css'

/** Services tab props. */
export interface ServicesTabProps {
  api: WinrmApi
}

/** The services table with host picker and actions. */
export function ServicesTab({ api }: ServicesTabProps) {
  const [aliases, setAliases] = useState<string[]>([])
  const [alias, setAlias] = useState('')
  const [services, setServices] = useState<ServiceInfo[] | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  useEffect(() => {
    void api.listHosts().then(list => setAliases(list.map(h => h.alias))).catch(() => { /* ignore */ })
  }, [api])

  const load = useCallback(async (target: string): Promise<void> => {
    try {
      const list = await api.listServices(target)
      if (!mountedRef.current) return
      setServices(list)
      setError(null)
    } catch (cause) {
      if (!mountedRef.current) return
      setError(errorMessage(cause))
      setServices(null)
    }
  }, [api])

  useEffect(() => {
    if (alias === '') return
    setServices(null)
    void load(alias)
  }, [alias, load])

  const act = async (name: string, action: string): Promise<void> => {
    setActing(name)
    setNotice(null)
    setError(null)
    try {
      const updated = await api.serviceAction(alias, name, action)
      setNotice(tt('services.actionOk', { name: updated.name, status: updated.status }))
      void load(alias)
    } catch (cause) {
      setError(tt('services.actionFail', { error: errorMessage(cause) }))
    } finally {
      setActing(null)
    }
  }

  const needle = filter.trim().toLowerCase()
  const visible = services === null ? [] : services.filter(s =>
    s.name.toLowerCase().includes(needle) || s.displayName.toLowerCase().includes(needle))

  return (
    <div className={css.fillBody}>
      <div className={css.toolbar}>
        <select className={css.input} value={alias} onChange={event => { setAlias(event.target.value) }}>
          <option value="">{tt('services.select')}</option>
          {aliases.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <input className={css.search} type="search" placeholder={tt('services.filter')} value={filter} onChange={event => { setFilter(event.target.value) }} />
        <div className={css.toolbarSpacer} />
        <button type="button" className={css.ghostButton} disabled={alias === ''} onClick={() => { void load(alias) }}>{tt('common.refresh')}</button>
      </div>
      {notice !== null && <div className={css.banner} data-kind="ok">{notice}</div>}
      {error !== null && <div className={css.banner} data-kind="error">{error}</div>}
      {services === null && alias !== '' && error === null && <div className={css.loading}>{tt('common.loading')}</div>}
      {services !== null && (
        <div className={css.tableWrap}>
          <table className={css.table}>
            <thead>
              <tr>
                <th>{tt('services.name')}</th>
                <th>{tt('services.displayName')}</th>
                <th>{tt('services.status')}</th>
                <th>{tt('services.startMode')}</th>
                <th>{tt('services.startName')}</th>
                <th>{tt('hosts.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(service => (
                <tr key={service.name}>
                  <td className={css.mono}>{service.name}</td>
                  <td>{service.displayName}</td>
                  <td><span className={css.badge} data-kind={service.status === 'Running' ? 'ok' : 'muted'}>{service.status}</span></td>
                  <td>{service.startMode}</td>
                  <td className={css.cellMuted}>{service.startName}</td>
                  <td>
                    <div className={css.actions}>
                      <button type="button" className={css.linkButton} disabled={acting === service.name} onClick={() => { void act(service.name, 'start') }}>{tt('services.start')}</button>
                      <button type="button" className={css.linkButton} disabled={acting === service.name} onClick={() => { void act(service.name, 'stop') }}>{tt('services.stop')}</button>
                      <button type="button" className={css.linkButton} disabled={acting === service.name} onClick={() => { void act(service.name, 'restart') }}>{tt('services.restart')}</button>
                      <button type="button" className={css.linkButton} disabled={acting === service.name} onClick={() => { void act(service.name, 'set-auto') }}>{tt('services.auto')}</button>
                      <button type="button" className={css.linkButton} disabled={acting === service.name} onClick={() => { void act(service.name, 'set-manual') }}>{tt('services.manual')}</button>
                      <button type="button" className={css.linkButton} disabled={acting === service.name} onClick={() => { void act(service.name, 'set-disabled') }}>{tt('services.disabled')}</button>
                    </div>
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
