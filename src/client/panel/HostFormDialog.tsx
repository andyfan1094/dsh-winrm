/**
 * Host form dialog: create/edit one Windows host entry. Passwords are never
 * returned by the API — the edit form shows a placeholder and keeps the
 * stored secret unless a new one is typed.
 */
import { useEffect, useState } from 'react'
import type { WinrmApi } from '../api.ts'
import type { WinHostPayload, WinHostSummary } from '../../protocol.ts'
import { errorMessage, tt } from './helpers.ts'
import css from './panel.module.css'

/** Host form dialog props. */
export interface HostFormDialogProps {
  api: WinrmApi
  /** The host being edited, or null for create. */
  editing: WinHostSummary | null
  onClose: () => void
  onSaved: () => void
}

/** The create/edit host dialog. */
export function HostFormDialog({ api, editing, onClose, onSaved }: HostFormDialogProps) {
  const [alias, setAlias] = useState(editing?.alias ?? '')
  const [host, setHost] = useState(editing?.host ?? '')
  const [port, setPort] = useState(String(editing?.port ?? 5985))
  const [user, setUser] = useState(editing?.user ?? '')
  const [password, setPassword] = useState('')
  const [transport, setTransport] = useState<'http' | 'https'>(editing?.transport ?? 'http')
  const [rejectUnauthorized, setRejectUnauthorized] = useState(editing?.rejectUnauthorized ?? false)
  const [environment, setEnvironment] = useState(editing?.environment ?? '')
  const [tags, setTags] = useState(editing?.tags.join(', ') ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const submit = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const payload: WinHostPayload = {
      host: host.trim(),
      port: Number.parseInt(port, 10) || 5985,
      user: user.trim(),
      transport,
      rejectUnauthorized,
      environment: environment.trim() || undefined,
      tags: tags.split(',').map(tag => tag.trim()).filter(tag => tag !== ''),
      description: description.trim() || undefined,
    }
    if (password !== '') payload.auth = { kind: 'password', password }
    try {
      if (editing === null) {
        payload.alias = alias.trim()
        await api.createHost(payload)
      } else {
        await api.updateHost(editing.alias, payload)
      }
      onSaved()
    } catch (cause) {
      setError(errorMessage(cause))
      setSaving(false)
    }
  }

  return (
    <div className={css.dialogOverlay}>
      <div className={css.dialog}>
        <h3 className={css.dialogTitle}>{editing === null ? tt('form.title.create') : tt('form.title.edit', { alias: editing.alias })}</h3>
        <div className={css.formCard}>
          {editing === null && (
            <label className={css.field}>
              <span className={css.fieldLabel}>{tt('form.alias')}</span>
              <input className={css.input} value={alias} onChange={event => { setAlias(event.target.value) }} placeholder={tt('form.aliasHint')} />
            </label>
          )}
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('form.host')}</span>
            <input className={css.input} value={host} onChange={event => { setHost(event.target.value) }} />
          </label>
          <div className={css.formRow}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{tt('form.port')}</span>
              <input className={css.input} type="number" value={port} onChange={event => { setPort(event.target.value) }} />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{tt('form.transport')}</span>
              <select className={css.input} value={transport} onChange={event => {
                const next = event.target.value as 'http' | 'https'
                setTransport(next)
                if (port === '5985' || port === '5986') setPort(next === 'https' ? '5986' : '5985')
              }}>
                <option value="http">{tt('form.transport.http')}</option>
                <option value="https">{tt('form.transport.https')}</option>
              </select>
            </label>
          </div>
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('form.user')}</span>
            <input className={css.input} value={user} onChange={event => { setUser(event.target.value) }} placeholder={tt('form.userHint')} />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('form.password')}</span>
            <input className={css.input} type="password" value={password} onChange={event => { setPassword(event.target.value) }} placeholder={editing !== null ? tt('form.passwordPlaceholder') : undefined} />
            <span className={css.fieldHint}>{tt('form.passwordHint')}</span>
          </label>
          {transport === 'https' && (
            <label className={css.checkRow}>
              <input type="checkbox" checked={!rejectUnauthorized} onChange={event => { setRejectUnauthorized(!event.target.checked) }} />
              <span>{tt('form.rejectUnauthorized')}</span>
            </label>
          )}
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('form.environment')}</span>
            <input className={css.input} value={environment} onChange={event => { setEnvironment(event.target.value) }} />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('form.tags')}</span>
            <input className={css.input} value={tags} onChange={event => { setTags(event.target.value) }} />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('form.description')}</span>
            <input className={css.input} value={description} onChange={event => { setDescription(event.target.value) }} />
          </label>
          {error !== null && <div className={css.formError}>{tt('form.error', { error })}</div>}
          <div className={css.actions}>
            <button type="button" className={css.ghostButton} onClick={onClose}>{tt('form.cancel')}</button>
            <button type="button" className={css.primaryButton} disabled={saving} onClick={() => { void submit() }}>
              {saving ? tt('common.loading') : tt('form.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
