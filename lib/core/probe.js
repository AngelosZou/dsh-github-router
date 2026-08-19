/**
 * Connectivity probe: runs every route once (short timeouts, GET only) and
 * reports a matrix of what works from the HOST side, plus a recommended
 * route chain. This is the first tool to call when GitHub access misbehaves
 * — one call replaces a dozen shell retries.
 * @module dsh-github-router/core/probe
 */
import { effectiveProxy } from '../config.js'
import { ghAuthed, ghVersion } from '../routes/gh.js'
import { gitLsRemote, gitVersion } from '../routes/git.js'
import { guardOwnerRepo, guardPrNumber } from '../util.js'
import { buildRuntime } from './runtime.js'

const UA = { accept: 'text/html,application/xhtml+xml', 'user-agent': 'dsh-github-router/0.1.0' }

export async function aggregateProbe(ctx, options, args) {
  const runtime = buildRuntime(ctx, options)
  const { subprocess, fetchImpl, api } = runtime
  const signal = args._signal
  const token = await runtime.resolveToken()
  const owner = args.owner !== undefined && args.owner !== null && String(args.owner).trim() !== '' ? guardOwnerRepo(args.owner, 'owner') : null
  const repo = args.repo !== undefined && args.repo !== null && String(args.repo).trim() !== '' ? guardOwnerRepo(args.repo, 'repo') : null
  const number = args.prNumber !== undefined && args.prNumber !== null ? guardPrNumber(args.prNumber, 'prNumber') : null
  const proxy = effectiveProxy(options)

  const checks = []
  const run = async (route, fn) => {
    const t0 = Date.now()
    try {
      const detail = await fn()
      checks.push({ route, ok: true, ms: Date.now() - t0, detail: String(detail ?? '').slice(0, 200) })
    } catch (error) {
      if (error && error.code === 'ABORTED') throw error
      checks.push({
        route,
        ok: false,
        ms: Date.now() - t0,
        detail: String(`${error && error.code ? error.code + ': ' : ''}${error && error.message ? error.message : error}`).slice(0, 200),
      })
    }
  }

  checks.push({ route: 'token', ok: token !== undefined && token !== '', ms: 0, detail: token ? 'token configured' : 'no token — anonymous API limits (60/h) apply' })

  const apiCheck = async (proxyUrl) => {
    const out = await api.getJson('/rate_limit', { token, signal, proxy: proxyUrl, fetchImpl, ttlMs: 0 })
    const remaining = out._headers && out._headers['x-ratelimit-remaining']
    const limit = out._headers && out._headers['x-ratelimit-limit']
    return `HTTP 200; rate limit remaining ${remaining ?? '?'}${limit !== undefined ? '/' + limit : ''}`
  }
  await run('api-direct', () => apiCheck(undefined))
  if (proxy !== undefined) await run('api-proxy', () => apiCheck(proxy))

  if (subprocess !== undefined) {
    await run('gh-installed', async () => {
      if (!(await ghVersion(subprocess, signal))) throw new Error('gh not on PATH')
      return 'gh CLI present'
    })
    await run('gh-authed', async () => {
      if (!(await ghAuthed(subprocess, signal))) throw new Error('gh auth status failed — run gh auth login')
      return 'gh CLI authenticated'
    })
    await run('git-installed', async () => {
      if (!(await gitVersion(subprocess, signal))) throw new Error('git not on PATH')
      return 'git present'
    })
    if (owner !== null && repo !== null) {
      await run('git-ls-remote', async () => {
        const ref = number !== null ? `refs/pull/${number}/head` : 'HEAD'
        const out = await gitLsRemote(subprocess, `https://github.com/${owner}/${repo}.git`, ref, { signal, proxy })
        if (!out.ok) throw new Error(out.error ?? 'ls-remote failed')
        return `ref ${ref} -> ${out.sha ?? 'unknown'}`
      })
    }
  }

  const page = owner !== null && repo !== null
    ? `https://github.com/${owner}/${repo}${number !== null ? `/pull/${number}` : ''}`
    : 'https://github.com'
  const htmlCheck = async (proxyUrl) => {
    const out = await fetchImpl(page, {
      headers: UA,
      timeoutMs: proxyUrl !== undefined ? options.proxyTimeoutMs : options.directTimeoutMs,
      proxy: proxyUrl,
      signal,
      maxBytes: 65536,
      retries: 0,
    })
    if (!out.ok) throw new Error(`HTTP ${out.status}`)
    return `HTTP ${out.status} (${out.body.length} bytes)`
  }
  await run('html-direct', () => htmlCheck(undefined))
  if (proxy !== undefined) await run('html-proxy', () => htmlCheck(proxy))

  if (options.routes.mirror && options.mirrors.length > 0) {
    await run('mirror', async () => {
      const base = options.mirrors[0].replace(/\/+$/, '') + '/'
      const out = await fetchImpl(base, { headers: UA, timeoutMs: options.directTimeoutMs, signal, maxBytes: 65536, retries: 0 })
      if (!out.ok) throw new Error(`HTTP ${out.status}`)
      return `mirror ${base} reachable (HTTP ${out.status})`
    })
  }

  const live = checks.filter((c) => c.ok).map((c) => c.route)
  const recommendation = []
  if (live.includes('api-direct')) recommendation.push('api (direct) — richest data, primary route')
  if (live.includes('api-proxy')) recommendation.push('api (proxy)')
  if (live.includes('gh-authed')) recommendation.push('gh CLI — fallback for API failures')
  if (live.includes('html-proxy') || live.includes('html-direct')) recommendation.push('page HTML parse — metadata + discussion fallback')
  if (live.includes('git-ls-remote')) recommendation.push('git protocol — commits/diff/file fallback (survives HTTP blocks)')
  if (live.includes('mirror')) recommendation.push('mirrors — raw file fallback')
  if (recommendation.length === 0) recommendation.push('no route is live — GitHub is unreachable from this host; fix the proxy or network first')

  return {
    checks,
    live,
    recommendation,
    proxy: proxy ?? null,
    tokenConfigured: token !== undefined && token !== '',
  }
}
