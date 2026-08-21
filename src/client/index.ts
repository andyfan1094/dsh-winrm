/**
 * Browser-half entry for the dsh-winrm plugin — runs inside the dsh web GUI.
 * Registers locale dictionaries and mounts the sidebar entry + the Windows
 * operations panel in the center column. DOM mounting problems are logged,
 * never thrown — an external plugin must not take the GUI down.
 *
 * Export discipline (packages/client rule): the /client surface carries what
 * cordis loading needs plus types only — all value exports stay internal.
 */
import type { ClientContext, SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings-surface Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { WinrmApi } from './api.ts'
import { en, zh, type WinKey } from './locales.ts'
import { mountPanel } from './mount.tsx'
import { PanelController } from './panel/controller.ts'
import { mountSidebarEntry } from './sidebar-entry.ts'

/** Locale namespace this plugin owns. */
const NS = 'dsh-winrm'

/** Settings namespace this plugin owns. */
const SETTINGS_NS = 'dsh-winrm'

/** The dsh-winrm settings surface the browser half reads (unused so far). */
interface WinrmClientSettings {
  terminalFontFamily?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webUiSettings?: { bind<S>(spec: SettingsScopeSpec<S>): SettingsScope<S> }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-winrm surface copy. */
    'dsh-winrm': WinKey
  }
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale', 'settingsScope']

/** Type-only surface (export discipline: no value exports beyond the plugin contract). */
export type { PanelControllerSnapshot } from './panel/controller.ts'
export type { WinrmPanelProps } from './panel/WinrmPanel.tsx'
export type { HostsTabProps } from './panel/HostsTab.tsx'
export type { HostFormDialogProps } from './panel/HostFormDialog.tsx'
export type { ConsoleTabProps } from './panel/ConsoleTab.tsx'
export type { ServicesTabProps } from './panel/ServicesTab.tsx'
export type { ProcessesTabProps } from './panel/ProcessesTab.tsx'
export type { TransferTabProps } from './panel/TransferTab.tsx'
export type { WinKey } from './locales.ts'

/**
 * Mount the WinRM panel.
 * @param ctx - client root context (locale service).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-winrm: dictionaries')

  const controller = new PanelController()
  const api = new WinrmApi()
  const disposers: Array<() => void> = []
  try {
    disposers.push(mountSidebarEntry(controller))
    disposers.push(mountPanel(controller, api))
  } catch (error) {
    // DOM failures degrade the panel, never the GUI.
    console.warn('[dsh-winrm] mount failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-winrm: ui mounts')
}
