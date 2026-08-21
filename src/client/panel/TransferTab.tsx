/**
 * Transfer tab: browse remote directories (ls), download files to the local
 * machine, and upload local files to the remote host. Transfers ride the
 * NDJSON progress stream (upload) / content-length progress (download).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WinrmApi } from '../api.ts'
import type { RemoteDirEntry, TransferProgress } from '../../protocol.ts'
import { errorMessage, formatBytes, tt } from './helpers.ts'
import css from './panel.module.css'

/** Transfer tab props. */
export interface TransferTabProps {
  api: WinrmApi
}

/** One remote directory entry with a clickable path. */
function joinPath(dir: string, name: string): string {
  return dir.replace(/[\\/]+$/, '') + '\\' + name
}

/** The file browser with upload/download. */
export function TransferTab({ api }: TransferTabProps) {
  const [aliases, setAliases] = useState<string[]>([])
  const [alias, setAlias] = useState('')
  const [dir, setDir] = useState('C:\\')
  const [entries, setEntries] = useState<RemoteDirEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [progress, setProgress] = useState<TransferProgress | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  useEffect(() => {
    void api.listHosts().then(list => setAliases(list.map(h => h.alias))).catch(() => { /* ignore */ })
  }, [api])

  const load = useCallback(async (target: string, path: string): Promise<void> => {
    try {
      const list = await api.ls(target, path)
      if (!mountedRef.current) return
      setEntries(list)
      setDir(path)
      setError(null)
    } catch (cause) {
      if (!mountedRef.current) return
      setError(errorMessage(cause))
      setEntries(null)
    }
  }, [api])

  const open = (): void => {
    if (alias === '' || dir === '') return
    setEntries(null)
    void load(alias, dir)
  }

  const pickAlias = (value: string): void => {
    setAlias(value)
    setEntries(null)
    if (value !== '') void load(value, 'C:\\')
  }

  const download = async (entry: RemoteDirEntry): Promise<void> => {
    if (entry.type !== 'file') return
    setProgress({ phase: 'transferring', file: entry.name, transferred: 0, total: 0, percent: 0 })
    setError(null)
    try {
      const outcome = await api.downloadFile(alias, joinPath(dir, entry.name), p => setProgress(p))
      setNotice(tt('transfer.downloaded', { bytes: outcome.bytes }))
    } catch (cause) {
      setError(tt('transfer.fail', { error: errorMessage(cause) }))
    } finally {
      setProgress(null)
    }
  }

  const upload = async (file: File): Promise<void> => {
    if (file === undefined) return
    const remotePath = joinPath(dir, file.name)
    setProgress({ phase: 'transferring', file: file.name, transferred: 0, total: file.size, percent: 0 })
    setError(null)
    try {
      const outcome = await api.uploadFile(file, alias, remotePath, p => setProgress(p))
      setNotice(tt('transfer.uploaded', { bytes: outcome.transferredBytes }))
      void load(alias, dir)
    } catch (cause) {
      setError(tt('transfer.fail', { error: errorMessage(cause) }))
    } finally {
      setProgress(null)
    }
  }

  return (
    <div className={css.fillBody}>
      <div className={css.toolbar}>
        <select className={css.input} value={alias} onChange={event => { pickAlias(event.target.value) }}>
          <option value="">{tt('transfer.select')}</option>
          {aliases.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <input className={css.search} value={dir} onChange={event => { setDir(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') open() }} />
        <button type="button" className={css.primaryButton} disabled={alias === '' || dir === ''} onClick={open}>{tt('transfer.go')}</button>
        <button type="button" className={css.ghostButton} disabled={alias === ''} onClick={() => { void load(alias, dir.replace(/[\\/][^\\/]*$/, '') || 'C:\\') }}>{tt('transfer.up')}</button>
        <button type="button" className={css.ghostButton} disabled={alias === ''} onClick={() => { void load(alias, 'C:\\') }}>{tt('transfer.root')}</button>
        <div className={css.toolbarSpacer} />
        <button type="button" className={css.ghostButton} disabled={alias === ''} onClick={() => { fileInputRef.current?.click() }}>{tt('transfer.upload')}</button>
        <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={event => {
          const file = event.target.files?.[0]
          if (file !== undefined) void upload(file)
          event.target.value = ''
        }} />
      </div>
      {notice !== null && <div className={css.banner} data-kind="ok">{notice}</div>}
      {error !== null && <div className={css.banner} data-kind="error">{error}</div>}
      {progress !== null && (
        <div className={css.banner} data-kind="ok">
          {progress.phase === 'transferring' ? (progress.total > 0 ? tt('transfer.downloading') : tt('transfer.uploading')) : tt('transfer.uploading')}
          {' '}{formatBytes(progress.transferred)}{progress.total > 0 ? ' / ' + formatBytes(progress.total) + ' (' + progress.percent + '%)' : ''}
        </div>
      )}
      {entries === null && alias !== '' && error === null && <div className={css.loading}>{tt('common.loading')}</div>}
      {entries !== null && (
        <div className={css.tableWrap}>
          <table className={css.table}>
            <thead>
              <tr>
                <th>{tt('transfer.name')}</th>
                <th>{tt('transfer.type')}</th>
                <th>{tt('transfer.size')}</th>
                <th>{tt('transfer.modified')}</th>
                <th>{tt('hosts.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.name}>
                  <td>
                    {entry.type === 'dir' ? (
                      <button type="button" className={css.linkButton} onClick={() => { void load(alias, joinPath(dir, entry.name)) }}>📁 {entry.name}</button>
                    ) : (
                      <span className={css.mono}>{entry.name}</span>
                    )}
                  </td>
                  <td>{entry.type === 'dir' ? tt('transfer.dir') : tt('transfer.file')}</td>
                  <td>{entry.type === 'file' ? formatBytes(entry.size) : ''}</td>
                  <td className={css.cellMuted}>{entry.mtimeMs > 0 ? new Date(entry.mtimeMs).toLocaleString() : ''}</td>
                  <td>
                    {entry.type === 'file' && (
                      <button type="button" className={css.linkButton} onClick={() => { void download(entry) }}>{tt('transfer.download')}</button>
                    )}
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
