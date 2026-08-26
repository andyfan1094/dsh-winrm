import test from 'node:test'
import assert from 'node:assert/strict'
import { adminSharePath } from '../src/smb.ts'

test('admin share path conversion handles drives and backslashes', () => {
  assert.equal(adminSharePath('server1', 'D:\\AIpro\\site\\app.dll'), '\\\\server1\\D$\\AIpro\\site\\app.dll')
  assert.equal(adminSharePath('10.0.0.2', 'C:/temp/file.txt'), '\\\\10.0.0.2\\C$\\temp/file.txt')
})

test('admin share path rejects non-drive paths', () => {
  assert.throws(() => adminSharePath('server1', 'relative/path.txt'), /absolute remote path/)
  assert.throws(() => adminSharePath('server1', '\\\\other\\share\\file'), /absolute remote path/)
})
