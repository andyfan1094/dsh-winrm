/**
 * Agent tools: the DSH-native counterpart of the GUI — every tool talks to
 * the same engine the web UI uses, so a host configured in the GUI is
 * immediately operable by any agent, and vice versa.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { WinRmEngine } from './engine.ts'
import type { ClusterResult, ExecResult, WinHostSummary } from './protocol.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Host table render shared by list surfaces. */
function renderHosts(hosts: WinHostSummary[]): string {
  if (hosts.length === 0) return 'no hosts configured'
  const rows = hosts.map(host => [
    host.alias,
    host.host,
    String(host.port),
    host.user,
    host.transport,
    host.environment ?? '-',
    (host.tags.length > 0 ? host.tags.join(',') : '-'),
    host.description ?? '',
  ].join(' | '))
  return ['alias | host | port | user | transport | environment | tags | description', '--- | --- | --- | --- | --- | --- | --- | ---', ...rows].join('\n')
}

/** Render one exec result (mirrors the bash-tool exit-code convention). */
function renderExec(result: ExecResult): string {
  const marker = result.timedOut
    ? '[timed out]'
    : `[exit code: ${result.exitCode ?? 'null'}]`
  const parts = [marker]
  if (result.stdout !== '') parts.push('stdout:\n' + result.stdout)
  if (result.stderr !== '') parts.push('stderr:\n' + result.stderr)
  if (result.error !== undefined) parts.push('error: ' + result.error)
  parts.push(`duration: ${result.durationMs} ms`)
  return parts.join('\n')
}

/** Render cluster outcomes compactly. */
function renderCluster(results: ClusterResult[]): string {
  if (results.length === 0) return 'no hosts matched'
  return results.map(result => {
    const status = result.ok ? 'ok' : result.timedOut === true ? 'timed out' : 'failed'
    const tail = result.error !== undefined ? ' (' + result.error + ')' : ''
    return `${result.alias}: ${status} [exit code: ${result.exitCode ?? 'null'}]${tail}`
  }).join('\n')
}

/** The host-list tool. */
export function winrmListTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_list',
    description: 'List configured Windows hosts (alias, host, port, user, transport, environment, tags, description). Use winrm_exec etc. with the alias. ' +
      'Triggers: Windows server, WinRM, PowerShell remote, check server/status, deploy to Windows.',
    parameters: {
      query: { type: 'string', description: 'Optional fuzzy match against alias, description, host, and tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hosts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                user: { type: 'string', required: true },
                auth: { type: 'string', enum: ['password'], required: true },
                transport: { type: 'string', enum: ['http', 'https'], required: true },
                description: { type: 'string' },
                environment: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                location: { type: 'string' },
                createdAt: { type: 'integer', required: true },
                updatedAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { hosts?: WinHostSummary[] }) => text(renderHosts(value.hosts ?? [])),
    },
    async execute(args) {
      return { hosts: engine.list(args.query) }
    },
  })
}

/** The command-execution tool (PowerShell). */
export function winrmExecTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_exec',
    description: 'Execute a PowerShell command on a configured Windows host by alias. The command runs under PowerShell with UTF-8 output; prefer combining independent read-only queries into one command. ' +
      'Triggers: run command on Windows server, PowerShell remote, check server/status, service control, view logs, any remote Windows operation.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from winrm_list.' },
      command: { type: 'string', required: true, description: 'The PowerShell command to run remotely (script body, no powershell.exe wrapper needed).' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 60000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          timedOut: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value: ExecResult) => text(renderExec(value)),
    },
    async execute(args) {
      return engine.exec(args.alias, args.command, args.timeoutMs)
    },
  })
}

/** The service-management tool. */
export function winrmServiceTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_service',
    description: 'Manage Windows services on a configured host: list all services, or start/stop/restart one and change its startup type. ' +
      'Triggers: service control, start/stop/restart Windows service, check service status, set service startup type.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from winrm_list.' },
      name: { type: 'string', description: 'Service name (required for actions; omitted lists all services).' },
      action: { type: 'string', enum: ['list', 'start', 'stop', 'restart', 'set-auto', 'set-manual', 'set-disabled'], description: 'list (default) / start / stop / restart / set-auto / set-manual / set-disabled.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          services: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                displayName: { type: 'string', required: true },
                status: { type: 'string', required: true },
                startMode: { type: 'string', required: true },
                startName: { type: 'string' },
              },
            },
          },
          service: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              displayName: { type: 'string', required: true },
              status: { type: 'string', required: true },
              startMode: { type: 'string', required: true },
              startName: { type: 'string' },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { services?: Array<{ name: string; displayName: string; status: string; startMode: string }>; service?: { name: string; displayName: string; status: string; startMode: string }; error?: string }) => {
        if (value.error !== undefined) return text('service error: ' + value.error)
        if (value.services !== undefined) {
          if (value.services.length === 0) return text('no services')
          return text(['name | displayName | status | startMode', '--- | --- | --- | ---', ...value.services.map(s => `${s.name} | ${s.displayName} | ${s.status} | ${s.startMode}`)].join('\n'))
        }
        if (value.service !== undefined) {
          const s = value.service
          return text(`service ${s.name}: ${s.status} (startMode ${s.startMode}, displayName ${s.displayName})`)
        }
        return text('no result')
      },
    },
    async execute(args) {
      try {
        if (args.name === undefined || args.action === undefined || args.action === 'list') {
          return { services: await engine.listServices(args.alias) }
        }
        const service = await engine.serviceAction(args.alias, args.name, args.action)
        return { service }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The process-management tool. */
export function winrmProcessTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_process',
    description: 'Manage processes on a configured Windows host: list all processes, or kill one by id. ' +
      'Triggers: process list, kill process, check what is running on a Windows server.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from winrm_list.' },
      id: { type: 'integer', description: 'Process id (required for kill; omitted lists processes).' },
      action: { type: 'string', enum: ['list', 'kill'], description: 'list (default) / kill.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          processes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                name: { type: 'string', required: true },
                cpu: { type: 'number' },
                memMB: { type: 'number' },
                startTime: { type: 'string' },
                path: { type: 'string' },
              },
            },
          },
          killed: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { processes?: Array<{ id: number; name: string; cpu?: number; memMB?: number; startTime?: string }>; killed?: number; error?: string }) => {
        if (value.error !== undefined) return text('process error: ' + value.error)
        if (value.processes !== undefined) {
          if (value.processes.length === 0) return text('no processes')
          return text(['id | name | cpu | memMB | startTime', '--- | --- | --- | --- | ---', ...value.processes.map(p => `${p.id} | ${p.name} | ${p.cpu ?? ''} | ${p.memMB ?? ''} | ${p.startTime ?? ''}`)].join('\n'))
        }
        return text(`killed process ${value.killed ?? 0}`)
      },
    },
    async execute(args) {
      try {
        if (args.action === 'kill' && args.id !== undefined) {
          await engine.killProcess(args.alias, args.id)
          return { killed: args.id }
        }
        return { processes: await engine.listProcesses(args.alias) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The upload tool. */
export function winrmUploadTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_upload',
    description: 'Upload a local file to a configured Windows host (SMB admin share preferred, base64 WinRM chunk fallback). The local path is on THIS machine (the dsh host). ' +
      'Triggers: upload file to Windows server, deploy artifact, copy config to Windows server.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from winrm_list.' },
      localPath: { type: 'string', required: true, description: 'Absolute local file path on this machine.' },
      remotePath: { type: 'string', required: true, description: 'Destination path on the remote host, e.g. C:\\temp\\file.txt (parent dirs are created).' },
      channel: { type: 'string', enum: ['auto', 'smb', 'winrm'], description: 'Transfer channel: smb (admin share), winrm (base64 chunks), or auto (default, SMB first with WinRM fallback).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          transferredBytes: { type: 'integer' },
          channel: { type: 'string', enum: ['smb', 'winrm'] },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; transferredBytes?: number; channel?: string; error?: string }) => text(value.ok
        ? `uploaded ${value.transferredBytes ?? 0} bytes via ${value.channel ?? 'unknown'}`
        : `upload failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        const outcome = await engine.upload(args.alias, args.localPath, args.remotePath, undefined, args.channel ?? 'auto')
        const usedChannel: 'smb' | 'winrm' = outcome.channel === 'smb' ? 'smb' : 'winrm'
        return { ok: true, transferredBytes: outcome.bytes, channel: usedChannel }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The download tool. */
export function winrmDownloadTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_download',
    description: 'Download a remote FILE from a configured Windows host to a local path on this machine (SMB admin share preferred, base64 WinRM chunk fallback). Directory download is not supported — download files individually. ' +
      'Triggers: download file from Windows server, fetch remote log/artifact.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from winrm_list.' },
      remotePath: { type: 'string', required: true, description: 'Remote file path, e.g. C:\\temp\\file.txt.' },
      localPath: { type: 'string', required: true, description: 'Absolute destination path on this machine.' },
      channel: { type: 'string', enum: ['auto', 'smb', 'winrm'], description: 'Transfer channel: smb (admin share), winrm (base64 chunks), or auto (default, SMB first with WinRM fallback).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          bytes: { type: 'integer' },
          channel: { type: 'string', enum: ['smb', 'winrm'] },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; bytes?: number; channel?: string; error?: string }) => text(value.ok
        ? `downloaded ${value.bytes ?? 0} bytes via ${value.channel ?? 'unknown'}`
        : `download failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        const outcome = await engine.download(args.alias, args.remotePath, args.localPath, undefined, args.channel ?? 'auto')
        const usedChannel: 'smb' | 'winrm' = outcome.channel === 'smb' ? 'smb' : 'winrm'
        return { ok: true, bytes: outcome.bytes, channel: usedChannel }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The cluster tool. */
export function winrmClusterTool(engine: WinRmEngine) {
  return defineTool({
    name: 'winrm_cluster',
    description: 'Run one PowerShell command concurrently across many Windows hosts (all hosts, or filtered by aliases / environment / tags). ' +
      'Triggers: run on all Windows servers, batch operation, production servers, cluster command.',
    parameters: {
      command: { type: 'string', required: true, description: 'The PowerShell command to run on every matched host.' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Explicit alias list; when absent every configured host matches.' },
      environment: { type: 'string', description: 'Only hosts with this environment label.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Only hosts carrying ALL these tags.' },
      timeoutMs: { type: 'integer', description: 'Per-host timeout in milliseconds.' },
      maxWorkers: { type: 'integer', description: 'Concurrency cap (default 8).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                timedOut: { type: 'boolean' },
                stdout: { type: 'string' },
                stderr: { type: 'string' },
                durationMs: { type: 'integer' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value: { results?: ClusterResult[] }) => text(renderCluster(value.results ?? [])),
    },
    async execute(args) {
      return { results: await engine.cluster(args) }
    },
  })
}
