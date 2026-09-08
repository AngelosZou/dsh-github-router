import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildRequestHead, connectTarget, createChunkedDecoder, isChunked, parseResponseHead, proxyAuthHeader } from '../lib/tunnel.js'

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

describe('isChunked', () => {
  it('detects chunked transfer encoding', () => {
    assert.equal(isChunked({ 'transfer-encoding': 'chunked' }), true)
    assert.equal(isChunked({ 'transfer-encoding': 'gzip, chunked' }), true)
    assert.equal(isChunked({ 'transfer-encoding': 'identity' }), false)
    assert.equal(isChunked({}), false)
    assert.equal(isChunked(undefined), false)
  })
})

describe('createChunkedDecoder', () => {
  /** Feed `input` in the given slice sizes; returns the decoded result. */
  function decode(input, splits) {
    const out = []
    let done = false
    let error = null
    const decoder = createChunkedDecoder(
      (piece) => {
        out.push(piece)
        return false
      },
      () => {
        done = true
      },
      (e) => {
        error = e
      },
    )
    const sizes = splits ?? [input.length]
    let offset = 0
    for (const size of sizes) {
      if (offset >= input.length) break
      decoder.push(input.subarray(offset, offset + size))
      offset += size
    }
    if (offset < input.length) decoder.push(input.subarray(offset))
    if (!done && error === null) decoder.end()
    return { text: Buffer.concat(out).toString('utf8'), done, error }
  }

  it('strips framing from a single chunk and the terminating chunk', () => {
    const r = decode(Buffer.from('4\r\nWiki\r\n0\r\n\r\n'))
    assert.equal(r.text, 'Wiki')
    assert.equal(r.done, true)
    assert.equal(r.error, null)
  })

  it('decodes multiple chunks with extensions and trailers', () => {
    const body = '1a;ext=1\r\nabcdefghijklmnopqrstuvwxyz\r\n5\r\n12345\r\n0\r\nX-Trace: 1\r\n\r\n'
    const r = decode(Buffer.from(body))
    assert.equal(r.text, 'abcdefghijklmnopqrstuvwxyz12345')
    assert.equal(r.done, true)
    assert.equal(r.error, null)
  })

  it('survives arbitrary byte splits', () => {
    const body = '3\r\nfoo\r\n3\r\nbar\r\n0\r\n\r\n'
    const r = decode(Buffer.from(body), new Array(body.length).fill(1))
    assert.equal(r.text, 'foobar')
    assert.equal(r.done, true)
  })

  it('keeps a multi-byte payload intact across chunk boundaries', () => {
    const payload = 'x'.repeat(70000)
    const body = `${(35000).toString(16)}\r\n${payload.slice(0, 35000)}\r\n${(35000).toString(16)}\r\n${payload.slice(35000)}\r\n0\r\n\r\n`
    const r = decode(Buffer.from(body))
    assert.equal(r.text.length, 70000)
    assert.equal(r.text, payload)
  })

  it('reports an invalid chunk size', () => {
    const r = decode(Buffer.from('zz\r\nx\r\n0\r\n\r\n'))
    assert.equal(r.done, false)
    assert.match(String(r.error && r.error.message), /invalid chunk size/)
  })

  it('reports a truncated stream', () => {
    const r = decode(Buffer.from('5\r\nabc'))
    assert.match(String(r.error && r.error.message), /closed before the chunked body completed/)
  })

  it('stops feeding once the sink asks to stop', () => {
    const seen = []
    const decoder = createChunkedDecoder(
      (piece) => {
        seen.push(piece.length)
        return true
      },
      () => {},
      () => {},
    )
    decoder.push(Buffer.from('4\r\nWiki\r\n4\r\npedi\r\n0\r\n\r\n'))
    assert.deepEqual(seen, [4])
  })
})
