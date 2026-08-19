import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  discussionFromPayloads,
  extractEmbeddedData,
  issueFromPayloads,
  prFromPayloads,
  walkJson,
} from '../lib/routes/html.js'
import { stripHtml } from '../lib/util.js'

const PR_PAGE = `<!doctype html><html><head>
<script type="application/json" data-target="react-app.embeddedData">{"payload":{"preloadedQueries":[{"result":{"data":{"repository":{"pullRequest":{"number":42,"title":"Fix routing","bodyHTML":"<p>Hello <b>world</b></p>","state":"OPEN","author":{"login":"octocat"},"additions":12,"deletions":3,"changedFiles":4,"createdAt":"2026-01-01T00:00:00Z","baseRefName":"main","headRefName":"fix-routing","baseRefOid":"abc123","headRefOid":"def456"}}}}}]}}</script>
<script type="application/json" data-target="react-app.embeddedData">{"payload":{"preloadedQueries":[{"result":{"data":{"repository":{"pullRequest":{"number":42,"timelineItems":{"nodes":[{"__typename":"IssueComment","author":{"login":"reviewer"},"createdAt":"2026-01-02T00:00:00Z","bodyHTML":"<p>LGTM</p>"},{"__typename":"PullRequestReview","author":{"login":"maintainer"},"submittedAt":"2026-01-03T00:00:00Z","state":"APPROVED","body":"<p>Ship it</p>"}]}}}}}}]}}</script>
<script type="application/json" data-target="other">not json at all {{{</script>
<script type="text/javascript">var x = 1; // must never be parsed or executed</script>
</head><body><h1>page</h1></body></html>`

describe('extractEmbeddedData', () => {
  it('parses application/json islands and skips everything else', () => {
    const objects = extractEmbeddedData(PR_PAGE)
    assert.equal(objects.length, 2) // the invalid JSON island and the JS script are skipped
    assert.ok(Array.isArray(objects[0].payload.preloadedQueries))
  })

  it('never evaluates anything', () => {
    const evil = '<script type="application/json" data-target="react-app.embeddedData">{"a":1,"toString":{"$":"x"}}</script>'
    const objects = extractEmbeddedData(evil)
    assert.equal(objects.length, 1)
    assert.equal(objects[0].a, 1)
  })
})

describe('walkJson', () => {
  it('is cycle-safe and depth-bounded', () => {
    const a = { name: 'a' }
    a.self = a
    const hits = walkJson(a, (k, v) => k === 'name', { maxDepth: 5, maxNodes: 100 })
    assert.equal(hits.length, 1)
  })

  it('respects maxNodes', () => {
    const big = { list: Array.from({ length: 500 }, (_, i) => ({ i })) }
    const hits = walkJson(big, () => true, { maxDepth: 10, maxNodes: 50 })
    assert.ok(hits.length <= 51)
  })
})

describe('prFromPayloads', () => {
  it('finds the PR node and shapes it', () => {
    const objects = extractEmbeddedData(PR_PAGE)
    const pr = prFromPayloads(objects)
    assert.ok(pr !== null)
    assert.equal(pr.title, 'Fix routing')
    assert.equal(pr.body, 'Hello world')
    assert.equal(pr.author, 'octocat')
    assert.equal(pr.additions, 12)
    assert.equal(pr.baseRef, 'main')
    assert.equal(pr.headRef, 'fix-routing')
  })
})

describe('issueFromPayloads', () => {
  it('returns null when no issue is present', () => {
    assert.equal(issueFromPayloads(extractEmbeddedData(PR_PAGE)), null)
  })

  it('extracts an issue', () => {
    const html = '<script type="application/json" data-target="react-app.embeddedData">{"payload":{"repository":{"issue":{"number":7,"title":"Broken link","bodyHTML":"<p>see docs</p>","state":"OPEN","author":{"login":"alice"}}}}}</script>'
    const issue = issueFromPayloads(extractEmbeddedData(html))
    assert.equal(issue.title, 'Broken link')
    assert.equal(issue.body, 'see docs')
  })
})

describe('discussionFromPayloads', () => {
  it('maps timeline nodes to whitelisted shapes', () => {
    const objects = extractEmbeddedData(PR_PAGE)
    const items = discussionFromPayloads(objects)
    assert.equal(items.length, 2)
    assert.deepEqual(items[0], { kind: 'comment', author: 'reviewer', createdAt: '2026-01-02T00:00:00Z', body: 'LGTM', url: null })
    assert.equal(items[1].kind, 'review')
    assert.equal(items[1].state, 'APPROVED')
  })
})

describe('stripHtml', () => {
  it('strips tags and decodes basic entities', () => {
    assert.equal(stripHtml('<p>A &amp; B &#39;c&#39;</p><br/>next'), "A & B 'c'\n\nnext")
  })
})
