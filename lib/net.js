/**
 * Route-aware HTTP layer.
 *
 * Every request is a plain GET with an explicit proxy decision: direct
 * requests use the global fetch, proxied requests go through the
 * zero-dependency CONNECT tunnel client (see tunnel.js). The ambient
 * HTTP(S)_PROXY environment variables are deliberately NOT inherited by
 * global fetch, so routing stays under this plugin's control.
 * @module dsh-github-router/net
 */
import { tunnelRequest } from './tunnel.js'

/** Structured route failure with a stable machine code. */
export class RouteError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'RouteError'
    this.code = code // TRANSPORT | TIMEOUT | HTTP | PROXY_UNAVAILABLE | ABORTED
    if (options.status !== undefined) this.status = options.status
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** One combined signal: caller cancellation plus a cooperative deadline. */
export function makeAbort(signal, timeoutMs) {
  const controller = new AbortController()
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException(`request timed out after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs,
  )
  if (typeof timer.unref === 'function') timer.unref()
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) }
}

function classifyTransportError(error, signal) {
  if (signal !== undefined && signal !== null && signal.aborted) return new RouteError('ABORTED', 'aborted by caller', { cause: error })
  if (error && error.name === 'TimeoutError') return new RouteError('TIMEOUT', String(error.message || 'request timed out'), { cause: error })
  if (error && error.name === 'AbortError') return new RouteError('ABORTED', 'aborted by caller', { cause: error })
  return new RouteError('TRANSPORT', `request failed: ${String(error && error.message ? error.message : error)}`, { cause: error })
}
async function readBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || '0')
  if (declared > 0 && declared <= maxBytes) {
    const buf = Buffer.from(await response.arrayBuffer())
    return { data: buf, truncated: false }
  }
  const reader = response.body ? response.body.getReader() : null
  if (reader === null) return { data: Buffer.alloc(0), truncated: false }
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        chunks.push(Buffer.from(value).subarray(0, maxBytes - (total - value.byteLength)))
        await reader.cancel().catch(() => {})
        return { data: Buffer.concat(chunks), truncated: true }
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  return { data: Buffer.concat(chunks), truncated: false }
}

const KEPT_HEADERS = ['etag', 'last-modified', 'x-ratelimit-remaining', 'x-ratelimit-limit', 'x-ratelimit-reset']

/** Headers projection compatible with both fetch (Headers) and the tunnel (plain object). */
function pickHeaders(response) {
  const get = (name) => {
    if (response.headers === null || response.headers === undefined) return null
    if (typeof response.headers.get === 'function') return response.headers.get(name)
    return response.headers[name] ?? null
  }
  const out = {}
  for (const name of KEPT_HEADERS) {
    const value = get(name)
    if (value !== null && value !== undefined && value.length > 0) out[name] = value
  }
  const retryAfter = get('retry-after')
  if (typeof retryAfter === 'string' && retryAfter.length > 0) out['retry-after'] = retryAfter
  return out
}

/**
 * One GET attempt with an explicit proxy decision: direct requests go
 * through global fetch, proxied requests through the zero-dependency
 * CONNECT tunnel.
 * @returns { status, ok, body: Buffer, truncated, headers, url }
 * @throws {RouteError}
 */
export async function fetchOnce(url, options) {
  const {
    method = 'GET',
    headers = {},
    timeoutMs = 8000,
    proxy,
    signal,
    maxBytes = 1048576,
  } = options
  if (proxy !== undefined && proxy !== null && proxy !== '') {
    try {
      const result = await tunnelRequest(url, { method, headers, timeoutMs, proxy, signal, maxBytes })
      return {
        status: result.status,
        ok: result.ok,
        body: result.body,
        truncated: result.truncated,
        headers: pickHeaders(result),
        url: result.url,
      }
    } catch (error) {
      throw classifyTransportError(error, signal)
    }
  }

  const { signal: combined, cleanup } = makeAbort(signal, timeoutMs)
  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      redirect: 'follow',
      signal: combined,
    })
  } catch (error) {
    cleanup()
    throw classifyTransportError(error, signal)
  }
  try {
    const body = await readBody(response, maxBytes)
    cleanup()
    return {
      status: response.status,
      ok: response.ok,
      body: body.data,
      truncated: body.truncated,
      headers: pickHeaders(response),
      url: response.url,
    }
  } catch (error) {
    cleanup()
    throw classifyTransportError(error, signal)
  }
}

/** Retryable HTTP statuses for idempotent GETs. */
export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

/**
 * GET with bounded retries on 429/5xx (honoring Retry-After). Non-retryable
 * failures surface immediately so the router can fall through to the next
 * route instead of burning time.
 */
export async function fetchWithRetry(url, options) {
  const { retries = 0, onAttempt } = options
  let attempt = 0
  for (;;) {
    try {
      const result = await fetchOnce(url, options)
      if (onAttempt !== undefined) onAttempt('ok', result.status, attempt)
      if (result.ok || !isRetryableStatus(result.status) || attempt >= retries) return result
      const waitMs = retryDelayMs(result.headers['retry-after'], attempt)
      if (onAttempt !== undefined) onAttempt('retry', result.status, attempt)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      attempt += 1
    } catch (error) {
      if (error instanceof RouteError && (error.code === 'TIMEOUT' || error.code === 'TRANSPORT') && attempt < retries) {
        if (onAttempt !== undefined) onAttempt('retry', error.code, attempt)
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
        attempt += 1
      } else {
        throw error
      }
    }
  }
}

function retryDelayMs(retryAfter, attempt) {
  if (typeof retryAfter === 'string' && /^\d+$/.test(retryAfter)) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 120) return seconds * 1000
  }
  return Math.min(5000, 500 * 2 ** attempt)
}

/** Fetch and decode text; invalid UTF-8 is replaced, never throws. */
export async function fetchText(url, options) {
  const result = await fetchWithRetry(url, options)
  return { ...result, text: result.body.toString('utf8') }
}

/** Fetch and parse JSON; parse failures surface as a structured error. */
export async function fetchJson(url, options) {
  const result = await fetchWithRetry(url, options)
  let json
  try {
    json = JSON.parse(result.body.toString('utf8'))
  } catch (error) {
    throw new RouteError('TRANSPORT', `unprocessable JSON response from ${url}: ${String(error && error.message ? error.message : error)}`, { cause: error })
  }
  return { ...result, json }
}
