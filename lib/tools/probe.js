/**
 * `github_probe` — the connectivity matrix. One call, no shell retries.
 * @module dsh-github-router/tools/probe
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { aggregateProbe } from '../core/probe.js'
import { renderProbe } from '../render.js'

export function registerProbeTool(ctx, options) {
  ctx.tools.register(
    defineTool({
      name: 'github_probe',
      description:
        'Probe every GitHub route once from the host side and report which ones are live (api.github.com direct/proxy, gh CLI installed/authed, git ls-remote, github.com page direct/proxy, mirrors, token presence) with timings and a recommended route chain. Call this first when GitHub access fails or is slow instead of retrying shell commands; read-only, short timeouts, no side effects.',
      parameters: {
        owner: { type: 'string', description: 'Optional repository owner to probe against.' },
        repo: { type: 'string', description: 'Optional repository name to probe against.' },
        prNumber: { type: 'number', description: 'Optional PR number; git-ls-remote then probes refs/pull/N/head.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => renderProbe(value),
      },
      timeoutMs: 90_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          return await aggregateProbe(ctx, options(), {
            ...(args ?? {}),
            _signal: exec && exec.signal,
          })
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'github_probe' + (args && args.owner ? ' ' + args.owner : ''),
      }),
    }),
  )
}
