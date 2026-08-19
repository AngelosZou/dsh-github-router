/**
 * Per-call runtime assembly: cache, API client, transport binding, token
 * resolution, and the direct→proxy attempt ladder each route uses.
 * @module dsh-github-router/core/runtime
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TtlCache } from '../cache.js'
import { effectiveProxy } from '../config.js'
import { fetchWithRetry } from '../net.js'
import { GithubApi } from '../routes/api.js'

/**
 * Assemble the per-call runtime. Token resolution is memoized per tokenEnv
 * so one PR aggregation does not re-read the credentials service per
 * request.
 */
export function buildRuntime(ctx, options) {
  const cache = new TtlCache()
  const api = new GithubApi({
    retries: options.retries,
    directTimeoutMs: options.directTimeoutMs,
    proxyTimeoutMs: options.proxyTimeoutMs,
    maxBytes: options.maxBytes,
  })
  const fetchImpl = (url, o) => fetchWithRetry(url, o)
  const credentials = ctx.get('credentials')
  const tokenMemo = new Map()
  const resolveToken = () => {
    const literal = options.token
    if (literal !== undefined && literal.length > 0) return Promise.resolve(literal)
    const envName = options.tokenEnv
    const hit = tokenMemo.get(envName)
    if (hit !== undefined) return hit
    const promise = (async () => {
      if (credentials !== undefined && typeof credentials.resolve === 'function') {
        try {
          const resolved = await credentials.resolve(credentialRef(envName))
          if (resolved && typeof resolved.value === 'string' && resolved.value.length > 0) return resolved.value
        } catch { /* fall through to env */ }
      }
      const env = process.env[envName]
      return typeof env === 'string' && env.length > 0 ? env : undefined
    })()
    tokenMemo.set(envName, promise)
    return promise
  }
  return { cache, api, fetchImpl, resolveToken, subprocess: ctx.get('subprocess'), options }
}

/**
 * Run one route function across the direct/proxy ladder. The order flips
 * with `proxyFirst` (the page-HTML route empirically needs the proxy first
 * on machines where direct TLS is reset). Aborts propagate; every other
 * failure is collected so the next attempt can run.
 */
export async function attemptLadder(fn, options, spec = {}) {
  const proxy = effectiveProxy(options)
  const proxyFirst = spec.proxyFirst === true
  const attempts = []
  if (proxyFirst) {
    if (proxy !== undefined) attempts.push(['proxy', proxy])
    attempts.push(['direct', undefined])
  } else {
    attempts.push(['direct', undefined])
    if (proxy !== undefined) attempts.push(['proxy', proxy])
  }
  const errors = []
  for (const [label, proxyUrl] of attempts) {
    try {
      return { value: await fn(proxyUrl), via: label }
    } catch (error) {
      if (error && error.code === 'ABORTED') throw error
      errors.push(`${label}: ${String(error && error.code ? error.code + ' — ' : '')}${String(error && error.message ? error.message : error)}`)
    }
  }
  const err = new Error(errors.join(' | ').slice(0, 600))
  err.code = 'ROUTE_FAILED'
  err.attempts = errors
  throw err
}

/** Surface the remaining-rate-limit note without exposing anything secret. */
export function rateNote(headers, notes) {
  if (headers && typeof headers === 'object' && typeof headers['x-ratelimit-remaining'] === 'string') {
    const remaining = headers['x-ratelimit-remaining']
    const limit = headers['x-ratelimit-limit']
    notes.push(`api rate limit: ${remaining}${limit !== undefined ? '/' + limit : ''} requests remaining`)
  }
}
