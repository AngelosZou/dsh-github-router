/**
 * git protocol route — the empirically surviving path on machines where
 * HTTPS to github.com/api.github.com is reset.
 *
 * Two strictly separated modes:
 * 1. Plugin fetch cache: a plugin-owned bare-less repo under the host
 *    storage dir. `git init` + `git fetch` of pull refs write ONLY there.
 * 2. Local repo reads: user-granted repos (settings `repos`, the session
 *    cwd repo when its origin matches, or an explicit per-call path) are
 *    read with log/diff/show/rev-parse ONLY. The plugin never fetches into,
 *    checks out, resets, or pushes to a user repository.
 *
 * All subprocess calls are argv arrays; nothing is shell-interpolated.
 * @module dsh-github-router/routes/git
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { GIT_CACHE_DIR, childEnv, ownerRepoFromUrl, runCaptured } from '../util.js'

const FETCH_GRACE_MS = 90_000
const READ_GRACE_MS = 20_000

export async function gitVersion(subprocess, signal) {
  const out = await runCaptured(subprocess, { argv: ['git', '--version'], graceMs: 8_000, signal, env: childEnv(), maxStdout: 4096, maxStderr: 4096 })
  return out.ok
}

function proxyEnv(proxy) {
  if (proxy === undefined || proxy === null || proxy === '') return {}
  return { http_proxy: proxy, https_proxy: proxy, HTTP_PROXY: proxy, HTTPS_PROXY: proxy }
}

/** `git ls-remote <url> <ref>` — a pure connectivity + sha probe. */
export async function gitLsRemote(subprocess, remoteUrl, ref, spec = {}) {
  const out = await runCaptured(subprocess, {
    argv: ['git', 'ls-remote', remoteUrl, ref],
    graceMs: spec.graceMs ?? 20_000,
    signal: spec.signal,
    env: childEnv(proxyEnv(spec.proxy)),
    maxStdout: 8192,
    maxStderr: 8192,
  })
  if (!out.ok) return { ok: false, sha: null, error: (out.stderr.text || out.spawnError || `exit ${out.exitCode}`).slice(0, 300) }
  const match = /^([0-9a-f]{40})\s+/.exec(out.stdout.text)
  if (match === null) return { ok: true, sha: null, error: 'no sha in ls-remote output' }
  return { ok: true, sha: match[1], error: null }
}

/** In-process mutex per cache repo: fetches to one repo are serialized. */
const repoLocks = new Map()
async function withRepoLock(key, fn) {
  const prev = repoLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  repoLocks.set(key, next.catch(() => {}))
  try {
    return await next
  } finally {
    if (repoLocks.get(key) === next) repoLocks.delete(key)
  }
}

/**
 * The plugin-owned fetch cache. Every write stays under the host storage
 * dir; nothing outside it is ever created.
 */
export class GitFetchCache {
  constructor(subprocess, gitCacheDir = GIT_CACHE_DIR) {
    this.subprocess = subprocess
    this.gitDir = gitCacheDir
  }

  repoDir(owner, repo) {
    return join(this.gitDir, `${owner}__${repo}`)
  }

  async ensure(owner, repo) {
    const dir = this.repoDir(owner, repo)
    if (existsSync(join(dir, '.git'))) return dir
    try { mkdirSync(this.gitDir, { recursive: true }) } catch { /* exists */ }
    const init = await runCaptured(this.subprocess, {
      argv: ['git', 'init', '--quiet', dir],
      graceMs: 15_000,
      env: childEnv(),
      maxStdout: 8192,
      maxStderr: 8192,
    })
    if (!init.ok) throw new Error(`git init failed: ${init.stderr.text.slice(0, 300)}`)
    const add = await runCaptured(this.subprocess, {
      argv: ['git', '-C', dir, 'remote', 'add', 'origin', `https://github.com/${owner}/${repo}.git`],
      graceMs: 15_000,
      env: childEnv(),
      maxStdout: 8192,
      maxStderr: 8192,
    })
    if (!add.ok) {
      // A race with another process: recover with set-url.
      const set = await runCaptured(this.subprocess, {
        argv: ['git', '-C', dir, 'remote', 'set-url', 'origin', `https://github.com/${owner}/${repo}.git`],
        graceMs: 15_000,
        env: childEnv(),
        maxStdout: 8192,
        maxStderr: 8192,
      })
      if (!set.ok) throw new Error(`git remote setup failed: ${set.stderr.text.slice(0, 300)}`)
    }
    return dir
  }

  /**
   * Fetch refs/pull/N/{head,merge} into refs/pr/N/* in the cache repo.
   * A missing merge ref (conflicted PR) degrades, not fails.
   */
  async fetchPr(owner, repo, number, spec = {}) {
    return withRepoLock(`${owner}/${repo}#${number}`, async () => {
      const dir = await this.ensure(owner, repo)
      const env = childEnv(proxyEnv(spec.proxy))
      const head = await runCaptured(this.subprocess, {
        argv: ['git', '-C', dir, 'fetch', '--quiet', '--no-tags', '--depth=64', 'origin', `refs/pull/${number}/head:refs/pr/${number}/head`],
        graceMs: spec.graceMs ?? FETCH_GRACE_MS,
        signal: spec.signal,
        env,
        maxStdout: 8192,
        maxStderr: 16384,
      })
      const merge = await runCaptured(this.subprocess, {
        argv: ['git', '-C', dir, 'fetch', '--quiet', '--no-tags', '--depth=64', 'origin', `refs/pull/${number}/merge:refs/pr/${number}/merge`],
        graceMs: spec.graceMs ?? FETCH_GRACE_MS,
        signal: spec.signal,
        env,
        maxStdout: 8192,
        maxStderr: 16384,
      })
      if (!head.ok) {
        throw new Error(`git fetch failed: ${(head.stderr.text || head.spawnError || `exit ${head.exitCode}`).slice(0, 400)}`)
      }
      return { dir, mergeFetched: merge.ok, mergeError: merge.ok ? null : merge.stderr.text.slice(0, 300) }
    })
  }

  async fetchRef(owner, repo, ref, spec = {}) {
    return withRepoLock(`${owner}/${repo}@${ref}`, async () => {
      const dir = await this.ensure(owner, repo)
      const out = await runCaptured(this.subprocess, {
        argv: ['git', '-C', dir, 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', `+refs/heads/${ref}:refs/gh-router/${ref}`],
        graceMs: spec.graceMs ?? FETCH_GRACE_MS,
        signal: spec.signal,
        env: childEnv(proxyEnv(spec.proxy)),
        maxStdout: 8192,
        maxStderr: 16384,
      })
      if (!out.ok) {
        throw new Error(`git fetch failed: ${(out.stderr.text || out.spawnError || `exit ${out.exitCode}`).slice(0, 400)}`)
      }
      return { dir }
    })
  }

  /** Fetch a full commit sha (GitHub allows reachable-sha wants). */
  async fetchSha(owner, repo, sha, spec = {}) {
    return withRepoLock(`${owner}/${repo}@${sha}`, async () => {
      const dir = await this.ensure(owner, repo)
      const out = await runCaptured(this.subprocess, {
        argv: ['git', '-C', dir, 'fetch', '--quiet', '--no-tags', 'origin', sha],
        graceMs: spec.graceMs ?? FETCH_GRACE_MS,
        signal: spec.signal,
        env: childEnv(proxyEnv(spec.proxy)),
        maxStdout: 8192,
        maxStderr: 16384,
      })
      if (!out.ok) {
        throw new Error(`git fetch sha failed: ${(out.stderr.text || out.spawnError || `exit ${out.exitCode}`).slice(0, 400)}`)
      }
      return { dir }
    })
  }

  /** Fetch the default branch head into FETCH_HEAD. */
  async fetchHead(owner, repo, spec = {}) {
    return withRepoLock(`${owner}/${repo}@HEAD`, async () => {
      const dir = await this.ensure(owner, repo)
      const out = await runCaptured(this.subprocess, {
        argv: ['git', '-C', dir, 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', 'HEAD'],
        graceMs: spec.graceMs ?? FETCH_GRACE_MS,
        signal: spec.signal,
        env: childEnv(proxyEnv(spec.proxy)),
        maxStdout: 8192,
        maxStderr: 16384,
      })
      if (!out.ok) {
        throw new Error(`git fetch HEAD failed: ${(out.stderr.text || out.spawnError || `exit ${out.exitCode}`).slice(0, 400)}`)
      }
      return { dir }
    })
  }
}

// --------------------------------------------------------- local repo reads

/** The session/local repo the git route may READ, or null. */
export async function findLocalRepo(subprocess, cwd, owner, repo, extraRepos, localRepo) {
  const candidates = []
  if (typeof localRepo === 'string' && localRepo.trim().length > 0) candidates.push(localRepo.trim())
  for (const r of extraRepos ?? []) candidates.push(r)
  if (typeof cwd === 'string' && cwd.length > 0) candidates.push(cwd)
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue
    const rootOut = await runCaptured(subprocess, {
      argv: ['git', '-C', candidate, 'rev-parse', '--show-toplevel'],
      graceMs: 10_000,
      env: childEnv(),
      maxStdout: 8192,
      maxStderr: 8192,
    })
    if (!rootOut.ok) continue
    const root = rootOut.stdout.text.trim().replace(/\/+$/, '')
    if (root.length === 0) continue
    const urlOut = await runCaptured(subprocess, {
      argv: ['git', '-C', root, 'config', '--get', 'remote.origin.url'],
      graceMs: 10_000,
      env: childEnv(),
      maxStdout: 8192,
      maxStderr: 8192,
    })
    if (!urlOut.ok) continue
    const parsed = ownerRepoFromUrl(urlOut.stdout.text)
    if (parsed !== null && parsed.owner.toLowerCase() === owner.toLowerCase() && parsed.repo.toLowerCase() === repo.toLowerCase()) {
      return root
    }
  }
  return null
}

/** Ref names the local repo may hold for a PR, in lookup order. */
function prRefCandidates(number) {
  return [
    `refs/pull/${number}/merge`,
    `refs/pull/${number}/head`,
    `refs/remotes/origin/pull/${number}/merge`,
    `refs/remotes/origin/pull/${number}/head`,
    `refs/remotes/origin/pr/${number}`,
  ]
}

async function resolveLocalRef(subprocess, repoDir, candidates) {
  for (const ref of candidates) {
    const out = await runCaptured(subprocess, {
      argv: ['git', '-C', repoDir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      graceMs: 10_000,
      env: childEnv(),
      maxStdout: 8192,
      maxStderr: 8192,
    })
    if (out.ok && out.stdout.text.trim().length > 0) return ref
  }
  return null
}

/**
 * Read PR commits/diff from a LOCAL repo without touching its network or
 * working tree: rev-parse / log / merge-base / diff / show only.
 */
export async function readLocalPr(subprocess, repoDir, number, spec = {}) {
  const found = await resolveLocalRef(subprocess, repoDir, prRefCandidates(number))
  if (found === null) return null
  const headRef = found
  const mergeRef = found.endsWith('/merge') ? found : null

  let base = null
  if (mergeRef !== null) {
    base = `${mergeRef}^1`
  } else {
    // Fall back to the merge base with origin/HEAD when available.
    const headOut = await runCaptured(subprocess, {
      argv: ['git', '-C', repoDir, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      graceMs: 10_000,
      env: childEnv(),
      maxStdout: 8192,
      maxStderr: 8192,
    })
    if (headOut.ok) {
      const defaultRef = headOut.stdout.text.trim()
      const baseOut = await runCaptured(subprocess, {
        argv: ['git', '-C', repoDir, 'merge-base', defaultRef, headRef],
        graceMs: 10_000,
        env: childEnv(),
        maxStdout: 8192,
        maxStderr: 8192,
      })
      if (baseOut.ok && baseOut.stdout.text.trim().length > 0) base = baseOut.stdout.text.trim()
    }
  }

  const commitsOut = await runCaptured(subprocess, {
    argv: ['git', '-C', repoDir, 'log', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e', base !== null ? `${base}..${headRef}` : `-50 ${headRef}`, '--no-merges'],
    graceMs: spec.graceMs ?? READ_GRACE_MS,
    signal: spec.signal,
    env: childEnv(),
    maxStdout: spec.maxStdout ?? 1048576,
    maxStderr: 16384,
  })
  let diff = null
  let diffTruncated = false
  if (base !== null) {
    const diffOut = await runCaptured(subprocess, {
      argv: ['git', '-C', repoDir, 'diff', '--find-renames', base, headRef],
      graceMs: spec.graceMs ?? READ_GRACE_MS,
      signal: spec.signal,
      env: childEnv(),
      maxStdout: spec.maxDiffBytes ?? 1048576,
      maxStderr: 16384,
    })
    if (diffOut.ok) {
      diff = diffOut.stdout.text
      diffTruncated = diffOut.stdout.truncated
    }
  }
  return {
    commits: parseCommitLog(commitsOut.ok ? commitsOut.stdout.text : ''),
    commitsTruncated: commitsOut.stdout.truncated,
    diff,
    diffTruncated,
    headRef,
    baseRef: base,
    notes: commitsOut.ok ? [] : [commitsOut.stderr.text.slice(0, 300)],
  }
}

/** Read one file at a local ref with `git show` — read-only. */
export async function readLocalFile(subprocess, repoDir, ref, path, spec = {}) {
  const out = await runCaptured(subprocess, {
    argv: ['git', '-C', repoDir, 'show', `${ref}:${path}`],
    graceMs: spec.graceMs ?? READ_GRACE_MS,
    signal: spec.signal,
    env: childEnv(),
    maxStdout: spec.maxStdout ?? 1048576,
    maxStderr: 16384,
  })
  if (!out.ok) {
    const err = new Error(`git show failed: ${out.stderr.text.slice(0, 300)}`)
    err.code = 'GIT_FAILED'
    throw err
  }
  return { content: out.stdout.text, truncated: out.stdout.truncated }
}

/** Read PR commits/diff from the plugin fetch cache (refs/pr/N/*). */
export async function readCachePr(subprocess, dir, number, spec = {}) {
  const mergeCheck = await runCaptured(subprocess, {
    argv: ['git', '-C', dir, 'rev-parse', '--verify', '--quiet', `refs/pr/${number}/merge^{commit}`],
    graceMs: 10_000,
    env: childEnv(),
    maxStdout: 4096,
    maxStderr: 4096,
  })
  const hasMerge = mergeCheck.ok && mergeCheck.stdout.text.trim().length > 0
  const headRef = `refs/pr/${number}/head`
  const base = hasMerge ? `refs/pr/${number}/merge^1` : null

  const commitsOut = await runCaptured(subprocess, {
    argv: ['git', '-C', dir, 'log', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e', base !== null ? `${base}..${headRef}` : `-50 ${headRef}`, '--no-merges'],
    graceMs: spec.graceMs ?? READ_GRACE_MS,
    signal: spec.signal,
    env: childEnv(),
    maxStdout: spec.maxStdout ?? 1048576,
    maxStderr: 16384,
  })
  let diff = null
  let diffTruncated = false
  if (base !== null) {
    const diffOut = await runCaptured(subprocess, {
      argv: ['git', '-C', dir, 'diff', '--find-renames', base, headRef],
      graceMs: spec.graceMs ?? READ_GRACE_MS,
      signal: spec.signal,
      env: childEnv(),
      maxStdout: spec.maxDiffBytes ?? 1048576,
      maxStderr: 16384,
    })
    if (diffOut.ok) {
      diff = diffOut.stdout.text
      diffTruncated = diffOut.stdout.truncated
    }
  }
  return {
    commits: parseCommitLog(commitsOut.ok ? commitsOut.stdout.text : ''),
    commitsTruncated: commitsOut.stdout.truncated,
    diff,
    diffTruncated,
    headRef,
    baseRef: base,
    notes: commitsOut.ok ? [] : [commitsOut.stderr.text.slice(0, 300)],
  }
}

/** Read one file at a ref in the plugin cache with `git show`. */
export async function readCacheFile(subprocess, dir, ref, path, spec = {}) {
  const out = await runCaptured(subprocess, {
    argv: ['git', '-C', dir, 'show', `${ref}:${path}`],
    graceMs: spec.graceMs ?? READ_GRACE_MS,
    signal: spec.signal,
    env: childEnv(),
    maxStdout: spec.maxStdout ?? 1048576,
    maxStderr: 16384,
  })
  if (!out.ok) {
    const err = new Error(`git show failed: ${out.stderr.text.slice(0, 300)}`)
    err.code = 'GIT_FAILED'
    throw err
  }
  return { content: out.stdout.text, truncated: out.stdout.truncated }
}

/** Parse the %x1f/%x1e-delimited commit log into structured entries. */
export function parseCommitLog(text) {
  const entries = String(text ?? '').split('\x1e')
  const out = []
  for (const entry of entries) {
    if (entry.trim().length === 0) continue
    const parts = entry.split('\x1f')
    if (parts.length < 5) continue
    out.push({
      sha: parts[0].trim().slice(0, 40),
      author: parts[1].trim(),
      email: parts[2].trim(),
      date: parts[3].trim(),
      message: parts.slice(4).join('\x1f').replace(/^\n+/, '').slice(0, 2000),
    })
  }
  return out
}
