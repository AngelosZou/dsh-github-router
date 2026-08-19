/**
 * `github_file` — read-only file content with api/raw/mirror/git routing.
 * @module dsh-github-router/tools/file
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { aggregateFile } from '../core/file.js'
import { renderFile } from '../render.js'
import { sessionCwd } from '../util.js'

export function registerFileTool(ctx, options) {
  ctx.tools.register(
    defineTool({
      name: 'github_file',
      description:
        'Read a file (or directory listing) from a GitHub repository READ-ONLY. Routes internally: api.github.com contents → raw.githubusercontent.com (direct/proxy) → user-configured mirrors (off by default) → git protocol (plugin fetch cache, or a local clone via localRepo/session cwd). Returns the content with size, truncation state, and the route that served it. Directories return their entry list.',
      parameters: {
        owner: { type: 'string', description: 'Repository owner (user or org).' },
        repo: { type: 'string', description: 'Repository name.' },
        path: { type: 'string', description: 'Repository-relative file or directory path, e.g. "src/index.js".' },
        ref: { type: 'string', description: 'Branch, tag, or full commit sha (default "HEAD").' },
        maxBytes: { type: 'number', description: 'Content cap in bytes, 4096..8388608 (default 262144).' },
        localRepo: { type: 'string', description: 'Optional path to a local clone; content is read via git show without network.' },
        forceRefresh: { type: 'boolean', description: 'Bypass the plugin cache and re-fetch (default false).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => renderFile(value),
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          return await aggregateFile(ctx, options(), {
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
        title: `github_file ${args && args.owner ? args.owner : '?'}/${args && args.repo ? args.repo : '?'}${args && args.path ? ' ' + args.path : ''}`,
      }),
    }),
  )
}
