/**
 * Settings schema and runtime-option resolution for dsh-github-router.
 *
 * The settings section (`dsh-github-router` namespace) is registered through
 * `installSettingsSection`; the Settings UI renders a plugin card for it.
 * Secrets are declared with `.role('secret')` so they are redacted on every
 * wire boundary and rendered as write-only inputs.
 *
 * The schema is deliberately FLAT: the client settings scope writes scalar
 * fields by name (`scope.set(field, value)`), so nested objects cannot be
 * edited from the card. `resolveOptions` projects the flat section into the
 * nested runtime shape the core aggregators use.
 * @module dsh-github-router/config
 */
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace carrying the plugin's configuration. */
export const NAMESPACE = settingsNamespace('dsh-github-router')

/** Composition/settings schema. All fields optional with safe defaults. */
export const Config = z.object({
  /** Literal GitHub token (redacted on wire). Prefer tokenEnv. */
  token: z.string().role('secret'),
  /** Environment variable / credential ref naming the token. */
  tokenEnv: z.string().role('credential-ref').default('GITHUB_TOKEN'),
  /** Proxy URL for proxy routes. '' = inherit ambient proxy env; 'direct' = never proxy. */
  proxy: z.string().default(''),
  directTimeoutMs: z.number().min(1000).max(60000).default(8000),
  proxyTimeoutMs: z.number().min(1000).max(60000).default(15000),
  /** Retries for idempotent GETs on 429/5xx. */
  retries: z.number().min(0).max(3).default(1),
  routesApi: z.boolean().default(true),
  routesGh: z.boolean().default(true),
  routesGit: z.boolean().default(true),
  routesHtml: z.boolean().default(true),
  /** Raw-content mirrors: OFF by default — the user must opt in. */
  routesMirror: z.boolean().default(false),
  /** Raw-content mirror base URLs, e.g. ["https://ghproxy.net"]. Empty = none. */
  mirrors: z.array(z.string()).default([]),
  /** PR/issue metadata cache TTL. */
  cacheTtlMeta: z.number().min(0).default(300),
  /** Immutable-ish content (files, commits, diffs at a sha) cache TTL. */
  cacheTtlContent: z.number().min(0).default(86400),
  /** Cap for every response body read by this plugin, in bytes. */
  maxBytes: z.number().min(16384).max(8388608).default(1048576),
  /** Local repo paths granted for read-only git-route reads (log/diff/show only). */
  repos: z.array(z.string()).default([]),
  /** Plugin-owned git fetch cache dir. '' = <DSH_HOME>/storages/dsh-github-router/git. */
  gitCacheDir: z.string().default(''),
})

const PROXY_ENV_NAMES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

/**
 * Resolve one settings/composition section into fully-defaulted runtime
 * options. A thunk-producing source is consumed at call time so a settings
 * change applies to the NEXT tool call.
 * @param section - the resolved settings section (already schema-defaulted).
 */
export function resolveOptions(section) {
  const s = section ?? {}
  const proxy =
    typeof s.proxy === 'string' && s.proxy.trim().length > 0
      ? s.proxy.trim()
      : undefined
  const routes = {
    api: s.routesApi !== false,
    gh: s.routesGh !== false,
    git: s.routesGit !== false,
    html: s.routesHtml !== false,
    mirror: s.routesMirror === true,
  }
  const mirrors = Array.isArray(s.mirrors)
    ? s.mirrors.filter((m) => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim())
    : []
  const repos = Array.isArray(s.repos)
    ? s.repos.filter((r) => typeof r === 'string' && r.trim().length > 0).map((r) => r.trim())
    : []
  return {
    token: typeof s.token === 'string' && s.token.length > 0 ? s.token : undefined,
    tokenEnv: typeof s.tokenEnv === 'string' && s.tokenEnv.length > 0 ? s.tokenEnv : 'GITHUB_TOKEN',
    proxy, // undefined = ambient env decides; 'direct' = never proxy
    directTimeoutMs: Number.isFinite(s.directTimeoutMs) ? s.directTimeoutMs : 8000,
    proxyTimeoutMs: Number.isFinite(s.proxyTimeoutMs) ? s.proxyTimeoutMs : 15000,
    retries: Number.isFinite(s.retries) ? Math.min(3, Math.max(0, s.retries)) : 1,
    routes,
    mirrors,
    cacheTtlSeconds: {
      meta: Number.isFinite(s.cacheTtlMeta) ? s.cacheTtlMeta : 300,
      content: Number.isFinite(s.cacheTtlContent) ? s.cacheTtlContent : 86400,
    },
    maxBytes: Number.isFinite(s.maxBytes) ? Math.min(8388608, Math.max(16384, s.maxBytes)) : 1048576,
    repos,
    gitCacheDir: typeof s.gitCacheDir === 'string' && s.gitCacheDir.trim().length > 0 ? s.gitCacheDir.trim() : undefined,
  }
}

/** The proxy URL one route attempt uses: explicit override > ambient env > none. */
export function effectiveProxy(options, explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== '') return explicit
  if (options.proxy === 'direct') return undefined
  if (options.proxy !== undefined && options.proxy !== '') return options.proxy
  for (const name of PROXY_ENV_NAMES) {
    const value = process.env[name]
    if (value && value.length > 0) return value
  }
  return undefined
}
