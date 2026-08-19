/**
 * Host-side configuration routes for the browser settings page.
 *
 * The channel is the dshmarket pattern: the plugin mounts its own HTTP
 * routes on the shared web server (`ctx.webServer.register`, prefix
 * `/dsh-github-router`) and the browser page talks to them with plain
 * same-origin fetch — no typert, no gateway, no framework allowlist. The
 * routes are backed by the SAME official settings seam: the namespace
 * stays durable in the settings document, with schema validation,
 * revision fencing, and secret redaction.
 *
 * Mutating requests are POST-only, same-origin-checked (Origin === Host)
 * and body-capped, mirroring dsh-market's route security posture.
 * @module dsh-github-router/remote
 */
import { Config, NAMESPACE, resolveOptions } from './config.js'

const ROUTE_PREFIX = '/dsh-github-router'
const MAX_BODY_BYTES = 16384

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** Same-origin enforcement for mutating routes (dsh-market posture). */
function sameOrigin(request) {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read and parse a JSON request body with a hard byte cap. */
async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Install the settings-namespace registration, the options thunk, and the
 * `/dsh-github-router/config` routes in one wiring. Returns the
 * runtime-options thunk the tools consume.
 */
export function installRemote(ctx, config) {
  const holder = { scope: null, settings: null }

  ctx.inject(['settings'], (sctx) => {
    holder.settings = sctx.settings
    holder.scope = sctx.settings.register(NAMESPACE, Config, { base: config })
    sctx.effect(() => () => {
      holder.scope = null
      holder.settings = null
    }, 'dsh-github-router: settings scope teardown')
  })

  /** Redacted wire view of this namespace (value/base/user/revision/writable). */
  function viewOf() {
    if (holder.scope === null || holder.settings === null) return null
    const descriptors = holder.settings.describe({ redactSecrets: true })
    const descriptor = descriptors.find((d) => String(d.ns) === NAMESPACE)
    if (descriptor === undefined) return null
    return {
      value: descriptor.value ?? {},
      base: descriptor.base ?? {},
      user: descriptor.user ?? {},
      revision: descriptor.revision,
      writable: holder.settings.writable === true,
    }
  }

  function validateOps(payload) {
    if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.ops) || payload.ops.length === 0) {
      return 'payload.ops must be a non-empty array'
    }
    if (payload.ops.length > 40) return 'too many ops in one write'
    for (const op of payload.ops) {
      if (op === null || typeof op !== 'object' || (op.op !== 'set' && op.op !== 'unset')) {
        return 'each op must be { op: "set" | "unset", path: [field] }'
      }
      if (!Array.isArray(op.path) || op.path.length !== 1 || typeof op.path[0] !== 'string' || op.path[0].length === 0 || op.path[0].length > 64) {
        return 'op.path must be a single field name'
      }
      if (op.op === 'set' && op.value === undefined) return 'set ops require a value'
    }
    return null
  }

  const routeHandler = async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname
    if (pathname !== ROUTE_PREFIX + '/config') {
      sendJson(response, 404, { ok: false, error: 'unknown dsh-github-router route' })
      return
    }
    if (request.method === 'GET') {
      if (holder.scope === null || holder.settings === null) {
        sendJson(response, 503, { ok: false, error: 'the settings service is not mounted in this deployment' })
        return
      }
      const view = viewOf()
      if (view === null) {
        sendJson(response, 503, { ok: false, error: 'settings namespace is not registered' })
        return
      }
      sendJson(response, 200, { ok: true, value: view })
      return
    }
    if (request.method === 'POST') {
      if (!sameOrigin(request)) {
        sendJson(response, 403, { ok: false, error: 'configuration writes are limited to same-origin requests' })
        return
      }
      if (holder.scope === null || holder.settings === null) {
        sendJson(response, 503, { ok: false, error: 'the settings service is not mounted in this deployment' })
        return
      }
      let payload
      try {
        payload = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `unreadable request body: ${String(error && error.message ? error.message : error)}` })
        return
      }
      const invalid = validateOps(payload)
      if (invalid !== null) {
        sendJson(response, 400, { ok: false, error: invalid })
        return
      }
      const expectedRevision = Number.isInteger(payload.expectedRevision) ? payload.expectedRevision : undefined
      try {
        await holder.scope.mutate(payload.ops, expectedRevision)
      } catch (error) {
        sendJson(response, 409, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      const view = viewOf()
      if (view === null) {
        sendJson(response, 503, { ok: false, error: 'settings namespace disappeared after the write' })
        return
      }
      sendJson(response, 200, { ok: true, value: view })
      return
    }
    response.writeHead(405, { allow: 'GET, POST' })
    response.end()
  }

  ctx.inject(['webServer'], (hctx) => {
    hctx.effect(() => hctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: routeHandler }), 'dsh-github-router: settings routes')
  })

  return {
    options: () => (holder.scope !== null ? resolveOptions(holder.scope.get()) : resolveOptions(config)),
  }
}
