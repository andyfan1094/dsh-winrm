import test from 'node:test'
import assert from 'node:assert/strict'
import { isIPv4Loopback, isLoopbackAddress, isLoopbackRequest } from '../src/loopback.ts'

test('loopback helpers accept the full 127/8 range and IPv4-mapped addresses', () => {
  assert.equal(isIPv4Loopback('127.0.0.1'), true)
  assert.equal(isIPv4Loopback('127.12.34.56'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('10.0.0.1'), false)
})

test('request fence rejects cross-site and non-loopback Host values', () => {
  const request = (host: string, site?: string) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host, ...(site ? { 'sec-fetch-site': site } : {}) } }) as any
  assert.equal(isLoopbackRequest(request('127.0.0.1:3080')), true)
  assert.equal(isLoopbackRequest(request('example.com:3080')), false)
  assert.equal(isLoopbackRequest(request('127.0.0.1:3080', 'cross-site')), false)
})