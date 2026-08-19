/**
 * PR/issue page HTML route.
 *
 * SECURITY: pages are parsed with JSON.parse ONLY, applied to exact
 * `<script type="application/json">` islands (react-app.embeddedData).
 * Nothing is ever evaluated or executed. Extraction walks the parsed JSON
 * with a bounded BFS and copies a whitelist of fields (title, body text,
 * state, author, dates, review/discussion items) — CSRF tokens, sessions,
 * and everything else in the payload are dropped on the floor. Inputs and
 * every extracted text are byte-capped.
 * @module dsh-github-router/routes/html
 */
import { fetchText } from '../net.js'
import { stripHtml } from '../util.js'

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
const MAX_ISLAND_BYTES = 4194304
const MAX_WALK_DEPTH = 10
const MAX_WALK_NODES = 40000
const MAX_BODY_CHARS = 20000
const MAX_ITEMS = 60

/** Pull every application/json script island out of a GitHub HTML page. */
export function extractEmbeddedData(html) {
  const out = []
  const source = String(html ?? '').slice(0, MAX_ISLAND_BYTES)
  SCRIPT_RE.lastIndex = 0
  let match
  while ((match = SCRIPT_RE.exec(source)) !== null) {
    const attrs = match[1]
    const body = match[2]
    if (!/type\s*=\s*["']application\/json["']/i.test(attrs)) continue
    try {
      const parsed = JSON.parse(body)
      out.push(parsed)
    } catch { /* not a valid JSON island — skip, never evaluate */ }
  }
  return out
}

/** Bounded BFS collecting { key, value } pairs matching a predicate. */
export function walkJson(root, predicate, options = {}) {
  const maxDepth = options.maxDepth ?? MAX_WALK_DEPTH
  const maxNodes = options.maxNodes ?? MAX_WALK_NODES
  const seen = new WeakSet()
  const hits = []
  let visited = 0
  const visit = (node, depth, key) => {
    // The predicate runs for every node — scalars included — so key-based
    // matchers see `{key: "scalar"}` entries too. The hits cap is checked
    // BEFORE pushing so scalar-heavy trees cannot blow past maxNodes.
    if (hits.length >= maxNodes) return
    if (predicate(key, node, depth)) hits.push({ key, value: node })
    if (node === null || typeof node !== 'object' || seen.has(node)) return
    if (visited >= maxNodes) return
    visited += 1
    seen.add(node)
    if (depth > maxDepth) return
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) visit(node[i], depth + 1, i)
    } else {
      for (const [k, v] of Object.entries(node)) visit(v, depth + 1, k)
    }
  }
  visit(root, 0, null)
  return hits
}

function isPrLike(node) {
  return (
    node !== null &&
    typeof node === 'object' &&
    Number.isInteger(node.number) &&
    typeof node.title === 'string' &&
    ('additions' in node || 'headRefName' in node || 'headRef' in node)
  )
}

function isIssueLike(node) {
  return (
    node !== null &&
    typeof node === 'object' &&
    Number.isInteger(node.number) &&
    typeof node.title === 'string' &&
    ('bodyHTML' in node || 'body' in node) &&
    !('additions' in node) &&
    !('headRefName' in node)
  )
}

function bodyOf(node, cap) {
  const raw = typeof node.bodyHTML === 'string' ? node.bodyHTML : typeof node.body === 'string' ? node.body : ''
  return stripHtml(raw).slice(0, cap)
}

function loginOf(node) {
  if (node && typeof node === 'object' && node.author && typeof node.author === 'object') {
    return typeof node.author.login === 'string' ? node.author.login : null
  }
  if (node && typeof node === 'object' && node.user && typeof node.user === 'object') {
    return typeof node.user.login === 'string' ? node.user.login : null
  }
  return null
}

/** Find the best PR-shaped node across all embedded JSON payloads. */
export function prFromPayloads(objects) {
  const candidates = []
  for (const obj of objects) {
    for (const { key, value } of walkJson(obj, (k, v) => isPrLike(v))) {
      candidates.push({ key, value })
    }
  }
  if (candidates.length === 0) return null
  // Prefer nodes reachable under a `pullRequest` key; then the richest shape.
  candidates.sort((a, b) => {
    const ak = a.key === 'pullRequest' ? 0 : 1
    const bk = b.key === 'pullRequest' ? 0 : 1
    if (ak !== bk) return ak - bk
    return b.value.title.length - a.value.title.length
  })
  const pr = candidates[0].value
  const refName = (v) => (v && typeof v === 'object' && typeof v.name === 'string' ? v.name : null)
  const shaOf = (v) => (v && typeof v === 'object' && typeof v.oid === 'string' ? v.oid : null)
  return {
    title: pr.title,
    body: bodyOf(pr, MAX_BODY_CHARS),
    state: typeof pr.state === 'string' ? pr.state : null,
    author: loginOf(pr),
    additions: typeof pr.additions === 'number' ? pr.additions : null,
    deletions: typeof pr.deletions === 'number' ? pr.deletions : null,
    changedFiles: typeof pr.changedFiles === 'number' ? pr.changedFiles : typeof pr.changed_files === 'number' ? pr.changed_files : null,
    createdAt: typeof pr.createdAt === 'string' ? pr.createdAt : null,
    updatedAt: typeof pr.updatedAt === 'string' ? pr.updatedAt : null,
    mergedAt: typeof pr.mergedAt === 'string' ? pr.mergedAt : typeof pr.merged_at === 'string' ? pr.merged_at : null,
    baseRef: typeof pr.baseRefName === 'string' ? pr.baseRefName : refName(pr.baseRef ?? pr.base),
    headRef: typeof pr.headRefName === 'string' ? pr.headRefName : refName(pr.headRef ?? pr.head),
    baseSha: typeof pr.baseRefOid === 'string' ? pr.baseRefOid : shaOf(pr.baseRef ?? pr.base),
    headSha: typeof pr.headRefOid === 'string' ? pr.headRefOid : shaOf(pr.headRef ?? pr.head),
    url: typeof pr.url === 'string' && /^https:\/\//.test(pr.url) ? pr.url : typeof pr.permalink === 'string' ? pr.permalink : null,
  }
}

/** Find the best issue-shaped node across all embedded JSON payloads. */
export function issueFromPayloads(objects) {
  const candidates = []
  for (const obj of objects) {
    for (const { key, value } of walkJson(obj, (k, v) => isIssueLike(v))) {
      candidates.push({ key, value })
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const ak = a.key === 'issue' ? 0 : 1
    const bk = b.key === 'issue' ? 0 : 1
    if (ak !== bk) return ak - bk
    return b.value.title.length - a.value.title.length
  })
  const issue = candidates[0].value
  return {
    title: issue.title,
    body: bodyOf(issue, MAX_BODY_CHARS),
    state: typeof issue.state === 'string' ? issue.state : null,
    stateReason: typeof issue.stateReason === 'string' ? issue.stateReason : null,
    author: loginOf(issue),
    createdAt: typeof issue.createdAt === 'string' ? issue.createdAt : null,
    updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : null,
    closedAt: typeof issue.closedAt === 'string' ? issue.closedAt : null,
    commentsCount: Number.isInteger(issue.commentsCount) ? issue.commentsCount : Number.isInteger(issue.comments?.totalCount) ? issue.comments.totalCount : null,
    url: typeof issue.url === 'string' && /^https:\/\//.test(issue.url) ? issue.url : null,
  }
}

function timelineItem(node) {
  if (node === null || typeof node !== 'object') return null
  const type = typeof node.__typename === 'string' ? node.__typename : null
  if (type === 'IssueComment') {
    return { kind: 'comment', author: loginOf(node), createdAt: node.createdAt ?? null, body: bodyOf(node, MAX_BODY_CHARS), url: node.url ?? null }
  }
  if (type === 'PullRequestReview') {
    return { kind: 'review', author: loginOf(node), createdAt: node.submittedAt ?? node.createdAt ?? null, state: node.state ?? null, body: bodyOf(node, MAX_BODY_CHARS), url: node.url ?? null }
  }
  if (type === 'PullRequestReviewThread' && Array.isArray(node.comments?.nodes)) {
    const items = []
    for (const c of node.comments.nodes) {
      if (c === null || typeof c !== 'object') continue
      items.push({ kind: 'review-comment', author: loginOf(c), createdAt: c.createdAt ?? null, body: bodyOf(c, MAX_BODY_CHARS), path: c.path ?? null, diffHunk: typeof c.diffHunk === 'string' ? c.diffHunk.slice(0, 4000) : null, url: c.url ?? null })
    }
    return items.length > 0 ? items : null
  }
  return null
}

/**
 * Discussion and review items from timelineItems / reviewThreads arrays in
 * the payloads. Only whitelisted shapes are copied.
 */
export function discussionFromPayloads(objects) {
  const items = []
  const seen = new Set()
  const considerNodes = (nodes) => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      const mapped = timelineItem(node)
      const list = Array.isArray(mapped) ? mapped : mapped !== null ? [mapped] : []
      for (const item of list) {
        const key = JSON.stringify(item)
        if (seen.has(key)) continue
        seen.add(key)
        items.push(item)
        if (items.length >= MAX_ITEMS) return
      }
      if (items.length >= MAX_ITEMS) return
    }
  }
  for (const obj of objects) {
    for (const { value } of walkJson(obj, (k, v) => (k === 'timelineItems' || k === 'reviewThreads') && v !== null && typeof v === 'object' && Array.isArray(v.nodes))) {
      considerNodes(value.nodes)
      if (items.length >= MAX_ITEMS) break
    }
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

/**
 * Fetch one PR/issue HTML page through the net layer and parse it.
 * Returns the parsed view or null when the page cannot be fetched/parsed.
 */
export async function fetchAndParsePage(owner, repo, number, kind, call) {
  const url = `https://github.com/${owner}/${repo}/${kind}/${number}`
  const raw = await call.fetchImpl(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'dsh-github-router/0.1.0',
    },
    timeoutMs: call.timeoutMs,
    proxy: call.proxy,
    signal: call.signal,
    maxBytes: 4194304,
    retries: 0,
  })
  if (!raw.ok) {
    const err = new Error(`GitHub page returned HTTP ${raw.status}`)
    err.code = 'HTTP'
    throw err
  }
  const objects = extractEmbeddedData(raw.body.toString('utf8'))
  return { objects, pr: prFromPayloads(objects), issue: issueFromPayloads(objects), discussion: discussionFromPayloads(objects) }
}
