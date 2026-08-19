/**
 * Tiny TTL JSON cache in the host-owned storage dir. Writes are atomic
 * (tmp + rename), reads tolerate corruption and expiry by discarding the
 * entry. Concurrent writes commute: last writer wins, and a torn file is
 * simply treated as a miss.
 * @module dsh-github-router/cache
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE_DIR, sha1 } from './util.js'

export class TtlCache {
  constructor(dir = CACHE_DIR) {
    this.dir = dir
    this.mem = new Map()
  }

  keyFor(url) {
    return sha1(String(url))
  }

  fileFor(key) {
    return join(this.dir, key + '.json')
  }

  /** Return a cached value when present and unexpired; expired/corrupt entries are dropped. */
  get(url, ttlMs, now = Date.now()) {
    if (!(ttlMs > 0)) return undefined
    const key = this.keyFor(url)
    const hit = this.mem.get(key)
    if (hit !== undefined) {
      if (hit.expiresAt > now) return hit.value
      this.mem.delete(key)
    }
    const file = this.fileFor(key)
    if (!existsSync(file)) return undefined
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8'))
      if (entry === null || typeof entry !== 'object' || !Number.isFinite(entry.ts) || entry.v !== 1) {
        this.drop(key)
        return undefined
      }
      if (entry.ts + (Number.isFinite(entry.ttlMs) ? entry.ttlMs : 0) <= now) {
        this.drop(key)
        return undefined
      }
      this.mem.set(key, { value: entry.value, expiresAt: entry.ts + entry.ttlMs })
      return entry.value
    } catch {
      this.drop(key)
      return undefined
    }
  }

  set(url, value, ttlMs, now = Date.now()) {
    if (!(ttlMs > 0)) return
    const key = this.keyFor(url)
    this.mem.set(key, { value, expiresAt: now + ttlMs })
    const file = this.fileFor(key)
    const tmp = file + '.tmp'
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(tmp, JSON.stringify({ v: 1, ts: now, ttlMs, value }), 'utf8')
      renameSync(tmp, file)
    } catch {
      try { unlinkSync(tmp) } catch { /* best effort */ }
    }
  }

  drop(url) {
    const key = this.keyFor(url)
    this.mem.delete(key)
    try { unlinkSync(this.fileFor(key)) } catch { /* already gone */ }
  }
}

/**
 * Cached-JSON helper shared by the core aggregators: a cache hit skips the
 * network entirely; a successful fetch is stored with its per-kind TTL.
 */
export async function cachedJson(cache, url, ttlMs, forceRefresh, fetcher) {
  if (!forceRefresh) {
    const hit = cache.get(url, ttlMs)
    if (hit !== undefined) return { ...hit, cached: true }
  }
  const fresh = await fetcher()
  if (fresh.ok && fresh.json !== undefined) {
    cache.set(url, { json: fresh.json, headers: fresh.headers, status: fresh.status }, ttlMs)
  }
  return { ...fresh, cached: false }
}
