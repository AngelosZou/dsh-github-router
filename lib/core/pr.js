/**
 * PR aggregation: tries api.github.com → gh CLI → page HTML → git protocol,
 * filling each requested part from the first route that can provide it and
 * recording per-part route attribution plus every failure note. When no
 * route can produce the metadata, the result is a structured error with the
 * route matrix instead of a partial guess.
 * @module dsh-github-router/core/pr
 */
import { effectiveProxy } from '../config.js'
import { ghAuthed, ghPrDiff, ghPrView, ghVersion } from '../routes/gh.js'
import { GitFetchCache, findLocalRepo, gitVersion, readCachePr, readLocalPr } from '../routes/git.js'
import { fetchAndParsePage } from '../routes/html.js'
import { guardByteCount, guardOwnerRepo, guardPrNumber, truncateText } from '../util.js'
import { attemptLadder, buildRuntime, rateNote } from './runtime.js'

const BODY_CAP = 20000

function shapeApiPr(meta) {
  return {
    owner: meta.base && meta.base.repo ? meta.base.repo.owner.login : null,
    repo: meta.base && meta.base.repo ? meta.base.repo.name : null,
    number: meta.number ?? null,
    title: meta.title ?? null,
    body: truncateText(meta.body ?? '', BODY_CAP).text,
    state: meta.state ?? null,
    draft: meta.draft === true,
    merged: meta.merged === true,
    author: meta.user && meta.user.login ? meta.user.login : null,
    additions: meta.additions ?? null,
    deletions: meta.deletions ?? null,
    changedFiles: meta.changed_files ?? null,
    createdAt: meta.created_at ?? null,
    updatedAt: meta.updated_at ?? null,
    mergedAt: meta.merged_at ?? null,
    baseRef: meta.base ? meta.base.ref : null,
    headRef: meta.head ? meta.head.ref : null,
    baseSha: meta.base ? meta.base.sha : null,
    headSha: meta.head ? meta.head.sha : null,
    url: meta.html_url ?? null,
  }
}

function shapeGhPr(json) {
  return {
    owner: null,
    repo: null,
    number: null,
    title: json.title ?? null,
    body: truncateText(json.body ?? '', BODY_CAP).text,
    state: json.state ?? null,
    draft: json.isDraft === true,
    merged: json.mergedAt !== null && json.mergedAt !== undefined,
    author: json.author && json.author.login ? json.author.login : null,
    additions: json.additions ?? null,
    deletions: json.deletions ?? null,
    changedFiles: json.changedFiles ?? null,
    createdAt: json.createdAt ?? null,
    updatedAt: json.updatedAt ?? null,
    mergedAt: json.mergedAt ?? null,
    baseRef: json.baseRefName ?? null,
    headRef: json.headRefName ?? null,
    baseSha: json.baseRefOid ?? null,
    headSha: json.headRefOid ?? null,
    url: null,
  }
}

function shapeGhFiles(json) {
  return Array.isArray(json) ? json.map((f) => ({ path: f.path ?? null, status: null, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })) : []
}

function shapeGhCommits(json) {
  if (!Array.isArray(json)) return []
  return json.map((c) => ({
    sha: c.oid ?? null,
    author: Array.isArray(c.authors) && c.authors.length > 0 ? c.authors[0].login : null,
    date: c.authoredDate ?? null,
    message: truncateText(`${c.messageHeadline ?? ''}${c.messageBody ? '\n\n' + c.messageBody : ''}`, 2000).text,
  }))
}

function shapeGhReviews(json) {
  if (!Array.isArray(json)) return []
  return json.map((r) => ({ author: r.author && r.author.login ? r.author.login : null, state: r.state ?? null, submittedAt: r.submittedAt ?? null, body: truncateText(r.body ?? '', BODY_CAP).text }))
}

function shapeGhComments(json) {
  if (!Array.isArray(json)) return []
  return json.map((c) => ({
    kind: 'comment',
    author: c.author && c.author.login ? c.author.login : null,
    createdAt: c.createdAt ?? null,
    body: truncateText(c.body ?? '', BODY_CAP).text,
    path: null,
    url: c.url ?? null,
  }))
}

/** Cap one list at maxItems and report how many entries were dropped. */
function capItems(items, maxItems, notes, label) {
  if (items.length <= maxItems) return items
  notes.push(`${label}: showing ${maxItems} of ${items.length}`)
  return items.slice(0, maxItems)
}

export async function aggregatePr(ctx, options, args) {
  const owner = guardOwnerRepo(args.owner, 'owner')
  const repo = guardOwnerRepo(args.repo, 'repo')
  const number = guardPrNumber(args.number, 'number')
  const maxDiffBytes = guardByteCount(args.maxDiffBytes, 'maxDiffBytes', 65536, 4096, 1048576)
  const maxItems = guardByteCount(args.maxItems, 'maxItems', 50, 5, 200)
  const include = {
    discussion: args.includeDiscussion !== false,
    reviews: args.includeReviews !== false,
    commits: args.includeCommits !== false,
    files: args.includeFiles !== false,
    diff: args.includeDiff !== false,
  }
  const forceRefresh = args.forceRefresh === true
  const { cwd, signal } = args

  const runtime = buildRuntime(ctx, options)
  const { subprocess, fetchImpl, cache, api } = runtime
  const token = await runtime.resolveToken()
  const state = {
    pr: null,
    discussion: [],
    reviews: [],
    commits: [],
    files: [],
    diff: null,
    diffTruncated: false,
    routes: { meta: null, discussion: null, reviews: null, commits: null, files: null, diff: null },
    notes: [],
  }

  // ------------------------------------------------------------ 1) api route
  if (options.routes.api) {
    try {
      const attempt = await attemptLadder(
        (proxy) =>
          api.getJson(`/repos/${owner}/${repo}/pulls/${number}`, {
            token,
            signal,
            proxy,
            cache,
            ttlMs: options.cacheTtlSeconds.meta,
            forceRefresh,
            fetchImpl,
          }),
        options,
      )
      const meta = attempt.value
      state.pr = { ...shapeApiPr(meta), owner, repo, number }
      state.routes.meta = 'api'
      rateNote(meta._headers, state.notes)
    } catch (error) {
      state.notes.push(`api meta: ${String(error && error.message ? error.message : error).slice(0, 220)}`)
    }
  }

  if (state.pr !== null) {
    const apiGet = (path, query, ttl) =>
      attemptLadder(
        (proxy) => api.getJson(path, { token, signal, proxy, cache, ttlMs: ttl, forceRefresh, fetchImpl, query }),
        options,
      )
    const settle = []
    if (include.files) {
      settle.push(
        (async () => {
          try {
            const out = await apiGet(`/repos/${owner}/${repo}/pulls/${number}/files`, { per_page: 100 }, options.cacheTtlSeconds.content)
            state.files = capItems(
              (Array.isArray(out.value) ? out.value : []).map((f) => ({ path: f.filename ?? null, status: f.status ?? null, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
              maxItems,
              state.notes,
              'files',
            )
            state.routes.files = 'api'
          } catch (error) {
            state.notes.push(`api files: ${String(error && error.message ? error.message : error).slice(0, 180)}`)
          }
        })(),
      )
    }
    if (include.commits) {
      settle.push(
        (async () => {
          try {
            const out = await apiGet(`/repos/${owner}/${repo}/pulls/${number}/commits`, { per_page: 100 }, options.cacheTtlSeconds.content)
            state.commits = capItems(
              (Array.isArray(out.value) ? out.value : []).map((c) => ({
                sha: c.sha ?? null,
                author: c.author && c.author.login ? c.author.login : c.commit && c.commit.author ? c.commit.author.name : null,
                date: c.commit && c.commit.author ? c.commit.author.date : null,
                message: truncateText(c.commit ? c.commit.message ?? '' : '', 2000).text,
              })),
              maxItems,
              state.notes,
              'commits',
            )
            state.routes.commits = 'api'
          } catch (error) {
            state.notes.push(`api commits: ${String(error && error.message ? error.message : error).slice(0, 180)}`)
          }
        })(),
      )
    }
    if (include.reviews) {
      settle.push(
        (async () => {
          try {
            const out = await apiGet(`/repos/${owner}/${repo}/pulls/${number}/reviews`, { per_page: 100 }, options.cacheTtlSeconds.meta)
            state.reviews = capItems(
              (Array.isArray(out.value) ? out.value : []).map((r) => ({
                author: r.user && r.user.login ? r.user.login : null,
                state: r.state ?? null,
                submittedAt: r.submitted_at ?? null,
                body: truncateText(r.body ?? '', BODY_CAP).text,
              })),
              maxItems,
              state.notes,
              'reviews',
            )
            state.routes.reviews = 'api'
          } catch (error) {
            state.notes.push(`api reviews: ${String(error && error.message ? error.message : error).slice(0, 180)}`)
          }
        })(),
      )
    }
    if (include.discussion) {
      settle.push(
        (async () => {
          try {
            const out = await apiGet(`/repos/${owner}/${repo}/issues/${number}/comments`, { per_page: 100 }, options.cacheTtlSeconds.meta)
            const comments = (Array.isArray(out.value) ? out.value : []).map((c) => ({
              kind: 'comment',
              author: c.user && c.user.login ? c.user.login : null,
              createdAt: c.created_at ?? null,
              body: truncateText(c.body ?? '', BODY_CAP).text,
              path: null,
              url: c.html_url ?? null,
            }))
            let inline = []
            try {
              const out2 = await apiGet(`/repos/${owner}/${repo}/pulls/${number}/comments`, { per_page: 100 }, options.cacheTtlSeconds.meta)
              inline = (Array.isArray(out2.value) ? out2.value : []).map((c) => ({
                kind: 'review-comment',
                author: c.user && c.user.login ? c.user.login : null,
                createdAt: c.created_at ?? null,
                body: truncateText(c.body ?? '', BODY_CAP).text,
                path: c.path ?? null,
                url: c.html_url ?? null,
              }))
            } catch { /* inline comments are best-effort */ }
            state.discussion = capItems([...inline, ...comments], maxItems, state.notes, 'discussion')
            state.routes.discussion = 'api'
          } catch (error) {
            state.notes.push(`api discussion: ${String(error && error.message ? error.message : error).slice(0, 180)}`)
          }
        })(),
      )
    }
    if (include.diff) {
      settle.push(
        (async () => {
          try {
            const attempt = await attemptLadder(
              (proxy) =>
                api.getText(`/repos/${owner}/${repo}/pulls/${number}`, 'application/vnd.github.v3.diff', {
                  token,
                  signal,
                  proxy,
                  fetchImpl,
                }),
              options,
            )
            const capped = truncateText(attempt.value.text, maxDiffBytes)
            state.diff = capped.text
            state.diffTruncated = capped.truncated || attempt.value.truncated
            state.routes.diff = 'api'
          } catch (error) {
            state.notes.push(`api diff: ${String(error && error.message ? error.message : error).slice(0, 180)}`)
          }
        })(),
      )
    }
    await Promise.allSettled(settle)
  }

  // ------------------------------------------------------------ 2) gh route
  const needGh = state.pr === null || (include.files && state.files.length === 0) || (include.commits && state.commits.length === 0) || (include.reviews && state.reviews.length === 0) || (include.discussion && state.discussion.length === 0)
  if (options.routes.gh && subprocess !== undefined && needGh) {
    let ghUsable = false
    try {
      ghUsable = (await ghVersion(subprocess, signal)) && (await ghAuthed(subprocess, signal))
    } catch { ghUsable = false }
    if (ghUsable) {
      try {
        const g = await ghPrView(subprocess, owner, repo, number, { signal })
        if (state.pr === null) {
          state.pr = { ...shapeGhPr(g), owner, repo, number }
          state.routes.meta = 'gh'
        }
        if (include.files && state.files.length === 0 && Array.isArray(g.files)) {
          state.files = capItems(shapeGhFiles(g.files), maxItems, state.notes, 'files')
          state.routes.files = 'gh'
        }
        if (include.commits && state.commits.length === 0) {
          state.commits = capItems(shapeGhCommits(g.commits), maxItems, state.notes, 'commits')
          state.routes.commits = 'gh'
        }
        if (include.reviews && state.reviews.length === 0) {
          state.reviews = capItems(shapeGhReviews(g.reviews), maxItems, state.notes, 'reviews')
          state.routes.reviews = 'gh'
        }
        if (include.discussion && state.discussion.length === 0) {
          state.discussion = capItems(shapeGhComments(g.comments), maxItems, state.notes, 'discussion')
          state.routes.discussion = 'gh'
        }
      } catch (error) {
        state.notes.push(`gh pr view: ${String(error && error.message ? error.message : error).slice(0, 180)}`)
      }
      if (include.diff && state.diff === null) {
        try {
          const d = await ghPrDiff(subprocess, owner, repo, number, { signal, maxStdout: maxDiffBytes })
          state.diff = d.text
          state.diffTruncated = d.truncated
          state.routes.diff = 'gh'
        } catch (error) {
          state.notes.push(`gh pr diff: ${String(error && error.message ? error.message : error).slice(0, 180)}`)
        }
      }
    } else {
      state.notes.push('gh route skipped: gh CLI not installed or not authenticated')
    }
  }

  // ---------------------------------------------------------- 3) html route
  if (options.routes.html && (state.pr === null || (include.discussion && state.discussion.length === 0))) {
    try {
      await attemptLadder(
        async (proxy) => {
          const parsed = await fetchAndParsePage(owner, repo, number, 'pull', {
            fetchImpl,
            proxy,
            signal,
            timeoutMs: proxy !== undefined ? options.proxyTimeoutMs : options.directTimeoutMs,
          })
          if (state.pr === null && parsed.pr !== null) {
            state.pr = { ...parsed.pr, owner, repo, number }
            state.routes.meta = 'html'
          }
          if (include.discussion && state.discussion.length === 0 && parsed.discussion.length > 0) {
            state.discussion = capItems(parsed.discussion, maxItems, state.notes, 'discussion')
            state.routes.discussion = 'html'
          }
        },
        options,
        { proxyFirst: true },
      )
    } catch (error) {
      state.notes.push(`html page: ${String(error && error.message ? error.message : error).slice(0, 220)}`)
    }
  }

  // ------------------------------------------------------------ 4) git route
  if (options.routes.git && subprocess !== undefined && (state.commits.length === 0 || state.diff === null)) {
    let gitUsable = false
    try {
      gitUsable = await gitVersion(subprocess, signal)
    } catch { gitUsable = false }
    if (gitUsable) {
      try {
        let read = null
        let localDir = null
        try {
          localDir = await findLocalRepo(subprocess, cwd, owner, repo, options.repos, args.localRepo)
          if (localDir !== null) read = await readLocalPr(subprocess, localDir, number, { signal, maxDiffBytes })
        } catch (error) {
          state.notes.push(`git local repo: ${String(error && error.message ? error.message : error).slice(0, 180)}`)
        }
        if (read === null) {
          const cacheRepo = new GitFetchCache(subprocess, options.gitCacheDir)
          const fetched = await cacheRepo.fetchPr(owner, repo, number, { proxy: effectiveProxy(options), signal })
          read = await readCachePr(subprocess, fetched.dir, number, { signal, maxDiffBytes })
          if (fetched.mergeError !== null) state.notes.push(`git: merge ref unavailable (${fetched.mergeError.slice(0, 120)}); diff falls back to head-only commits`)
        }
        if (read !== null && read !== undefined) {
          if (include.commits && state.commits.length === 0 && read.commits.length > 0) {
            state.commits = capItems(read.commits, maxItems, state.notes, 'commits')
            state.routes.commits = 'git'
          }
          if (include.diff && state.diff === null && read.diff !== null) {
            state.diff = read.diff
            state.diffTruncated = read.diffTruncated
            state.routes.diff = 'git'
          }
          for (const note of read.notes ?? []) if (note.length > 0) state.notes.push(`git: ${note.slice(0, 160)}`)
        }
      } catch (error) {
        state.notes.push(`git route: ${String(error && error.message ? error.message : error).slice(0, 220)}`)
      }
    } else {
      state.notes.push('git route skipped: git not available')
    }
  }

  if (state.pr === null) {
    return {
      error: `all GitHub routes failed to load PR ${owner}/${repo}#${number}`,
      routes: state.routes,
      notes: state.notes,
    }
  }
  return {
    pr: state.pr,
    discussion: state.discussion,
    reviews: state.reviews,
    commits: state.commits,
    files: state.files,
    diff: state.diff,
    diffTruncated: state.diffTruncated,
    routes: state.routes,
    notes: state.notes,
  }
}
