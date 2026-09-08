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

  // GitHub's current pull-request page embeds baseBranch/headBranch/headSha/
  // createdTime/mergedTime instead of the GraphQL-style field names above.
  const PR_PAGE_CURRENT = `<!doctype html><html><head>
<script type="application/json" data-target="react-app.embeddedData">{"payload":{"pullRequestsLayoutRoute":{"pullRequest":{"number":14391,"title":"Bump deps","state":"OPEN","author":{"login":"dependabot"},"baseBranch":"trunk","headBranch":"dependabot/go_modules/x-0.23.0","headSha":"20c599bb3e8acf889c86d35b2ed9889a663f1a49","createdTime":"2026-09-08T14:03:00Z","mergedTime":null,"commitsCount":1}}}}</script>
</head><body></body></html>`

  it('maps the current page payload field names', () => {
    const pr = prFromPayloads(extractEmbeddedData(PR_PAGE_CURRENT))
    assert.ok(pr !== null)
    assert.equal(pr.title, 'Bump deps')
    assert.equal(pr.author, 'dependabot')
    assert.equal(pr.state, 'OPEN')
    assert.equal(pr.baseRef, 'trunk')
    assert.equal(pr.headRef, 'dependabot/go_modules/x-0.23.0')
    assert.equal(pr.headSha, '20c599bb3e8acf889c86d35b2ed9889a663f1a49')
    assert.equal(pr.createdAt, '2026-09-08T14:03:00Z')
    assert.equal(pr.mergedAt, null)
    assert.equal(pr.body, '')
    assert.equal(pr.additions, null)
  })

  it('maps mergedTime when the pull request is merged', () => {
    const html = PR_PAGE_CURRENT.replace('"mergedTime":null', '"mergedTime":"2026-09-08T12:10:28Z"').replace('"state":"OPEN"', '"state":"MERGED"')
    const pr = prFromPayloads(extractEmbeddedData(html))
    assert.equal(pr.mergedAt, '2026-09-08T12:10:28Z')
    assert.equal(pr.state, 'MERGED')
  })

  it('prefers the node reachable under the pullRequest key', () => {
    const html = `<script type="application/json" data-target="react-app.embeddedData">{"payload":{"pullRequest":{"number":7,"title":"Rich","headBranch":"x","additions":5,"baseBranch":"main"},"other":{"number":7,"title":"Noise","headBranch":"y","baseBranch":"main"}}}</script>`
    const pr = prFromPayloads(extractEmbeddedData(html))
    assert.equal(pr.title, 'Rich')
    assert.equal(pr.additions, 5)
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
