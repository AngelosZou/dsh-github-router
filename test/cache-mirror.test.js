import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { TtlCache } from '../lib/cache.js'
import { mirrorCandidates, rawUrl } from '../lib/routes/mirror.js'

describe('TtlCache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-github-router-test-'))
  const cache = new TtlCache(dir)

  it('round-trips values', () => {
    cache.set('https://example.com/a', { json: [1, 2] }, 60_000)
    const hit = cache.get('https://example.com/a', 60_000)
    assert.deepEqual(hit, { json: [1, 2] })
  })

  it('expires entries', () => {
    cache.set('https://example.com/b', { x: 1 }, 1000, Date.now() - 2000)
    assert.equal(cache.get('https://example.com/b', 1000), undefined)
  })

  it('treats corrupted files as misses', () => {
    const key = cache.keyFor('https://example.com/c')
    writeFileSync(join(dir, key + '.json'), '{{{not json', 'utf8')
    assert.equal(cache.get('https://example.com/c', 60_000), undefined)
  })

  it('distinguishes URLs by canonical string', () => {
    cache.set('https://example.com/a?ref=1', { v: 1 }, 60_000)
    cache.set('https://example.com/a?ref=2', { v: 2 }, 60_000)
    assert.deepEqual(cache.get('https://example.com/a?ref=1', 60_000), { v: 1 })
    assert.deepEqual(cache.get('https://example.com/a?ref=2', 60_000), { v: 2 })
  })
})

describe('mirrorCandidates', () => {
  it('builds raw and github /raw/ variants per mirror', () => {
    const urls = mirrorCandidates('o', 'r', 'main', 'a/b.txt', ['https://ghproxy.net', 'https://mirror.example.com/'])
    assert.deepEqual(urls, [
      'https://ghproxy.net/' + rawUrl('o', 'r', 'main', 'a/b.txt'),
      'https://ghproxy.net/https://github.com/o/r/raw/main/a/b.txt',
      'https://mirror.example.com/' + rawUrl('o', 'r', 'main', 'a/b.txt'),
      'https://mirror.example.com/https://github.com/o/r/raw/main/a/b.txt',
    ])
  })

  it('skips invalid mirror bases', () => {
    assert.deepEqual(mirrorCandidates('o', 'r', 'main', 'x', ['not-a-url']), [])
  })
})
