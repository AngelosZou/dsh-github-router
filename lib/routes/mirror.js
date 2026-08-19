/**
 * Raw-content mirror route. Mirrors are OFF by default: they are third
 * parties that see requested paths and serve file bytes, so the user must
 * explicitly configure and enable them. When enabled, each configured base
 * yields two candidate URLs per file (raw.githubusercontent.com passthrough
 * and the github.com /raw/ route).
 * @module dsh-github-router/routes/mirror
 */
import { fetchText } from '../net.js'

export function rawUrl(owner, repo, ref, path) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
}

export function githubRawRouteUrl(owner, repo, ref, path) {
  return `https://github.com/${owner}/${repo}/raw/${ref}/${path}`
}

/** All mirror candidate URLs for one file, in configured mirror order. */
export function mirrorCandidates(owner, repo, ref, path, mirrors) {
  const out = []
  const raw = rawUrl(owner, repo, ref, path)
  const viaGithub = githubRawRouteUrl(owner, repo, ref, path)
  for (const mirror of mirrors ?? []) {
    const base = String(mirror).replace(/\/+$/, '')
    if (base.length === 0 || !/^https?:\/\//.test(base)) continue
    out.push(`${base}/${raw}`)
    out.push(`${base}/${viaGithub}`)
  }
  return out
}

/** Try each mirror candidate in order; returns the first usable body. */
export async function fetchViaMirrors(owner, repo, ref, path, mirrors, call) {
  const errors = []
  for (const url of mirrorCandidates(owner, repo, ref, path, mirrors)) {
    try {
      const raw = await fetchText(url, {
        headers: { accept: 'text/plain', 'user-agent': 'dsh-github-router/0.1.0' },
        timeoutMs: call.timeoutMs,
        signal: call.signal,
        maxBytes: call.maxBytes,
        retries: 0,
      })
      if (raw.ok) return { content: raw.text, truncated: raw.truncated, url, size: raw.body.length }
      errors.push(`${url} -> HTTP ${raw.status}`)
    } catch (error) {
      errors.push(`${url} -> ${String(error && error.code ? error.code + ': ' : '')}${String(error && error.message ? error.message : error)}`)
      if (call.signal && call.signal.aborted) throw error
    }
  }
  const err = new Error(`all mirrors failed: ${errors.join('; ').slice(0, 500)}`)
  err.code = 'MIRROR_FAILED'
  throw err
}
