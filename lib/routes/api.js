/**
 * api.github.com REST client — GET-only by construction. There is no method
 * field, no body, and no verb other than GET anywhere in this module. The
 * token is attached only to api.github.com requests and is never logged.
 * @module dsh-github-router/routes/api
 */
import { RouteError } from '../net.js'

export const API_BASE = 'https://api.github.com'
export const USER_AGENT = 'dsh-github-router/0.1.0'
const ACCEPT = 'application/vnd.github+json'
const API_VERSION = '2022-11-28'

/** Classify a non-2xx api.github.com response into a stable failure code. */
export function apiErrorCode(status, headers) {
  if (status === 401) return 'AUTH_REQUIRED'
  if (status === 404) return 'NOT_FOUND'
  if (status === 403 && headers !== undefined && headers['x-ratelimit-remaining'] === '0') return 'RATE_LIMITED'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'HTTP'
  return 'HTTP'
}

/** Build one api.github.com URL from a validated path and query values. */
export function apiUrl(path, query) {
  const url = new URL(API_BASE + path)
  if (query !== undefined && query !== null) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      const v = String(value)
      if (/[\u0000-\u001f\u007f]/.test(v) || v.length > 1024) continue
      url.searchParams.set(key, v)
    }
  }
  return url.toString()
}

/**
 * A GitHub API client bound to the router's transport and options.
 * Token resolution happens per call so settings changes apply immediately.
 */
export class GithubApi {
  constructor(options) {
    this.options = options // { retries, directTimeoutMs, proxyTimeoutMs, maxBytes }
  }

  headers(token) {
    const headers = {
      accept: ACCEPT,
      'user-agent': USER_AGENT,
      'x-github-api-version': API_VERSION,
    }
    if (token !== undefined && token !== null && token !== '') {
      headers.authorization = `Bearer ${token}`
    }
    return headers
  }

  /**
   * GET a JSON endpoint with cache and retry handling.
   * @param path - validated api.github.com relative path
   * @param call - { query, token, signal, proxy, timeoutMs, cache, ttlMs, forceRefresh }
   */
  async getJson(path, call = {}) {
    const url = apiUrl(path, call.query)
    const { cache, ttlMs, forceRefresh } = call
    const fetcher = async () => {
      const raw = await call.fetchImpl(url, {
        headers: this.headers(call.token),
        timeoutMs: call.timeoutMs !== undefined ? call.timeoutMs : call.proxy !== undefined ? this.options.proxyTimeoutMs : this.options.directTimeoutMs,
        proxy: call.proxy,
        signal: call.signal,
        maxBytes: this.options.maxBytes,
        retries: this.options.retries,
      })
      if (raw.ok) {
        let json
        try {
          json = JSON.parse(raw.body.toString('utf8'))
        } catch (error) {
          throw new RouteError('TRANSPORT', `unprocessable JSON from ${url}: ${String(error && error.message ? error.message : error)}`, { cause: error })
        }
        return { ok: true, status: raw.status, json, headers: raw.headers, truncated: raw.truncated }
      }
      const code = apiErrorCode(raw.status, raw.headers)
      let detail = `GitHub API error (HTTP ${raw.status})`
      try {
        const parsed = JSON.parse(raw.body.toString('utf8'))
        const message = parsed && (parsed.message || (parsed.error && parsed.error.message))
        if (typeof message === 'string' && message.length > 0) detail = message
      } catch { /* keep generic detail */ }
      throw new RouteError(code, detail, { status: raw.status })
    }

    const withMeta = (value, hit) => {
      const out = Array.isArray(value) ? [...value] : { ...value }
      // Arrays serialize indices only — enumerable side props would violate
      // the lossless-JSON tool contract, so they are attached only to
      // object endpoints (where rate-limit notes actually read them).
      if (!Array.isArray(value)) {
        Object.defineProperties(out, {
          _headers: { value: hit.headers, enumerable: true },
          _status: { value: hit.status, enumerable: true },
          cached: { value: true, enumerable: true },
        })
      }
      return out
    }
    if (cache !== undefined && ttlMs > 0 && !forceRefresh) {
      const hit = cache.get(url, ttlMs)
      if (hit !== undefined) return withMeta(hit.json, hit)
    }
    const fresh = await fetcher()
    if (cache !== undefined && ttlMs > 0 && fresh.ok) {
      cache.set(url, { json: fresh.json, headers: fresh.headers, status: fresh.status }, ttlMs)
    }
    return withMeta(fresh.json, fresh)
  }

  /**
   * GET a text/diff endpoint (Accept overridden). Used for PR diffs.
   */
  async getText(path, accept, call = {}) {
    const url = apiUrl(path, call.query)
    const raw = await call.fetchImpl(url, {
      headers: { ...this.headers(call.token), accept },
      timeoutMs: call.timeoutMs !== undefined ? call.timeoutMs : call.proxy !== undefined ? this.options.proxyTimeoutMs : this.options.directTimeoutMs,
      proxy: call.proxy,
      signal: call.signal,
      maxBytes: this.options.maxBytes,
      retries: this.options.retries,
    })
    if (raw.ok) return { ok: true, status: raw.status, text: raw.body.toString('utf8'), truncated: raw.truncated, headers: raw.headers }
    throw new RouteError(apiErrorCode(raw.status, raw.headers), `GitHub API error (HTTP ${raw.status})`, { status: raw.status })
  }
}
