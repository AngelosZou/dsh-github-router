/**
 * `github_issue` — read-only issue loading with the same route chain.
 * @module dsh-github-router/tools/issue
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { aggregateIssue } from '../core/issue.js'
import { renderIssue } from '../render.js'
import { sessionCwd } from '../util.js'

export function registerIssueTool(ctx, options) {
  ctx.tools.register(
    defineTool({
      name: 'github_issue',
      description:
        'Load a GitHub issue READ-ONLY, routing api.github.com (direct/proxy) → gh CLI → the issue page HTML parse internally, with metadata, body, labels, and comments plus per-part route attribution. Use instead of shell curl/gh for issue reads; never writes or comments.',
      parameters: {
        owner: { type: 'string', description: 'Repository owner (user or org).' },
        repo: { type: 'string', description: 'Repository name.' },
        number: { type: 'number', description: 'Issue number.' },
        maxComments: { type: 'number', description: 'Cap for comments, 5..200 (default 50).' },
        forceRefresh: { type: 'boolean', description: 'Bypass the plugin cache and re-fetch (default false).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => renderIssue(value),
      },
      timeoutMs: 90_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          return await aggregateIssue(ctx, options(), {
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
        title: `github_issue ${args && args.owner ? args.owner : '?'}/${args && args.repo ? args.repo : '?'}${args && args.number ? '#' + args.number : ''}`,
      }),
    }),
  )
}
