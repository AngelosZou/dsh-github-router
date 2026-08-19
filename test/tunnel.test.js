import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildRequestHead, connectTarget, parseResponseHead, proxyAuthHeader } from '../lib/tunnel.js'

describe('buildRequestHead', () => {
  it('emits a valid HTTP/1.1 head with identity encoding and close', () => {
    const head = buildRequestHead(new URL('https://api.github.com/repos/o/r/pulls/1?per_page=5'), 'GET', {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer x',
    })
    const lines = head.split('\r\n')
    assert.equal(lines[0], 'GET /repos/o/r/pulls/1?per_page=5 HTTP/1.1')
    assert.ok(lines.includes('host: api.github.com'))
    assert.ok(lines.includes('accept: application/vnd.github+json'))
    assert.ok(lines.includes('authorization: Bearer x'))
    assert.ok(lines.includes('accept-encoding: identity'))
    assert.ok(lines.includes('connection: close'))
    assert.equal(lines.at(-2), '')
    assert.equal(lines.at(-1), '')
  })

  it('skips undefined header values', () => {
    const head = buildRequestHead(new URL('https://x.example/'), 'GET', { gone: undefined, keep: 'v' })
    assert.ok(head.includes('keep: v'))
    assert.ok(!head.includes('gone'))
  })
})

describe('connectTarget', () => {
  it('uses the default 443 port for https', () => {
    assert.equal(connectTarget(new URL('https://github.com/x')), 'github.com:443')
    assert.equal(connectTarget(new URL('https://github.com:8443/x')), 'github.com:8443')
  })
})

describe('parseResponseHead', () => {
  it('parses status and lowercased headers', () => {
    const head = parseResponseHead('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-RateLimit-Remaining: 12\r\n\r\n')
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-type'], 'application/json')
    assert.equal(head.headers['x-ratelimit-remaining'], '12')
  })
  it('rejects garbage status lines', () => {
    assert.throws(() => parseResponseHead('nonsense\r\n\r\n'))
  })
})

describe('proxyAuthHeader', () => {
  it('builds basic auth from URL credentials', () => {
    const header = proxyAuthHeader(new URL('http://user:p%40ss@proxy.example.com:3128'))
    assert.equal(header, 'Basic ' + Buffer.from('user:p@ss', 'utf8').toString('base64'))
  })
  it('returns null without credentials', () => {
    assert.equal(proxyAuthHeader(new URL('http://proxy.example.com:3128')), null)
  })
})
