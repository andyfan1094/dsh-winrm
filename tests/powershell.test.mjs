import assert from 'node:assert/strict'
import test from 'node:test'

import { winrmPowerShellScript } from '../src/powershell.ts'

test('builds a direct script for the existing WinRM PowerShell host', () => {
  const script = winrmPowerShellScript('Write-Output "hello"')

  assert.match(script, /__DSH_WINRM__/)
  assert.match(script, /Write-Output "hello"/)
  assert.doesNotMatch(script, /powershell\.exe/i)
  assert.doesNotMatch(script, /-EncodedCommand/i)
})
