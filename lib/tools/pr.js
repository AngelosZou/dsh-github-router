/**
 * `github_pr` — one call to load a pull request across every route:
 * api.github.com → gh CLI → page HTML parse → git protocol. Returns
 * metadata, discussion, reviews, commits, changed files, and the diff with
 * per-part route attribution. Read-only; no write capability exists.
 * @module dsh-github-router/tools/pr
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { aggregatePr } from '../core/pr.js'
import { renderPr } from '../render.js'
import { sessionCwd } from '../util.js'

export function registerPrTool(ctx, options) {
  ctx.tools.register(
    defineTool({
      name: 'github_pr',
      description:
        'Load a GitHub pull request READ-ONLY across every available route, internally routing api.github.com (direct/proxy) → gh CLI → the PR page HTML (strict JSON embeddedData parse) → git protocol (plugin fetch cache or a local clone), and returning metadata, description, discussion/review comments, reviews, commits, changed files, and the diff with per-part route attribution. Use this instead of shell curl/gh/git for PR reads — it never writes, pushes, or comments, and one call replaces many failed shell attempts. Parts can be toggled (includeDiscussion/includeReviews/includeCommits/includeFiles/includeDiff) and capped (maxDiffBytes/maxItems). When the local machine already has the repository cloned and fetched, pass localRepo (or the session cwd is auto-detected) to read commits/diff from the local clone with zero network.',
      parameters: {
        owner: { type: 'string', description: 'Repository owner (user or org), e.g. "octocat".' },
        repo: { type: 'string', description: 'Repository name, e.g. "Hello-World".' },
        number: { type: 'number', description: 'Pull request number.' },
        includeDiscussion: { type: 'boolean', description: 'Include issue comments and inline review comments (default true).' },
        includeReviews: { type: 'boolean', description: 'Include formal review summaries (default true).' },
        includeCommits: { type: 'boolean', description: 'Include the commit list (default true).' },
        includeFiles: { type: 'boolean', description: 'Include the changed-files list (default true).' },
        includeDiff: { type: 'boolean', description: 'Include the unified diff (default true).' },
        maxDiffBytes: { type: 'number', description: 'Cap for the diff in bytes, 4096..1048576 (default 65536).' },
        maxItems: { type: 'number', description: 'Cap per list (discussion/reviews/commits/files), 5..200 (default 50).' },
        localRepo: { type: 'string', description: 'Optional path to a local clone of the repo; commits/diff are read from it (log/diff/show only — never fetched, never written).' },
        forceRefresh: { type: 'boolean', description: 'Bypass the plugin cache and re-fetch (default false).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => renderPr(value),
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          return await aggregatePr(ctx, options(), {
            ...(args ?? {}),
            cwd: sessionCwd(exec),
            signal: exec && exec.signal,
          })
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `github_pr ${args && args.owner ? args.owner : '?'}/${args && args.repo ? args.repo : '?'}${args && args.number ? '#' + args.number : ''}`,
      }),
    }),
  )
}
