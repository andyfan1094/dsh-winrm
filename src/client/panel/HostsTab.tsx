/**
 * Hosts tab: the host table with search (debounced through listHosts),
 * add/edit/delete/test actions, and a connect action that hands the alias to
 * the console tab via onConnect.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { WinrmApi } from '../api.ts'
import type { TestResult, WinHostSummary } from '../../protocol.ts'
import { errorMessage, tt } from './helpers.ts'
import { HostFormDialog } from './HostFormDialog.tsx'
import css from './panel.module.css'

/** Hosts tab props. */
export interface HostsTabProps {
  api: WinrmApi
  /** Connect the given alias in the console tab. */
  onConnect: (alias: string) => void
}

/** The host-form dialog invocation. */
type DialogState = { mode: 'create' } | { mode: 'edit'; host: WinHostSummary }

/** The hosts table plus its toolbar and dialogs. */
export function HostsTab({ api, onConnect }: HostsTabProps) {
  const [hosts, setHosts] = useState<WinHostSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [testingAlias, setTestingAlias] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const seqRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const load = useCallback(async (query?: string): Promise<void> => {
    const seq = ++seqRef.current
    try {
      const list = await api.listHosts(query)
      if (!mountedRef.current || seq !== seqRef.current) return
      setHosts(list)
      setError(null)
    } catch (cause) {
      if (!mountedRef.current || seq !== seqRef.current) return
      setError(errorMessage(cause))
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const timer = setTimeout(() => {
      const query = search.trim()
      void load(query === '' ? undefined : query)
    }, 300)
    return () => { clearTimeout(timer) }
  }, [search, load])

  const runTest = async (alias: string): Promise<void> => {
    setTestingAlias(alias)
    try {
      const result = await api.testHost(alias)
      setTestResults(prev => ({ ...prev, [alias]: result }))
    } catch (cause) {
      setTestResults(prev => ({ ...prev, [alias]: { ok: false, error: errorMessage(cause) } }))
    } finally {
      setTestingAlias(null)
    }
  }

  const deleteHost = async (alias: string): Promise<void> => {
    if (!window.confirm(tt('hosts.deleteConfirm', { alias }))) return
    try {
      await api.deleteHost(alias)
      void load()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const renderHostRow = (host: WinHostSummary): ReactNode => {
    const test = testResults[host.alias]
    return (
      <tr key={host.alias}>
        <td className={css.mono}>{host.alias}</td>
        <td className={css.mono}>{host.host}:{host.port}</td>
        <td>{host.user}</td>
        <td><span className={css.badge} data-kind="password">{host.transport === 'https' ? 'HTTPS' : 'HTTP'}</span></td>
        <td className={css.cellMuted}>{host.environment ?? ''}</td>
        <td className={css.cellMuted}>{host.tags.join(', ')}</td>
        <td className={css.cellMuted}>{host.description ?? ''}</td>
        <td>
          <div className={css.actions}>
            <button type="button" className={css.linkButton} disabled={testingAlias === host.alias} onClick={() => { void runTest(host.alias) }}>
              {testingAlias === host.alias ? tt('hosts.testing') : tt('hosts.test')}
            </button>
            {testingAlias === host.alias && <span className={css.spinner} aria-hidden="true" />}
            {test !== undefined && (
              <span className={css.inlineTest} data-status={test.ok ? 'ok' : 'fail'}>
                {test.ok ? tt('hosts.testOk', { latency: test.latencyMs ?? 0 }) : tt('hosts.testFail', { error: test.error ?? '' })}
              </span>
            )}
            <button type="button" className={css.linkButton} onClick={() => { setDialog({ mode: 'edit', host }) }}>{tt('hosts.edit')}</button>
            <button type="button" className={css.linkButton} data-danger onClick={() => { void deleteHost(host.alias) }}>{tt('hosts.delete')}</button>
            <button type="button" className={css.ghostButton} onClick={() => { onConnect(host.alias) }}>{tt('hosts.connect')}</button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <div className={css.fillBody}>
      <div className={css.toolbar}>
        <input className={css.search} type="search" placeholder={tt('hosts.search')} value={search} onChange={event => { setSearch(event.target.value) }} />
        <div className={css.toolbarSpacer} />
        <button type="button" className={css.ghostButton} onClick={() => { void load(search.trim() || undefined) }}>{tt('common.refresh')}</button>
        <button type="button" className={css.primaryButton} onClick={() => { setDialog({ mode: 'create' }) }}>{tt('hosts.add')}</button>
      </div>
      {error !== null && <div className={css.banner} data-kind="error">{tt('common.error', { error })}</div>}
      {hosts === null && error === null && <div className={css.loading}>{tt('common.loading')}</div>}
      {hosts !== null && hosts.length === 0 && <div className={css.empty}>{tt('hosts.empty')}</div>}
      {hosts !== null && hosts.length > 0 && (
        <div className={css.tableWrap}>
          <table className={css.table}>
            <thead>
              <tr>
                <th>{tt('hosts.col.alias')}</th>
                <th>{tt('hosts.col.host')}</th>
                <th>{tt('hosts.col.user')}</th>
                <th>{tt('hosts.col.transport')}</th>
                <th>{tt('hosts.col.environment')}</th>
                <th>{tt('hosts.col.tags')}</th>
                <th>{tt('hosts.col.description')}</th>
                <th>{tt('hosts.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map(renderHostRow)}
            </tbody>
          </table>
        </div>
      )}
      {dialog !== null && (
        <HostFormDialog
          api={api}
          editing={dialog.mode === 'edit' ? dialog.host : null}
          onClose={() => { setDialog(null) }}
          onSaved={() => { setDialog(null); void load() }}
        />
      )}
    </div>
  )
}
