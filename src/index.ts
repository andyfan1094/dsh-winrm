/**
 * dsh-winrm — host half. Mounts the WinRM engine (per-call PowerShell
 * execution with a UTF-8 envelope, streaming console, service/process
 * management, base64-chunked file transfer, cluster), the /api/dsh-winrm
 * route family plus the console WebSocket upgrade, the agent tools
 * (winrm_list, winrm_exec, winrm_service, winrm_process, winrm_upload,
 * winrm_download, winrm_cluster), and a system-prompt announcement. The
 * browser half (./client) renders the host manager and operations panel.
 * Everything rides official NPM SDK packages — no dsh source changes.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { WinRmEngine } from './engine.ts'
import { makeRoutes } from './routes.ts'
import { HostStore } from './store.ts'
import {
  winrmClusterTool,
  winrmDownloadTool,
  winrmExecTool,
  winrmListTool,
  winrmProcessTool,
  winrmServiceTool,
  winrmUploadTool,
} from './tools.ts'
import { mountOnce } from './mount-once.ts'

/** Stable cordis plugin name. */
export const name = 'winrm'

/** Services required before the WinRM surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Settings namespace of the WinRM capability. */
export const WINRM_SETTINGS_NAMESPACE = settingsNamespace('dsh-winrm')

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin to every agent. */
  announceToAgent?: boolean
  /** Master switch for the plugin (routes, tools, prompt section). */
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  announceToAgent: z.boolean().default(true),
  enabled: z.boolean().default(true),
})

/** Schema default, re-read for hand-built test contexts. */
const DEFAULT_ANNOUNCE = true

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 151

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const WINRM_GUIDANCE = '本机已安装 dsh-winrm 插件（DSH 远程 Windows 运维，WinRM/PowerShell Remoting）：侧边栏「Windows」入口；仿照 dsh-ssh 插件开发。能力：主机配置存 ~/.dsh/dsh-winrm.json（GUI 配置后 agent 方可使用）；winrm_list 列出主机、winrm_exec 执行 PowerShell 命令（UTF-8 信封，中文不乱码）、winrm_service 服务管理（start/stop/restart/启动类型）、winrm_process 进程管理（list/kill）、winrm_upload/winrm_download 文件传输（base64 分块，无 SMB 依赖）、winrm_cluster 集群并发执行；Web 控制台走 WebSocket。认证：通过本机 Python pywinrm 的 NTLM/Negotiate 实现，兼容本地账户与域账户；传输支持 http(5985)/https(5986)。前提：目标机需启用 WinRM，本机需安装 pywinrm（python -m pip install pywinrm）。HTTP 仅建议受信内网使用；密码以明文存在用户主目录私有文件（权限 0600）；命令输出可能含敏感信息；传输/执行消耗真实远程资源，先确认再操作。用户提到「Windows 服务器 / WinRM / PowerShell 远程 / 服务管理 / 进程管理」时即指本插件，请据此协作。'

/**
 * Mount the WinRM engine, routes, tools, and announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - resolved plugin config.
 */
export const apply = mountOnce('dsh-winrm', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  let current: () => Config = () => config ?? {}
  const resolve = (): Config => {
    const value = current()
    return {
      announceToAgent: value.announceToAgent ?? DEFAULT_ANNOUNCE,
      enabled: value.enabled ?? true,
    }
  }

  const store = new HostStore()
  const engine = new WinRmEngine(store)
  ctx.effect(() => () => { engine.dispose() }, 'dsh-winrm: engine')

  const { routes, upgrade } = makeRoutes({ store, engine })
  let disposeRoutes: (() => void) | undefined

  const tools = [
    winrmListTool(engine),
    winrmExecTool(engine),
    winrmServiceTool(engine),
    winrmProcessTool(engine),
    winrmUploadTool(engine),
    winrmDownloadTool(engine),
    winrmClusterTool(engine),
  ]
  let disposeTools: (() => void) | undefined

  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
    if (disposeRoutes !== undefined) { disposeRoutes(); disposeRoutes = undefined }
    if (disposeTools !== undefined) { disposeTools(); disposeTools = undefined }
    const value = resolve()
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-winrm',
        order: SECTION_ORDER,
        text: WINRM_GUIDANCE,
      })
    }
    disposeRoutes = ctx.effect(
      () => {
        const disposers = routes.map(route => ctx.webServer.register(route))
        const upgradeDisposer = ctx.webServer.registerUpgrade(upgrade)
        return () => {
          for (const dispose of disposers) dispose()
          upgradeDisposer()
        }
      },
      'dsh-winrm: routes',
    )
    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-winrm: tools',
    )
  }

  installSettingsSection(ctx, WINRM_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => {
      current = source
      sync()
    },
    onChange: sync,
  })

  sync()
}
