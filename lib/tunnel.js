/**
 * Zero-dependency proxy transport: HTTPS through an HTTP CONNECT tunnel
 * (plus plain HTTP via absolute-URI proxying), built on node:http/tls.
 *
 * Why not global fetch + undici ProxyAgent: this plugin must install
 * OFFLINE on machines whose package registry access is exactly what is
 * broken. The tunnel client is small, carries its own cooperative timeout
 * and caller abort, enforces the byte cap, and sends
 * `accept-encoding: identity` so responses never need decompression.
 * @module dsh-github-router/tunnel
 */
import http from 'node:http'
import tls from 'node:tls'

const MAX_REDIRECTS = 3

/** Basic auth header value for a proxy URL carrying credentials, else null. */
export function proxyAuthHeader(proxyUrl) {
  if (proxyUrl.username === '' && proxyUrl.password === '') return null
  const user = decodeURIComponent(proxyUrl.username)
  const pass = decodeURIComponent(proxyUrl.password)
  if (user === '' && pass === '') return null
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')
}

/** The CONNECT authority line for a target URL. */
export function connectTarget(target) {
  return `${target.hostname}:${target.port !== '' && target.port !== null ? target.port : 443}`
}

/** Build the request-line + headers block written onto the tunnel socket. */
export function buildRequestHead(target, method, headers) {
  const path = target.pathname + target.search
  const lines = [`${method} ${path} HTTP/1.1`, `host: ${target.host}`]
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue
    lines.push(`${key}: ${value}`)
  }
  lines.push('accept-encoding: identity', 'connection: close', '', '')
  return lines.join('\r\n')
}

/** Parse an HTTP response head into { status, headers }. */
export function parseResponseHead(headText) {
  const lines = String(headText).split('\r\n')
  const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(lines[0] ?? '')
  if (match === null) throw new Error(`bad HTTP status line: ${(lines[0] ?? '').slice(0, 60)}`)
  const headers = {}
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return { status: Number(match[1]), headers }
}

function openTunnel(target, proxyUrl, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const auth = proxyAuthHeader(proxyUrl)
    const request = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port !== '' ? Number(proxyUrl.port) : 80,
      method: 'CONNECT',
      path: connectTarget(target),
      headers: {
        host: connectTarget(target),
        ...(auth !== null ? { 'proxy-authorization': auth } : {}),
      },
    })
    const onAbort = () => request.destroy(new DOMException('aborted', 'AbortError'))
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => request.destroy(new DOMException('timed out', 'TimeoutError')), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    request.on('connect', (response, socket) => {
      clearTimeout(timer)
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy CONNECT failed: HTTP ${response.statusCode}`))
        return
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
        if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
        resolve(tlsSocket)
      })
      tlsSocket.on('error', reject)
    })
    request.on('error', (error) => {
      clearTimeout(timer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    request.end()
  })
}

function readResponse(socket, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let headerBuf = Buffer.alloc(0)
    let headerDone = false
    let settled = false
    let status = 0
    let headers = {}
    let truncated = false
    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error !== undefined) reject(error)
      else resolve({ status, ok: status >= 200 && status < 300, body: Buffer.concat(chunks), truncated, headers })
    }
    const onBody = (buf) => {
      total += buf.length
      if (total > maxBytes) {
        const keep = maxBytes - (total - buf.length)
        if (keep > 0) chunks.push(buf.subarray(0, keep))
        truncated = true
        finish()
        return
      }
      chunks.push(buf)
    }
    socket.on('data', (buf) => {
      if (!headerDone) {
        headerBuf = Buffer.concat([headerBuf, buf])
        const idx = headerBuf.indexOf('\r\n\r\n')
        if (idx === -1) {
          if (headerBuf.length > 65536) finish(new Error('response headers too large'))
          return
        }
        try {
          const head = parseResponseHead(headerBuf.subarray(0, idx).toString('latin1'))
          status = head.status
          headers = head.headers
        } catch (error) {
          finish(error)
          return
        }
        headerDone = true
        const rest = headerBuf.subarray(idx + 4)
        if (rest.length > 0) onBody(rest)
        return
      }
      onBody(buf)
    })
    socket.on('end', () => {
      if (headerDone) finish()
      else finish(new Error('connection closed before response headers'))
    })
    socket.on('error', (error) => finish(error))
  })
}

/**
 * One proxied request: CONNECT tunnel for https targets, absolute-URI for
 * http targets. Returns the same shape as the direct fetch path.
 */
export async function tunnelRequest(targetUrl, options) {
  const { method = 'GET', headers = {}, timeoutMs = 15000, proxy, signal, maxBytes = 1048576 } = options
  let target = new URL(targetUrl)
  let proxyUrl
  try {
    proxyUrl = new URL(String(proxy))
  } catch {
    // Never echo credentials: display only scheme://host:port.
    const display = String(proxy).replace(/\/\/([^/@]+)@/, '//')
    throw new Error(`invalid proxy URL: ${display.slice(0, 120)}`)
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (signal !== undefined && signal !== null && signal.aborted) throw new DOMException('aborted', 'AbortError')

    let socket
    if (target.protocol === 'https:') {
      socket = await openTunnel(target, proxyUrl, timeoutMs, signal)
    } else if (target.protocol === 'http:') {
      const auth = proxyAuthHeader(proxyUrl)
      socket = await new Promise((resolve, reject) => {
        const request = http.request({
          host: proxyUrl.hostname,
          port: proxyUrl.port !== '' ? Number(proxyUrl.port) : 80,
          method,
          path: target.toString(),
          headers: {
            host: target.host,
            ...(auth !== null ? { 'proxy-authorization': auth } : {}),
            ...headers,
          },
        })
        const onAbort = () => request.destroy(new DOMException('aborted', 'AbortError'))
        if (signal !== undefined && signal !== null) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
        const timer = setTimeout(() => request.destroy(new DOMException('timed out', 'TimeoutError')), timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
        request.on('response', (response) => {
          clearTimeout(timer)
          if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
          resolve({ stream: response, status: response.statusCode ?? 0, headers: response.headers })
        })
        request.on('error', (error) => {
          clearTimeout(timer)
          if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
          reject(error)
        })
        request.end()
      }).then(({ stream, status, headers }) => {
        // Collect the http-over-proxy body (rarely used by this plugin).
        return new Promise((resolve, reject) => {
          const chunks = []
          let total = 0
          let truncated = false
          stream.on('data', (buf) => {
            total += buf.length
            if (total > maxBytes) {
              const keep = maxBytes - (total - buf.length)
              if (keep > 0) chunks.push(buf.subarray(0, keep))
              truncated = true
              stream.destroy()
            } else chunks.push(buf)
          })
          stream.on('end', () => resolve({ status, ok: status >= 200 && status < 300, body: Buffer.concat(chunks), truncated, headers }))
          stream.on('error', reject)
        })
      })
      return socket
    } else {
      throw new Error(`unsupported target protocol: ${target.protocol}`)
    }

    if (target.protocol === 'https:') {
      socket.write(buildRequestHead(target, method, headers))
      const response = await readResponse(socket, maxBytes)
      const location = response.headers.location
      if (location !== undefined && [301, 302, 303, 307, 308].includes(response.status) && hop < MAX_REDIRECTS) {
        target = new URL(location, target)
        continue
      }
      return { status: response.status, ok: response.ok, body: response.body, truncated: response.truncated, headers: response.headers, url: target.toString() }
    }
  }
  throw new Error(`too many redirects (${MAX_REDIRECTS})`)
}
