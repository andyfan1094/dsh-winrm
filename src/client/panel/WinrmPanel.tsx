/**
 * The WinRM operations panel shell: a header with a close control, a
 * five-tab bar, and the active tab's content. Tab state lives here; inactive
 * tabs unmount, so each tab fetches its own data on activation. The hosts
 * tab's connect action switches here to the console tab with the chosen
 * alias preselected.
 */
import { useState } from 'react'
import type { WinrmApi } from '../api.ts'
import type { PanelController } from './controller.ts'
import { tt } from './helpers.ts'
import { ConsoleTab } from './ConsoleTab.tsx'
import { HostsTab } from './HostsTab.tsx'
import { ProcessesTab } from './ProcessesTab.tsx'
import { ServicesTab } from './ServicesTab.tsx'
import { TransferTab } from './TransferTab.tsx'
import css from './panel.module.css'

/** The panel's tab identifiers. */
export type WinrmTab = 'hosts' | 'console' | 'services' | 'processes' | 'transfer'

/** Panel shell props. */
export interface WinrmPanelProps {
  /** The panel state owner (open/close/toggle). */
  controller: PanelController
  /** The WinRM API client every tab operates through. */
  api: WinrmApi
}

/** The tab bar definition (labels resolved at render time). */
const TABS: ReadonlyArray<{ id: WinrmTab; label: () => string }> = [
  { id: 'hosts', label: () => tt('tab.hosts') },
  { id: 'console', label: () => tt('tab.console') },
  { id: 'services', label: () => tt('tab.services') },
  { id: 'processes', label: () => tt('tab.processes') },
  { id: 'transfer', label: () => tt('tab.transfer') },
]

/** A pending "connect this host" request handed to the console tab. */
interface ConnectRequest {
  alias: string
  nonce: number
}

/** The tabbed WinRM panel. */
export function WinrmPanel({ controller, api }: WinrmPanelProps) {
  const [activeTab, setActiveTab] = useState<WinrmTab>('hosts')
  const [connectRequest, setConnectRequest] = useState<ConnectRequest | null>(null)

  const handleConnect = (alias: string): void => {
    setActiveTab('console')
    setConnectRequest(prev => ({ alias, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  return (
    <div className={css.panel}>
      <div className={css.panelHeader}>
        <button
          type="button"
          className={`${css.ghostButton} ${css.backButton}`}
          aria-label={tt('panel.backToConversation')}
          onClick={() => { controller.close() }}
        >
          <span aria-hidden="true">‹</span>
          <span>{tt('panel.backToConversation')}</span>
        </button>
        <h2 className={css.panelTitle}>{tt('panel.title')}</h2>
      </div>
      <div className={css.tabBar} role="tablist" data-dsh-part="tab-bar">
        {TABS.map(tab => (
          <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} data-active={activeTab === tab.id ? '' : undefined} className={css.tab} onClick={() => { setActiveTab(tab.id) }}>
            {tab.label()}
          </button>
        ))}
      </div>
      <div className={css.panelContent}>
        {activeTab === 'hosts' && <HostsTab api={api} onConnect={handleConnect} />}
        {activeTab === 'console' && <ConsoleTab api={api} presetAlias={connectRequest?.alias} requestId={connectRequest?.nonce} />}
        {activeTab === 'services' && <ServicesTab api={api} />}
        {activeTab === 'processes' && <ProcessesTab api={api} />}
        {activeTab === 'transfer' && <TransferTab api={api} />}
      </div>
    </div>
  )
}
