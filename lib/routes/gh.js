/**
 * gh CLI route. Only read-only subcommands are ever constructed here:
 * `gh --version`, `gh auth status`, `gh api` (GET by default), and the
 * `--json` viewers (`pr view`, `issue view`, `repo view`). JSON field lists
 * are fixed constants — user input never reaches argv beyond validated
 * owner/repo/number/path values, and nothing is ever passed through a shell.
 * @module dsh-github-router/routes/gh
 */
import { childEnv, runCaptured } from '../util.js'

const PR_FIELDS =
  'author,title,body,state,isDraft,mergedAt,additions,deletions,changedFiles,' +
  'createdAt,updatedAt,baseRefName,headRefName,headRefOid,baseRefOid,' +
  'mergeable,reviewDecision,reviews,comments,commits,files'
const ISSUE_FIELDS = 'author,title,body,state,stateReason,createdAt,updatedAt,closedAt,comments,labels,assignees'
const REPO_FIELDS = 'nameWithOwner,description,defaultBranchRef,stargazerCount,forkCount,updatedAt,licenseInfo,isPrivate'

export async function ghVersion(subprocess, signal) {
  const out = await runCaptured(subprocess, { argv: ['gh', '--version'], graceMs: 8_000, signal, env: childEnv(), maxStdout: 4096, maxStderr: 4096 })
  return out.ok
}

export async function ghAuthed(subprocess, signal) {
  const out = await runCaptured(subprocess, { argv: ['gh', 'auth', 'status'], graceMs: 8_000, signal, env: childEnv(), maxStdout: 8192, maxStderr: 8192 })
  return out.ok
}

/** Run a fixed gh invocation and parse its JSON stdout. */
async function ghJson(subprocess, argv, spec = {}) {
  const out = await runCaptured(subprocess, {
    argv,
    graceMs: spec.graceMs ?? 30_000,
    signal: spec.signal,
    env: childEnv(),
    maxStdout: spec.maxStdout ?? 1048576,
    maxStderr: 262144,
  })
  if (!out.ok) {
    const err = new Error(`gh exited with code ${out.exitCode}: ${out.stderr.text.slice(0, 400)}`)
    err.code = 'GH_FAILED'
    throw err
  }
  try {
    return JSON.parse(out.stdout.text)
  } catch (error) {
    const err = new Error(`gh produced unprocessable JSON: ${String(error && error.message ? error.message : error)}`)
    err.code = 'GH_FAILED'
    throw err
  }
}

/** `gh pr view <owner/repo/N> --json ...` */
export async function ghPrView(subprocess, owner, repo, number, spec = {}) {
  return ghJson(subprocess, ['gh', 'pr', 'view', `${owner}/${repo}/${number}`, '--json', PR_FIELDS], spec)
}

/** `gh pr diff <owner/repo/N>` — capped text of the PR diff. */
export async function ghPrDiff(subprocess, owner, repo, number, spec = {}) {
  const out = await runCaptured(subprocess, {
    argv: ['gh', 'pr', 'diff', `${owner}/${repo}/${number}`],
    graceMs: 30_000,
    signal: spec.signal,
    env: childEnv(),
    maxStdout: spec.maxStdout ?? 1048576,
    maxStderr: 262144,
  })
  if (!out.ok) {
    const err = new Error(`gh pr diff exited with code ${out.exitCode}: ${out.stderr.text.slice(0, 400)}`)
    err.code = 'GH_FAILED'
    throw err
  }
  return { text: out.stdout.text, truncated: out.stdout.truncated }
}

/** `gh issue view <owner/repo/N> --json ...` */
export async function ghIssueView(subprocess, owner, repo, number, spec = {}) {
  return ghJson(subprocess, ['gh', 'issue', 'view', `${owner}/${repo}/${number}`, '--json', ISSUE_FIELDS], spec)
}

/** `gh repo view <owner/repo> --json ...` */
export async function ghRepoView(subprocess, owner, repo, spec = {}) {
  return ghJson(subprocess, ['gh', 'repo', 'view', `${owner}/${repo}`, '--json', REPO_FIELDS], spec)
}

/**
 * `gh api <path>` — GET only, with the validated api path as a single argv
 * element. Output is parsed as JSON when possible, else returned as text.
 */
export async function ghApi(subprocess, path, spec = {}) {
  const out = await runCaptured(subprocess, {
    argv: ['gh', 'api', path],
    graceMs: 30_000,
    signal: spec.signal,
    env: childEnv(),
    maxStdout: spec.maxStdout ?? 1048576,
    maxStderr: 262144,
  })
  if (!out.ok) {
    const err = new Error(`gh api exited with code ${out.exitCode}: ${out.stderr.text.slice(0, 400)}`)
    err.code = 'GH_FAILED'
    throw err
  }
  const text = out.stdout.text
  try {
    return { json: JSON.parse(text), truncated: out.stdout.truncated }
  } catch {
    return { json: null, text, truncated: out.stdout.truncated }
  }
}
