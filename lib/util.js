/**
 * Shared helpers: session cwd, subprocess execution (argv arrays only),
 * input validation guards, and text shaping.
 * @module dsh-github-router/util
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const STORAGE_DIR = join(DSH_HOME, 'storages', 'dsh-github-router')
export const CACHE_DIR = join(STORAGE_DIR, 'cache')
export const GIT_CACHE_DIR = join(STORAGE_DIR, 'git')

/** Session workspace cwd, with a process-cwd fallback. */
export function sessionCwd(exec) {
  const header = exec && exec.agent && exec.agent.session && exec.agent.session.header
  if (header && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
  return process.cwd()
}

export function sha1(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex')
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isAbortError(error) {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error !== null && typeof error === 'object' && error.name === 'AbortError')
  )
}

// ------------------------------------------------------------------ guards

/** GitHub owner/repo names: alphanumerics plus . _ -, not empty. */
const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function guardOwnerRepo(value, label) {
  const text = String(value ?? '')
  if (text.length === 0 || text.length > 100 || !OWNER_REPO_RE.test(text)) {
    throw new Error(`${label} must be a valid GitHub owner or repository name (got "${text}")`)
  }
  return text
}

export function guardPrNumber(value, label = 'number') {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 100_000_000) {
    throw new Error(`${label} must be a positive integer (got "${String(value)}")`)
  }
  return n
}

/**
 * api.github.com relative paths only: starts with '/', no query/fragment,
 * no control characters or spaces, no '..' segments. GET only — enforced
 * by the client, which has no other verbs.
 */
const API_PATH_RE = /^\/[A-Za-z0-9._~%/-]*$/

export function guardApiPath(path) {
  const text = String(path ?? '')
  if (text.length === 0 || text.length > 2048 || !API_PATH_RE.test(text)) {
    throw new Error(`path must be a plain api.github.com relative path starting with "/" (got "${text}")`)
  }
  if (text.split('/').includes('..') || text.includes('%2e%2e') || text.toLowerCase().includes('%2e%2e')) {
    throw new Error(`path must not contain ".." segments (got "${text}")`)
  }
  return text
}

/**
 * Repo file path: relative, no leading slash, no ".." segments, no control
 * characters, bounded length. It is passed to subprocesses as a single argv
 * element (never interpolated into a shell command).
 */
const FILE_PATH_RE = /^[^\u0000-\u001f\u007f\\:*?"<>|]+$/

export function guardFilePath(path) {
  const text = String(path ?? '')
  if (text.length === 0 || text.length > 1024) {
    throw new Error(`path must be a non-empty relative repository file path (got "${text}")`)
  }
  if (text.startsWith('/') || !FILE_PATH_RE.test(text)) {
    throw new Error(`path must be a relative repository file path without control characters (got "${text}")`)
  }
  if (text.split('/').includes('..')) {
    throw new Error(`path must not contain ".." segments (got "${text}")`)
  }
  return text
}

export function guardRef(value, label = 'ref') {
  const text = String(value ?? '').trim()
  if (text.length === 0 || text.length > 512 || text.startsWith('-') || /[\u0000-\u001f\u007f~^:?*[\\]/.test(text) || text.includes('..')) {
    throw new Error(`${label} must be a plain git ref name (branch, tag, or full commit sha) (got "${text}")`)
  }
  return text
}

export function guardByteCount(value, label, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max} (got "${String(value)}")`)
  }
  return n
}

// -------------------------------------------------------------- subprocess

const DEFAULT_STDOUT_CAP = 1_048_576
const DEFAULT_STDERR_CAP = 262_144

/**
 * Run one subprocess to completion through the platform subprocess service
 * (host token — the same channel the pyenv/graphlint plugins use), with
 * argv arrays and no shell interpolation anywhere.
 * @returns { exitCode, ok, timedOut, stdout: {text, truncated}, stderr: {...}, spawnError }
 */
export async function runCaptured(subprocess, spec) {
  const {
    argv,
    cwd,
    env,
    graceMs = 15_000,
    signal,
    maxStdout = DEFAULT_STDOUT_CAP,
    maxStderr = DEFAULT_STDERR_CAP,
    onSpawn,
  } = spec
  let handle
  try {
    handle = subprocess.spawn({
      argv,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(env !== undefined ? { env } : {}),
      stdio: { stdin: 'ignore', stdout: { maxBytes: maxStdout }, stderr: { maxBytes: maxStderr } },
      graceMs,
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error) {
    return { exitCode: null, ok: false, timedOut: false, spawnError: String(error && error.message ? error.message : error), stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }
  }
  if (onSpawn !== undefined) onSpawn(handle)
  let outcome
  try {
    outcome = await handle.done
  } catch (error) {
    return { exitCode: null, ok: false, timedOut: false, spawnError: String(error && error.message ? error.message : error), stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }
  }
  const shape = (reader) => {
    if (reader === undefined || reader === null) return { text: '', truncated: false }
    const read = reader.readFrom(0)
    return { text: typeof read.text === 'string' ? read.text : '', truncated: !!read.lossy }
  }
  const exitCode = outcome.exitCode === undefined || outcome.exitCode === null ? null : outcome.exitCode
  return {
    exitCode,
    ok: exitCode === 0,
    timedOut: outcome.exitCode === null || outcome.exitCode === undefined,
    spawnError: null,
    stdout: shape(handle.collected && handle.collected.stdout),
    stderr: shape(handle.collected && handle.collected.stderr),
  }
}

/** Env for read-only git/gh children: never prompts, no color, plus the ambient env. */
export function childEnv(extra) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    NO_COLOR: '1',
    ...extra,
  }
}

// ---------------------------------------------------------------- shaping

/** Byte-bounded truncation with a marker; lossless for inputs under the cap. */
export function truncateText(text, maxBytes) {
  const s = String(text ?? '')
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return { text: s, truncated: false }
  return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&#x27;': "'",
}

/** Crude tag-strip for bodies extracted from page payloads (display only). */
export function stripHtml(html) {
  let text = String(html ?? '')
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/p>/gi, '\n')
  text = text.replace(/<li[^>]*>/gi, '\n- ')
  text = text.replace(/<[^>]+>/g, '')
  text = text.replace(/&(amp|lt|gt|quot|apos|nbsp|#39|#x27);/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m)
  text = text.replace(/\u00a0/g, ' ')
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

// --------------------------------------------------------------- git urls

/**
 * Extract { owner, repo } from common GitHub remote URL shapes.
 * Returns null when the URL does not look like a GitHub repo remote.
 */
export function ownerRepoFromUrl(url) {
  const text = String(url ?? '').trim().replace(/\\/g, '/')
  let match
  match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(text)
  if (match) return { owner: match[1], repo: match[2] }
  match = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(text)
  if (match) return { owner: match[1], repo: match[2] }
  match = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(text)
  if (match) return { owner: match[1], repo: match[2] }
  return null
}
