/**
 * PowerShell snippet builders. Every payload rides the UTF-8 base64
 * envelope: the WinRM host prints only ASCII (marker + base64 of UTF-8 text)
 * so Chinese / any codepage output survives the transport losslessly. One-shot
 * commands execute directly in the PowerShell session created by WinRM.
 */

/** Marker line prefix carrying the exit code: '__DSH_WINRM__<code>'. */
export const ENVELOPE_MARKER = '__DSH_WINRM__'

/** PS single-quoted literal (doubles embedded quotes). */
export function sq(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

/** Base64 of a UTF-16LE PowerShell script, for -EncodedCommand. */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * The UTF-8 WinRM session script: runs `userScript` inside a script block,
 * merges stderr, prints the exit-code marker and base64 of UTF-8 output.
 */
export function wrapEnvelope(userScript: string): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    "$__out = & { " + userScript + " } 2>&1 | Out-String -Width 4096",
    "$__code = 0",
    "if ($null -ne $LASTEXITCODE) { $__code = $LASTEXITCODE }",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "'__DSH_WINRM__' + [string]$__code",
    "[System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$__out))",
    '',
  ].join('\r\n')
}

/** One-shot script body for the PowerShell session already created by WinRM. */
export function winrmPowerShellScript(userScript: string): string {
  return wrapEnvelope(userScript)
}

/** The full powershell.exe command line (ASCII-safe) for a script body. */
export function powershellCommandLine(script: string): string {
  return 'powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -EncodedCommand ' + encodeCommand(script)
}

/** One-shot non-interactive PowerShell command line (envelope-wrapped). */
export function execCommandLine(userScript: string): string {
  return powershellCommandLine(wrapEnvelope(userScript))
}

/** Interactive bootstrap for the streaming console (keeps the shell alive). */
export function consoleCommandLine(): string {
  const bootstrap = [
    "$ErrorActionPreference = 'Continue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "'__DSH_WINRM_CONSOLE_READY__'",
    '',
  ].join('\r\n')
  // -NoExit keeps powershell.exe alive reading stdin (interactive mode).
  return 'powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -EncodedCommand '
    + encodeCommand(bootstrap) + ' -NoExit'
}

// ------------------------------------------------------------ snippets

/** JSON: full service table (CIM). */
export function psListServices(): string {
  return [
    '$__s = Get-CimInstance Win32_Service | Select-Object Name, DisplayName, State, StartMode, StartName | ForEach-Object {',
    '  [PSCustomObject]@{ name=$_.Name; displayName=$_.DisplayName; status=[string]$_.State; startMode=[string]$_.StartMode; startName=[string]$_.StartName }',
    '}',
    'ConvertTo-Json -InputObject $__s -Compress -Depth 3',
    '',
  ].join('\r\n')
}

/** JSON: one service after an action. */
export function psServiceAction(name: string, action: 'start' | 'stop' | 'restart' | 'set-auto' | 'set-manual' | 'set-disabled'): string {
  const statements: string[] = []
  if (action === 'start') statements.push('Start-Service -Name ' + sq(name) + ' -ErrorAction Stop')
  if (action === 'stop') statements.push('Stop-Service -Name ' + sq(name) + ' -Force -ErrorAction Stop')
  if (action === 'restart') statements.push('Restart-Service -Name ' + sq(name) + ' -Force -ErrorAction Stop')
  if (action === 'set-auto') statements.push('Set-Service -Name ' + sq(name) + ' -StartupType Automatic -ErrorAction Stop')
  if (action === 'set-manual') statements.push('Set-Service -Name ' + sq(name) + ' -StartupType Manual -ErrorAction Stop')
  if (action === 'set-disabled') statements.push('Set-Service -Name ' + sq(name) + ' -StartupType Disabled -ErrorAction Stop')
  statements.push('$__s = Get-CimInstance Win32_Service -Filter ' + sq('Name=' + name.replace(/'/g, "''")) + ' | Select-Object Name, DisplayName, State, StartMode, StartName')
  statements.push('ConvertTo-Json -InputObject $__s -Compress -Depth 3')
  return statements.join('\r\n')
}

/** JSON: process table. */
export function psListProcesses(): string {
  return [
    '$__p = Get-Process | Sort-Object Id | Select-Object Id, ProcessName, CPU, WS, StartTime, Path | ForEach-Object {',
    '  [PSCustomObject]@{ id=$_.Id; name=$_.ProcessName; cpu=if($null -eq $_.CPU){$null}else{[math]::Round([double]$_.CPU,1)}; memMB=[math]::Round($_.WS/1MB,1); startTime=if($_.StartTime){$_.StartTime.ToString(\'yyyy-MM-dd HH:mm:ss\')}else{$null}; path=[string]$_.Path }',
    '}',
    'ConvertTo-Json -InputObject $__p -Compress -Depth 3',
    '',
  ].join('\r\n')
}

/** Kill one process by id. */
export function psKillProcess(id: number): string {
  return 'Stop-Process -Id ' + String(id) + ' -Force -ErrorAction Stop; "killed " + ' + String(id)
}

/** JSON: directory listing. */
export function psListDir(dir: string): string {
  return [
    '$__d = ' + sq(dir),
    '$__items = Get-ChildItem -LiteralPath $__d -Force -ErrorAction Stop | Select-Object Name, PSIsContainer, Length, LastWriteTime | ForEach-Object {',
    '  [PSCustomObject]@{ name=[string]$_.Name; type=if($_.PSIsContainer){\'dir\'}elseif(-not $_.PSIsContainer -and $_.Length -ge 0){\'file\'}else{\'other\'}; size=if($_.PSIsContainer){0}else{[long]$_.Length}; mtimeMs=[long](([DateTimeOffset]$_.LastWriteTime).ToUnixTimeMilliseconds()) }',
    '}',
    'ConvertTo-Json -InputObject $__items -Compress -Depth 3',
    '',
  ].join('\r\n')
}

/** Plain: remote file size in bytes (0 when missing). */
export function psFileSize(p: string): string {
  return [
    '$__f = Get-Item -LiteralPath ' + sq(p) + ' -ErrorAction SilentlyContinue',
    'if ($null -eq $__f) { "0" } elseif ($__f.PSIsContainer) { "0" } else { [string]$__f.Length }',
    '',
  ].join('\r\n')
}

/** Plain: base64 of up to `count` bytes at `offset` (download chunk). */
export function psReadChunk(p: string, offset: number, count: number): string {
  return [
    '$__p = ' + sq(p),
    '$__fs = [System.IO.File]::OpenRead($__p)',
    'try {',
    '  $__fs.Position = [long]' + String(offset),
    '  $__buf = New-Object byte[] ' + String(count),
    '  $__n = $__fs.Read($__buf, 0, $__buf.Length)',
    '  [System.Convert]::ToBase64String($__buf, 0, $__n)',
    '} finally { $__fs.Dispose() }',
    '',
  ].join('\r\n')
}

/**
 * Plain: append `b64` bytes to `p` (Create on first chunk, Append after),
 * prints the number of bytes written.
 */
export function psWriteChunk(p: string, b64: string, append: boolean): string {
  return [
    '$__p = ' + sq(p),
    '$__d = [System.IO.Path]::GetDirectoryName($__p)',
    'if (-not [string]::IsNullOrEmpty($__d)) { [System.IO.Directory]::CreateDirectory($__d) | Out-Null }',
    '$__b = [System.Convert]::FromBase64String(' + sq(b64) + ')',
    '$__mode = ' + (append ? '[System.IO.FileMode]::Append' : '[System.IO.FileMode]::Create'),
    '$__fs = New-Object System.IO.FileStream($__p, $__mode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)',
    'try { $__fs.Write($__b, 0, $__b.Length) } finally { $__fs.Dispose() }',
    '[string]$__b.Length',
    '',
  ].join('\r\n')
}

/** Parse the envelope output: { exitCode, text } or null when absent. */
export function parseEnvelope(output: string): { exitCode: number; text: string } | null {
  const match = /^__DSH_WINRM__(\d+)\r?\n([\s\S]*)$/.exec(output)
  if (match === null) return null
  const exitCode = Number.parseInt(match[1], 10)
  const payload = match[2].trim()
  try {
    const text = Buffer.from(payload, 'base64').toString('utf8')
    return { exitCode, text }
  } catch {
    return { exitCode, text: payload }
  }
}
