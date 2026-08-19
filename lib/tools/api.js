/**
 * `github_api` — the escape hatch: a validated GET-only pass-through to
 * api.github.com with caching and rate-limit surfacing. There is no other
 * verb; paths are strictly validated; query values are sanitized.
 * @module dsh-github-router/tools/api
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { attemptLadder, buildRuntime } from '../core/runtime.js'
import { renderApi } from '../render.js'
import { guardApiPath } from '../util.js'

const QUERY_VALUE_RE = /^[\u0020-\u007e\u00a0-\uffff]*$/

function sanitizeQuery(query) {
  if (query === undefined || query === null) return undefined
  if (typeof query !== 'object' || Array.isArray(query)) throw new Error('query must be an object of string/number/boolean values')
  const out = {}
  const keys = Object.keys(query)
  if (keys.length > 20) throw new Error('query must have at most 20 entries')
  for (const key of keys) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) throw new Error(`invalid query key "${key}"`)
    const value = query[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.length <= 1024 && QUERY_VALUE_RE.test(value)) {
      out[key] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    } else if (typeof value === 'boolean') {
      out[key] = value ? 'true' : 'false'
    } else {
      throw new Error(`query value for "${key}" must be a short string, finite number, or boolean`)
    }
  }
  return out
}

export function registerApiTool(ctx, options) {
  ctx.tools.register(
    defineTool({
      name: 'github_api',
      description:
        'READ-ONLY escape hatch for any api.github.com GET endpoint not covered by the specialized tools. Path must be a plain relative API path (e.g. "/repos/octocat/Hello-World/commits"); the method is always GET — no write, mutation, or body exists. Query values are sanitized; responses are cached briefly, rate-limit headers are surfaced, and errors carry a stable code. Prefer github_pr / github_issue / github_file for common reads.',
      parameters: {
        path: { type: 'string', description: 'api.github.com relative path starting with "/", e.g. "/repos/{owner}/{repo}/commits?per_page=5" — pass paging via the query parameter instead.' },
        query: { type: 'object', additionalProperties: true, description: 'Optional query parameters as an object, e.g. {"per_page": 30, "sha": "main"} (max 20 entries; string/number/boolean values).' },
        forceRefresh: { type: 'boolean', description: 'Bypass the plugin cache and re-fetch (default false).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => renderApi(value),
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          const path = guardApiPath(args && args.path)
          const query = sanitizeQuery(args && args.query)
          const runtime = buildRuntime(ctx, options())
          const token = await runtime.resolveToken()
          const attempt = await attemptLadder(
            (proxy) =>
              runtime.api.getJson(path, {
                token,
                signal: exec && exec.signal,
                proxy,
                cache: runtime.cache,
                ttlMs: options().cacheTtlSeconds.meta,
                forceRefresh: args && args.forceRefresh === true,
                fetchImpl: runtime.fetchImpl,
                query,
              }),
            options(),
          )
          const value = attempt.value
          const { _headers, _status, cached: _cached, ...rest } = Array.isArray(value) ? {} : value
          const clean = Array.isArray(value) ? [...value] : rest
          const out = {
            path,
            status: _status ?? 200,
            rateLimit: _headers && _headers['x-ratelimit-remaining'] !== undefined ? String(_headers['x-ratelimit-remaining']) : null,
            json: clean !== undefined && typeof clean === 'object' ? clean : null,
            text: typeof clean === 'string' ? clean : null,
            truncated: false,
            via: attempt.via,
          }
          // Lossless-JSON guarantee: the tool contract rejects undefined
          // values; the round-trip strips any that slip through.
          return JSON.parse(JSON.stringify(out))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const code = error && error.code ? error.code : 'ERROR'
          return { error: `${code}: ${message}`, path: args && args.path ? String(args.path) : undefined }
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'github_api' + (args && args.path ? ' ' + args.path : ''),
      }),
    }),
  )
}
