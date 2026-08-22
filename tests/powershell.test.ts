import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeCommand, parseEnvelope, psReadChunk, psServiceAction, psWriteChunk, sq, wrapEnvelope } from '../src/powershell.ts'

test('PowerShell literals and envelopes preserve Unicode safely', () => {
  assert.equal(sq("a'b"), "'a''b'")
  const script = wrapEnvelope("Write-Output '中文'")
  assert.match(script, /ToBase64String/)
  assert.ok(encodeCommand(script).length > script.length)
  const payload = Buffer.from('中文输出', 'utf8').toString('base64')
  assert.deepEqual(parseEnvelope(`__DSH_WINRM__0\n${payload}`), { exitCode: 0, text: '中文输出' })
})

test('service and transfer snippets quote user-controlled paths and names', () => {
  assert.match(psServiceAction("svc'name", 'restart'), /svc''name/)
  assert.match(psReadChunk("C:\\a'b.bin", 48, 96), /a''b\.bin/)
  assert.match(psWriteChunk("C:\\a'b.bin", 'YQ==', false), /FileMode\]::Create/)
})