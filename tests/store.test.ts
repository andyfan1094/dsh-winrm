import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HostStore, validateAlias, validateHostPayload } from '../src/store.ts'

function pathFor(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-winrm-store-')), 'hosts.json')
}

test('host summaries never expose passwords', () => {
  const path = pathFor()
  const store = new HostStore(path)
  const entry = store.create({ alias: 'server-1', host: '127.0.0.1', user: 'Admin', auth: { kind: 'password', password: 'secret-password' }, tags: [] })
  const summary = store.summarize(entry)
  assert.equal(summary.auth, 'password')
  assert.equal('password' in summary, false)
  assert.equal(JSON.stringify(summary).includes('secret-password'), false)
  assert.equal(readFileSync(path, 'utf8').includes('secret-password'), true)
})

test('host payload and alias validation reject unsafe shapes', () => {
  assert.match(validateAlias('../bad') ?? '', /alias/)
  assert.match(validateHostPayload({ host: '', user: 'Admin' }) ?? '', /host is required/)
  assert.match(validateHostPayload({ host: 'server', user: 'Admin', port: 70000 }) ?? '', /1\.\.65535/)
})