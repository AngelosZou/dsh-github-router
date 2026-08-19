/**
 * Issue aggregation: api.github.com → gh CLI → page HTML, with per-part
 * route attribution and structured failure.
 * @module dsh-github-router/core/issue
 */
import { ghAuthed, ghIssueView, ghVersion } from '../routes/gh.js'
import { fetchAndParsePage } from '../routes/html.js'
import { guardByteCount, guardOwnerRepo, guardPrNumber, truncateText } from '../util.js'
import { attemptLadder, buildRuntime, rateNote } from './runtime.js'

const BODY_CAP = 20000

function shapeApiIssue(meta, owner, repo, number) {
  return {
    owner,
    repo,
    number,
    title: meta.title ?? null,
    body: truncateText(meta.body ?? '', BODY_CAP).text,
    state: meta.state ?? null,
    stateReason: meta.state_reason ?? null,
    author: meta.user && meta.user.login ? meta.user.login : null,
    createdAt: meta.created_at ?? null,
    updatedAt: meta.updated_at ?? null,
    closedAt: meta.closed_at ?? null,
    commentsCount: meta.comments ?? null,
    labels: Array.isArray(meta.labels) ? meta.labels.map((l) => l.name ?? null).filter((n) => n !== null) : [],
    url: meta.html_url ?? null,
  }
}

function shapeGhIssue(json, owner, repo, number) {
  return {
    owner,
    repo,
    number,
    title: json.title ?? null,
    body: truncateText(json.body ?? '', BODY_CAP).text,
    state: json.state ?? null,
    stateReason: json.stateReason ?? null,
    author: json.author && json.author.login ? json.author.login : null,
    createdAt: json.createdAt ?? null,
    updatedAt: json.updatedAt ?? null,
    closedAt: json.closedAt ?? null,
    commentsCount: Array.isArray(json.comments) ? json.comments.length : null,
    labels: Array.isArray(json.labels) ? json.labels.map((l) => (typeof l === 'string' ? l : l.name ?? null)).filter((n) => n !== null) : [],
    url: null,
  }
}

function capItems(items, maxItems, notes, label) {
  if (items.length <= maxItems) return items
  notes.push(`${label}: showing ${maxItems} of ${items.length}`)
  return items.slice(0, maxItems)
}

export async function aggregateIssue(ctx, options, args) {
  const owner = guardOwnerRepo(args.owner, 'owner')
  const repo = guardOwnerRepo(args.repo, 'repo')
  const number = guardPrNumber(args.number, 'number')
  const maxComments = guardByteCount(args.maxComments, 'maxComments', 50, 5, 200)
  const forceRefresh = args.forceRefresh === true
  const { signal } = args

  const runtime = buildRuntime(ctx, options)
  const { subprocess, fetchImpl, cache, api } = runtime
  const token = await runtime.resolveToken()
  const state = {
    issue: null,
    comments: [],
    routes: { meta: null, comments: null },
    notes: [],
  }

  if (options.routes.api) {
    try {
      const attempt = await attemptLadder(
        (proxy) =>
          api.getJson(`/repos/${owner}/${repo}/issues/${number}`, {
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
      state.issue = shapeApiIssue(attempt.value, owner, repo, number)
      state.routes.meta = 'api'
      rateNote(attempt.value._headers, state.notes)
    } catch (error) {
      state.notes.push(`api issue: ${String(error && error.message ? error.message : error).slice(0, 220)}`)
    }
  }

  if (state.issue !== null) {
    try {
      const attempt = await attemptLadder(
        (proxy) =>
          api.getJson(`/repos/${owner}/${repo}/issues/${number}/comments`, {
            token,
            signal,
            proxy,
            cache,
            ttlMs: options.cacheTtlSeconds.meta,
            forceRefresh,
            fetchImpl,
            query: { per_page: 100 },
          }),
        options,
      )
      state.comments = capItems(
        (Array.isArray(attempt.value) ? attempt.value : []).map((c) => ({
          kind: 'comment',
          author: c.user && c.user.login ? c.user.login : null,
          createdAt: c.created_at ?? null,
          body: truncateText(c.body ?? '', BODY_CAP).text,
          url: c.html_url ?? null,
        })),
        maxComments,
        state.notes,
        'comments',
      )
      state.routes.comments = 'api'
    } catch (error) {
      state.notes.push(`api comments: ${String(error && error.message ? error.message : error).slice(0, 180)}`)
    }
  }

  if (options.routes.gh && subprocess !== undefined && (state.issue === null || state.comments.length === 0)) {
    let ghUsable = false
    try {
      ghUsable = (await ghVersion(subprocess, signal)) && (await ghAuthed(subprocess, signal))
    } catch { ghUsable = false }
    if (ghUsable) {
      try {
        const g = await ghIssueView(subprocess, owner, repo, number, { signal })
        if (state.issue === null) {
          state.issue = shapeGhIssue(g, owner, repo, number)
          state.routes.meta = 'gh'
        }
        if (state.comments.length === 0 && Array.isArray(g.comments)) {
          state.comments = capItems(
            g.comments.map((c) => ({
              kind: 'comment',
              author: c.author && c.author.login ? c.author.login : null,
              createdAt: c.createdAt ?? null,
              body: truncateText(c.body ?? '', BODY_CAP).text,
              url: c.url ?? null,
            })),
            maxComments,
            state.notes,
            'comments',
          )
          state.routes.comments = 'gh'
        }
      } catch (error) {
        state.notes.push(`gh issue view: ${String(error && error.message ? error.message : error).slice(0, 180)}`)
      }
    } else {
      state.notes.push('gh route skipped: gh CLI not installed or not authenticated')
    }
  }

  if (options.routes.html && (state.issue === null || state.comments.length === 0)) {
    try {
      await attemptLadder(
        async (proxy) => {
          const parsed = await fetchAndParsePage(owner, repo, number, 'issues', {
            fetchImpl,
            proxy,
            signal,
            timeoutMs: proxy !== undefined ? options.proxyTimeoutMs : options.directTimeoutMs,
          })
          if (state.issue === null && parsed.issue !== null) {
            state.issue = { ...parsed.issue, owner, repo, number }
            state.routes.meta = 'html'
          }
          if (state.comments.length === 0 && parsed.discussion.length > 0) {
            state.comments = capItems(parsed.discussion, maxComments, state.notes, 'comments')
            state.routes.comments = 'html'
          }
        },
        options,
        { proxyFirst: true },
      )
    } catch (error) {
      state.notes.push(`html page: ${String(error && error.message ? error.message : error).slice(0, 220)}`)
    }
  }

  if (state.issue === null) {
    return {
      error: `all GitHub routes failed to load issue ${owner}/${repo}#${number}`,
      routes: state.routes,
      notes: state.notes,
    }
  }
  return { issue: state.issue, comments: state.comments, routes: state.routes, notes: state.notes }
}
