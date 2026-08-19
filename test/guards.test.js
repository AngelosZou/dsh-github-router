import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  guardApiPath,
  guardByteCount,
  guardFilePath,
  guardOwnerRepo,
  guardPrNumber,
  guardRef,
  ownerRepoFromUrl,
  sha1,
  truncateText,
} from '../lib/util.js'

describe('guardOwnerRepo', () => {
  it('accepts valid names', () => {
    assert.equal(guardOwnerRepo('octocat', 'owner'), 'octocat')
    assert.equal(guardOwnerRepo('Hello-World_v2.0', 'repo'), 'Hello-World_v2.0')
  })
  it('rejects injection attempts', () => {
    assert.throws(() => guardOwnerRepo('a/b', 'owner'))
    assert.throws(() => guardOwnerRepo('a b', 'owner'))
    assert.throws(() => guardOwnerRepo('a@b', 'owner'))
    assert.throws(() => guardOwnerRepo('..', 'owner'))
    assert.throws(() => guardOwnerRepo('', 'owner'))
  })
})

describe('guardPrNumber', () => {
  it('accepts positive integers', () => assert.equal(guardPrNumber(42), 42))
  it('rejects junk', () => {
    assert.throws(() => guardPrNumber(0))
    assert.throws(() => guardPrNumber(-1))
    assert.throws(() => guardPrNumber(1.5))
    assert.throws(() => guardPrNumber('x'))
  })
})

describe('guardApiPath', () => {
  it('accepts plain api paths', () => {
    assert.equal(guardApiPath('/repos/o/r/pulls/1'), '/repos/o/r/pulls/1')
    assert.equal(guardApiPath('/rate_limit'), '/rate_limit')
  })
  it('rejects traversal, spaces, and non-api shapes', () => {
    assert.throws(() => guardApiPath('repos/o/r'))
    assert.throws(() => guardApiPath('/repos/../x'))
    assert.throws(() => guardApiPath('/repos/o/r?foo=bar'))
    assert.throws(() => guardApiPath('/repos/o/r#x'))
    assert.throws(() => guardApiPath('/a b'))
    assert.throws(() => guardApiPath('/a%2e%2e/b'))
  })
})

describe('guardFilePath', () => {
  it('accepts repo-relative paths', () => assert.equal(guardFilePath('src/a b/c.js'), 'src/a b/c.js'))
  it('rejects absolute paths and traversal', () => {
    assert.throws(() => guardFilePath('/etc/passwd'))
    assert.throws(() => guardFilePath('../x'))
    assert.throws(() => guardFilePath('a/../../b'))
    assert.throws(() => guardFilePath(''))
  })
})

describe('guardRef', () => {
  it('accepts branches, tags, shas', () => {
    assert.equal(guardRef('main'), 'main')
    assert.equal(guardRef('release/1.0'), 'release/1.0')
    assert.equal(guardRef('a'.repeat(40)), 'a'.repeat(40))
  })
  it('rejects git-option injection shapes', () => {
    assert.throws(() => guardRef('--help'))
    assert.throws(() => guardRef('a..b'))
    assert.throws(() => guardRef('a^b'))
    assert.throws(() => guardRef('a~b'))
  })
})

describe('guardByteCount', () => {
  it('falls back and clamps', () => {
    assert.equal(guardByteCount(undefined, 'x', 10, 1, 100), 10)
    assert.equal(guardByteCount(50, 'x', 10, 1, 100), 50)
    assert.throws(() => guardByteCount(0, 'x', 10, 1, 100))
    assert.throws(() => guardByteCount(1000, 'x', 10, 1, 100))
  })
})

describe('ownerRepoFromUrl', () => {
  it('parses common remote shapes', () => {
    assert.deepEqual(ownerRepoFromUrl('https://github.com/o/r.git'), { owner: 'o', repo: 'r' })
    assert.deepEqual(ownerRepoFromUrl('https://github.com/o/r'), { owner: 'o', repo: 'r' })
    assert.deepEqual(ownerRepoFromUrl('git@github.com:o/r.git'), { owner: 'o', repo: 'r' })
    assert.deepEqual(ownerRepoFromUrl('ssh://git@github.com/o/r.git'), { owner: 'o', repo: 'r' })
  })
  it('rejects non-github remotes', () => {
    assert.equal(ownerRepoFromUrl('https://gitlab.com/o/r'), null)
    assert.equal(ownerRepoFromUrl('not a url'), null)
  })
})

describe('sha1 / truncateText', () => {
  it('hashes deterministically', () => {
    assert.equal(sha1('x'), sha1('x'))
    assert.notEqual(sha1('x'), sha1('y'))
  })
  it('truncates at a byte boundary and marks it', () => {
    const t = truncateText('hello world', 5)
    assert.equal(t.text, 'hello')
    assert.equal(t.truncated, true)
    const u = truncateText('abc', 100)
    assert.equal(u.text, 'abc')
    assert.equal(u.truncated, false)
  })
})
