/**
 * File aggregation: api contents (base64) → raw.githubusercontent.com
 * (direct/proxy) → user-configured mirrors → git protocol (local repo or
 * the plugin fetch cache). Read-only by construction.
 * @module dsh-github-router/core/file
 */
import { effectiveProxy } from '../config.js'
import { fetchText } from '../net.js'
import { GitFetchCache, findLocalRepo, gitVersion, readCacheFile, readLocalFile } from '../routes/git.js'
import { fetchViaMirrors } from '../routes/mirror.js'
import { guardByteCount, guardFilePath, guardOwnerRepo, guardRef } from '../util.js'
import { attemptLadder, buildRuntime } from './runtime.js'

const SHA_RE = /^[0-9a-f]{40}$/i

function decodeBase64(content) {
  try {
    return Buffer.from(content, 'base64').toString('utf8')
  } catch {
    return String(content ?? '')
  }
}

export async function aggregateFile(ctx, options, args) {
  const owner = guardOwnerRepo(args.owner, 'owner')
  const repo = guardOwnerRepo(args.repo, 'repo')
  const path = guardFilePath(args.path)
  const ref = args.ref === undefined || args.ref === null || String(args.ref).trim() === '' ? 'HEAD' : guardRef(args.ref, 'ref')
  const maxBytes = guardByteCount(args.maxBytes, 'maxBytes', 262144, 4096, options.maxBytes)
  const { cwd, signal } = args

  const runtime = buildRuntime(ctx, options)
  const { subprocess, fetchImpl, cache, api } = runtime
  const token = await runtime.resolveToken()
  const notes = []
  const failures = []
  let result = null

  // ------------------------------------------------------------ 1) api route
  if (options.routes.api) {
    try {
      const attempt = await attemptLadder(
        (proxy) =>
          api.getJson(`/repos/${owner}/${repo}/contents/${path}`, {
            token,
            signal,
            proxy,
            cache,
            ttlMs: options.cacheTtlSeconds.content,
            forceRefresh: args.forceRefresh === true,
            fetchImpl,
            query: { ref },
          }),
        options,
      )
      const value = attempt.value
      if (Array.isArray(value)) {
        return {
          kind: 'directory',
          path,
          ref,
          entries: value.slice(0, 200).map((e) => ({ name: e.name ?? null, type: e.type ?? null, size: e.size ?? null })),
          route: 'api',
          notes,
        }
      }
      if (value && typeof value === 'object' && typeof value.content === 'string') {
        const size = value.size ?? Buffer.from(value.content, 'base64').length
        if (size <= maxBytes) {
          result = { kind: 'file', path, ref: value.sha ?? ref, content: decodeBase64(value.content), size, truncated: false, route: 'api', notes }
        } else {
          notes.push(`api contents: file is ${size} bytes (cap ${maxBytes}); falling through to raw/git routes`)
        }
      }
    } catch (error) {
      failures.push(`api: ${String(error && error.message ? error.message : error).slice(0, 200)}`)
    }
  }

  // ------------------------------------------------------- 2) raw/mirror routes
  if (result === null) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
    try {
      const attempt = await attemptLadder(
        (proxy) =>
          fetchText(rawUrl, {
            headers: { accept: 'text/plain', 'user-agent': 'dsh-github-router/0.1.0' },
            timeoutMs: proxy !== undefined ? options.proxyTimeoutMs : options.directTimeoutMs,
            proxy,
            signal,
            maxBytes,
            retries: 0,
          }),
        options,
      )
      if (attempt.value.ok) {
        result = { kind: 'file', path, ref, content: attempt.value.text, size: attempt.value.body.length, truncated: attempt.value.truncated, route: attempt.via === 'proxy' ? 'raw-proxy' : 'raw', notes }
      } else {
        failures.push(`raw: HTTP ${attempt.value.status}`)
      }
    } catch (error) {
      failures.push(`raw: ${String(error && error.message ? error.message : error).slice(0, 200)}`)
    }
  }

  if (result === null && options.routes.mirror && options.mirrors.length > 0) {
    try {
      const via = await fetchViaMirrors(owner, repo, ref, path, options.mirrors, {
        timeoutMs: options.directTimeoutMs,
        signal,
        maxBytes,
      })
      result = { kind: 'file', path, ref, content: via.content, size: via.size, truncated: via.truncated, route: 'mirror', notes }
    } catch (error) {
      failures.push(`mirror: ${String(error && error.message ? error.message : error).slice(0, 200)}`)
    }
  }

  // ------------------------------------------------------------ 3) git route
  if (result === null && options.routes.git && subprocess !== undefined) {
    let gitUsable = false
    try {
      gitUsable = await gitVersion(subprocess, signal)
    } catch { gitUsable = false }
    if (gitUsable) {
      try {
        const local = await findLocalRepo(subprocess, cwd, owner, repo, options.repos, args.localRepo)
        if (local !== null) {
          const read = await readLocalFile(subprocess, local, ref, path, { signal, maxStdout: maxBytes })
          result = { kind: 'file', path, ref, content: read.content, size: Buffer.byteLength(read.content, 'utf8'), truncated: read.truncated, route: 'git-local', notes }
        } else {
          const cacheRepo = new GitFetchCache(subprocess, options.gitCacheDir)
          const proxy = effectiveProxy(options)
          let targetRef
          let dir
          if (SHA_RE.test(ref)) {
            dir = (await cacheRepo.fetchSha(owner, repo, ref, { proxy, signal })).dir
            targetRef = ref
          } else if (ref === 'HEAD') {
            dir = (await cacheRepo.fetchHead(owner, repo, { proxy, signal })).dir
            targetRef = 'FETCH_HEAD'
          } else {
            dir = (await cacheRepo.fetchRef(owner, repo, ref, { proxy, signal })).dir
            targetRef = `refs/gh-router/${ref}`
          }
          const read = await readCacheFile(subprocess, dir, targetRef, path, { signal, maxStdout: maxBytes })
          result = { kind: 'file', path, ref, content: read.content, size: Buffer.byteLength(read.content, 'utf8'), truncated: read.truncated, route: 'git-cache', notes }
        }
      } catch (error) {
        failures.push(`git: ${String(error && error.message ? error.message : error).slice(0, 200)}`)
      }
    } else {
      failures.push('git: git not available')
    }
  }

  if (result === null) {
    return {
      error: `all routes failed to load ${owner}/${repo} @ ${ref}: ${path}`,
      failures,
      notes,
    }
  }
  result.failures = failures
  return result
}
