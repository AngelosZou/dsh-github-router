/**
 * Failover gating: the gh/html/git ladders must be entered only when a part
 * could NOT be fetched, never merely because a successfully-fetched part is
 * empty (issue #2). Fully offline: global fetch is stubbed and the subprocess
 * service records argv instead of spawning.
 * @module dsh-github-router/test/failover
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { aggregateIssue } from '../lib/core/issue.js'
import { aggregatePr } from '../lib/core/pr.js'
import { resolveOptions } from '../lib/config.js'

/** Recording subprocess stub with canned gh output. */
function recorder() {
  const spawns = []
  const reader = (text) => ({ readFrom: () => ({ text, lossy: false }) })
  const subprocess = {
    spawn(spec) {
      const argv = [...spec.argv]
      spawns.push(argv)
      let out = '{}'
      if (argv[1] === '--version') out = 'gh version 2.0.0'
      else if (argv[1] === 'auth') out = 'logged in'
      else if (argv[1] === 'issue') out = JSON.stringify({ number: 1, title: 't', state: 'OPEN', comments: [] })
      else if (argv[1] === 'pr' && argv[2] === 'view') out = JSON.stringify({ number: 1, title: 't', state: 'OPEN', reviews: [], comments: [], commits: [], files: [] })
      else if (argv[1] === 'pr' && argv[2] === 'diff') out = ''
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: reader(out), stderr: reader('') } }
    },
  }
  return { spawns, subprocess }
}

/** Stub global fetch: first matching pattern wins; functions may return status codes. */
function stubFetch(routes) {
  const urls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    urls.push(url)
    for (const [pattern, value] of routes) {
      if (!url.includes(pattern)) continue
      if (typeof value === 'function') {
        const { status, body } = value(url)
        return new Response(typeof body === 'string' ? body : JSON.stringify(body ?? {}), { status, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }
  const apiCalls = () => urls.filter((u) => u.includes('api.github.com'))
  const pageCalls = () => urls.filter((u) => u.includes('github.com') && !u.includes('api.github.com'))
  return { urls, apiCalls, pageCalls, restore: () => { globalThis.fetch = original } }
}

const ctxFor = (subprocess) => ({ get: (name) => (name === 'subprocess' ? subprocess : undefined) })

function opts(routes = {}) {
  const base = resolveOptions({})
  return { ...base, proxy: 'direct', retries: 0, routes: { ...base.routes, ...routes } }
}

const ghViewers = (spawns) => spawns.filter((a) => (a[1] === 'issue' || a[1] === 'pr') && a[2] === 'view').map((a) => a.join(' '))

const stubs = []
afterEach(() => {
  while (stubs.length > 0) stubs.pop().restore()
})

describe('issue failover gating', () => {
  it('does not enter the gh or html ladder when the API served an empty comment list', async () => {
    const { spawns, subprocess } = recorder()
    stubs.push(stubFetch([
      ['/issues/1/comments', []],
      ['/issues/1', { number: 1, title: 'No comments', state: 'open', body: 'b', user: { login: 'me' }, comments: 0, labels: [], html_url: 'u' }],
    ]))
    const r = await aggregateIssue(ctxFor(subprocess), opts(), { owner: 'o', repo: 'r', number: 1, forceRefresh: true })
    assert.equal(r.error, undefined)
    assert.deepEqual(r.routes, { meta: 'api', comments: 'api' })
    assert.deepEqual(r.notes.filter((n) => !n.startsWith('api rate limit')), [])
    assert.deepEqual(ghViewers(spawns), [], 'gh viewer must not be spawned for a legitimately empty part')
    assert.deepEqual(stubs[0].pageCalls(), [], 'page HTML must not be fetched for a legitimately empty part')
  })

  it('does not enter the ladders when the API served comments', async () => {
    const { spawns, subprocess } = recorder()
    stubs.push(stubFetch([
      ['/issues/1/comments', [{ user: { login: 'a' }, created_at: 'x', body: 'hi', html_url: 'u' }]],
      ['/issues/1', { number: 1, title: 'Has comments', state: 'open', body: 'b', user: { login: 'me' }, comments: 1, labels: [], html_url: 'u' }],
    ]))
    const r = await aggregateIssue(ctxFor(subprocess), opts(), { owner: 'o', repo: 'r', number: 1, forceRefresh: true })
    assert.deepEqual(r.routes, { meta: 'api', comments: 'api' })
    assert.equal(r.comments.length, 1)
    assert.deepEqual(ghViewers(spawns), [])
    assert.deepEqual(stubs[0].pageCalls(), [])
  })

  it('still enters the gh ladder when the comments fetch failed', async () => {
    const { spawns, subprocess } = recorder()
    stubs.push(stubFetch([
      ['/issues/1/comments', () => ({ status: 500, body: { message: 'boom' } })],
      ['/issues/1', { number: 1, title: 'Broken comments', state: 'open', body: 'b', user: { login: 'me' }, comments: 2, labels: [], html_url: 'u' }],
    ]))
    const r = await aggregateIssue(ctxFor(subprocess), opts(), { owner: 'o', repo: 'r', number: 1, forceRefresh: true })
    assert.equal(r.error, undefined)
    assert.equal(ghViewers(spawns).length, 1, 'gh viewer must run when the API comments read failed')
    assert.match(r.notes.join('\n'), /api comments:/)
  })
})

describe('pr failover gating', () => {
  const PR_META = {
    number: 1, title: 'PR', state: 'open', body: 'b', user: { login: 'me' }, html_url: 'u',
    additions: 1, deletions: 1, changed_files: 1, created_at: 'x', updated_at: 'y', merged_at: null,
    base: { ref: 'main', sha: 'aaa' }, head: { ref: 'topic', sha: 'bbb' },
  }
  const PR_ROUTES = [
    ['/pulls/1/files', [{ filename: 'a.txt', status: 'modified', additions: 1, deletions: 1 }]],
    ['/pulls/1/commits', [{ sha: 'abc', commit: { message: 'm', author: { name: 'n', date: 'd' } }, author: { login: 'me' } }]],
    ['/pulls/1/reviews', []],
    ['/pulls/1/comments', []],
    ['/issues/1/comments', []],
    ['/pulls/1', PR_META],
  ]

  it('does not enter the gh or html ladder when every part was served by the API', async () => {
    const { spawns, subprocess } = recorder()
    stubs.push(stubFetch(PR_ROUTES))
    const r = await aggregatePr(ctxFor(subprocess), opts(), { owner: 'o', repo: 'r', number: 1, forceRefresh: true })
    assert.equal(r.error, undefined)
    assert.deepEqual(r.routes, {
      meta: 'api', discussion: 'api', reviews: 'api', commits: 'api', files: 'api', diff: 'api',
    })
    assert.deepEqual(r.notes.filter((n) => !n.startsWith('api rate limit')), [])
    assert.deepEqual(ghViewers(spawns), [], 'gh viewer must not be spawned for legitimately empty parts')
    assert.deepEqual(stubs[0].pageCalls(), [], 'page HTML must not be fetched for legitimately empty parts')
  })

  it('still enters the gh ladder when a part fetch failed', async () => {
    const { spawns, subprocess } = recorder()
    stubs.push(stubFetch([
      ['/pulls/1/reviews', () => ({ status: 500, body: { message: 'boom' } })],
      ...PR_ROUTES,
    ]))
    const r = await aggregatePr(ctxFor(subprocess), opts(), { owner: 'o', repo: 'r', number: 1, forceRefresh: true })
    assert.equal(r.error, undefined)
    assert.equal(ghViewers(spawns).length, 1, 'gh viewer must run when a part fetch failed')
    assert.match(r.notes.join('\n'), /api reviews:/)
  })

  it('ignores parts the caller excluded', async () => {
    const { spawns, subprocess } = recorder()
    stubs.push(stubFetch(PR_ROUTES))
    const r = await aggregatePr(ctxFor(subprocess), opts(), {
      owner: 'o', repo: 'r', number: 1, forceRefresh: true,
      includeReviews: false, includeDiscussion: false,
    })
    assert.equal(r.error, undefined)
    assert.deepEqual(ghViewers(spawns), [])
  })
})
