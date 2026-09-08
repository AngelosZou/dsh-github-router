/**
 * Offline argv contracts for the gh route.
 *
 * No gh binary, no network: a stub subprocess records the exact argv arrays
 * the plugin would spawn. This is the regression guard for the
 * `owner/repo/N` positional bug (issue #1) — `gh issue view` accepts only a
 * bare number or a URL, and `gh pr view` / `gh pr diff` would resolve that
 * shape as a local branch name.
 * @module dsh-github-router/test/gh-argv
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ghAuthed,
  ghIssueView,
  ghPrDiff,
  ghPrView,
  ghRepoView,
  ghVersion,
} from '../lib/routes/gh.js'

const OWNER = 'AngelosZou'
const REPO = 'dsh-github-router'
const NUMBER = 7
const SLUG = `${OWNER}/${REPO}`

/** Stub subprocess that records argv and returns fixed stdout. */
function recorder() {
  const argv = []
  const reader = (text) => ({ readFrom: () => ({ text, lossy: false }) })
  const subprocess = {
    spawn(spec) {
      argv.push([...spec.argv])
      const body = spec.argv.includes('diff') ? 'diff --git a/x b/x' : '{}'
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: { stdout: reader(body), stderr: reader('') },
      }
    },
  }
  return { argv, subprocess }
}

/** The buggy shape: one argv element that reads owner/repo/N. */
const REPO_NUMBER_POSITIONAL = /^[^/\s]+\/[^/\s]+\/\d+$/

describe('gh route argv', () => {
  it('issue view: bare number positional plus --repo', async () => {
    const { argv, subprocess } = recorder()
    await ghIssueView(subprocess, OWNER, REPO, NUMBER)
    assert.equal(argv.length, 1)
    const a = argv[0]
    assert.deepEqual(a.slice(0, 6), ['gh', 'issue', 'view', String(NUMBER), '--repo', SLUG])
    assert.equal(a[6], '--json')
    assert.match(a[7], /(^|,)title(,|$)/)
    assert.match(a[7], /(^|,)url(,|$)/)
  })

  it('pr view: bare number positional plus --repo', async () => {
    const { argv, subprocess } = recorder()
    await ghPrView(subprocess, OWNER, REPO, NUMBER)
    assert.equal(argv.length, 1)
    const a = argv[0]
    assert.deepEqual(a.slice(0, 6), ['gh', 'pr', 'view', String(NUMBER), '--repo', SLUG])
    assert.equal(a[6], '--json')
    assert.match(a[7], /(^|,)title(,|$)/)
    assert.match(a[7], /(^|,)url(,|$)/)
  })

  it('pr diff: bare number positional plus --repo', async () => {
    const { argv, subprocess } = recorder()
    const out = await ghPrDiff(subprocess, OWNER, REPO, NUMBER)
    assert.equal(argv.length, 1)
    assert.deepEqual(argv[0], ['gh', 'pr', 'diff', String(NUMBER), '--repo', SLUG])
    assert.equal(out.text, 'diff --git a/x b/x')
  })

  it('repo view keeps owner/repo positional and takes no --repo flag', async () => {
    const { argv, subprocess } = recorder()
    await ghRepoView(subprocess, OWNER, REPO)
    assert.equal(argv.length, 1)
    const a = argv[0]
    assert.deepEqual(a.slice(0, 4), ['gh', 'repo', 'view', SLUG])
    assert.equal(a[4], '--json')
    assert.ok(!a.includes('--repo'))
  })

  it('stringifies numeric input instead of interpolating a slug', async () => {
    const { argv, subprocess } = recorder()
    await ghIssueView(subprocess, OWNER, REPO, 7)
    await ghPrView(subprocess, OWNER, REPO, 7)
    await ghPrDiff(subprocess, OWNER, REPO, 7)
    for (const a of argv) assert.equal(typeof a[3], 'string')
    assert.deepEqual(argv.map((a) => a[3]), ['7', '7', '7'])
  })

  it('never passes owner/repo/N as any argv element', async () => {
    const { argv, subprocess } = recorder()
    await ghIssueView(subprocess, OWNER, REPO, NUMBER)
    await ghPrView(subprocess, OWNER, REPO, NUMBER)
    await ghPrDiff(subprocess, OWNER, REPO, NUMBER)
    await ghRepoView(subprocess, OWNER, REPO)
    for (const a of argv) {
      for (const arg of a) {
        assert.ok(!REPO_NUMBER_POSITIONAL.test(arg), `repo/number leaked into one argv element: "${arg}"`)
      }
    }
  })

  it('probe invocations stay fixed', async () => {
    const { argv, subprocess } = recorder()
    await ghVersion(subprocess)
    await ghAuthed(subprocess)
    assert.deepEqual(argv, [['gh', '--version'], ['gh', 'auth', 'status']])
  })
})
