import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { effectiveProxy, resolveOptions } from '../lib/config.js'
import { parseCommitLog } from '../lib/routes/git.js'
import { isRetryableStatus, RouteError } from '../lib/net.js'

describe('resolveOptions', () => {
  it('defaults everything safely', () => {
    const o = resolveOptions({})
    assert.equal(o.tokenEnv, 'GITHUB_TOKEN')
    assert.equal(o.retries, 1)
    assert.equal(o.maxBytes, 1048576)
    assert.deepEqual(o.routes, { api: true, gh: true, git: true, html: true, mirror: false })
    assert.deepEqual(o.mirrors, [])
    assert.equal(o.token, undefined)
  })

  it('respects explicit settings', () => {
    const o = resolveOptions({
      token: 'x',
      proxy: 'http://proxy.example.com:3128',
      routesMirror: true,
      routesApi: false,
      mirrors: ['https://ghproxy.net'],
      cacheTtlMeta: 60,
    })
    assert.equal(o.token, 'x')
    assert.equal(o.proxy, 'http://proxy.example.com:3128')
    assert.equal(o.routes.mirror, true)
    assert.equal(o.routes.api, false)
    assert.deepEqual(o.mirrors, ['https://ghproxy.net'])
    assert.equal(o.cacheTtlSeconds.meta, 60)
  })

  it('projects the flat schema into the nested runtime shape', () => {
    const o = resolveOptions({ routesGit: false, cacheTtlContent: 123, maxBytes: 20000 })
    assert.equal(o.routes.git, false)
    assert.equal(o.routes.api, true)
    assert.equal(o.cacheTtlSeconds.content, 123)
    assert.equal(o.maxBytes, 20000)
  })
})

describe('effectiveProxy', () => {
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY }
  const cleanup = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  it('honors the explicit override', () => {
    assert.equal(effectiveProxy({ proxy: 'http://p:1' }), 'http://p:1')
  })
  it("'direct' disables proxying", () => {
    assert.equal(effectiveProxy({ proxy: 'direct' }), undefined)
  })
  it('falls back to ambient env when unset', () => {
    process.env.HTTPS_PROXY = 'http://ambient:7890'
    try {
      assert.equal(effectiveProxy({ proxy: '' }), 'http://ambient:7890')
    } finally {
      cleanup()
    }
  })
})

describe('parseCommitLog', () => {
  it('parses the delimiter-separated log', () => {
    const log = 'abc123\x1fAlice\x1falice@example.com\x1f2026-01-01T00:00:00Z\x1fFix things\x1fLong body\nline2\x1e'
    const commits = parseCommitLog(log)
    assert.equal(commits.length, 1)
    assert.equal(commits[0].sha, 'abc123')
    assert.equal(commits[0].author, 'Alice')
    assert.equal(commits[0].message, 'Fix things\x1fLong body\nline2')
  })
  it('skips junk entries', () => {
    assert.deepEqual(parseCommitLog('junk\nmore junk'), [])
    assert.deepEqual(parseCommitLog(''), [])
  })
})

describe('net helpers', () => {
  it('classifies retryable statuses', () => {
    assert.equal(isRetryableStatus(429), true)
    assert.equal(isRetryableStatus(500), true)
    assert.equal(isRetryableStatus(502), true)
    assert.equal(isRetryableStatus(404), false)
    assert.equal(isRetryableStatus(403), false)
  })
  it('RouteError carries stable codes', () => {
    const e = new RouteError('TIMEOUT', 'slow', { status: 408 })
    assert.equal(e.code, 'TIMEOUT')
    assert.equal(e.status, 408)
    assert.equal(e.name, 'RouteError')
  })
})
