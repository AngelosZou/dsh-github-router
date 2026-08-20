/**
 * dsh-github-router — DeepSeek Harness plugin for READ-ONLY GitHub access.
 *
 * Plugin code runs in the host process, so it is free of the sandbox's
 * shell-side TLS/proxy failures — which is exactly why the routing lives
 * inside the tools. The unrestricted token is compensated with a strict
 * security posture:
 *
 * 1. Five read-only tools (github_probe / github_pr / github_issue /
 *    github_file / github_api). There is no write, push, comment, or
 *    mutation verb anywhere in this package.
 * 2. Every network call is a GET with an explicit direct/proxy decision per
 *    attempt (ambient proxy env is not blindly inherited); subprocess calls
 *    are argv arrays — no shell interpolation.
 * 3. api.github.com paths, repo file paths, refs, owners, and query values
 *    are validated before use; tokens are attached only to api.github.com
 *    and redacted from every output; page HTML is parsed by strict JSON
 *    island extraction (JSON.parse only, never evaluated).
 * 4. Plugin-owned state (fetch cache, response cache) lives under
 *    <DSH_HOME>/storages/dsh-github-router; user repositories are only ever
 *    read (log/diff/show) and only when explicitly granted.
 * 5. Configuration rides the official settings seam end to end
 *    (`dsh-github-router` namespace: durable document, schema validation,
 *    revision fencing). Since DSH 0.1.0-rc.7 the framework serves every
 *    registered settings namespace to the browser and renders the plugin's
 *    configuration card in Settings → Plugins, so no plugin-owned HTTP
 *    route exists.
 * @module dsh-github-router
 */
import { installSettings } from './settings.js'
import { registerGuidance } from './guidance.js'
import { registerSkill } from './skill.js'
import { registerApiTool } from './tools/api.js'
import { registerFileTool } from './tools/file.js'
import { registerIssueTool } from './tools/issue.js'
import { registerPrTool } from './tools/pr.js'
import { registerProbeTool } from './tools/probe.js'

export const name = 'dsh-github-router'
export const inject = ['tools', 'subprocess', 'skills', 'systemPrompt']

export function apply(ctx, config = {}) {
  const options = installSettings(ctx, config).options

  registerSkill(ctx)
  registerGuidance(ctx)
  registerProbeTool(ctx, options)
  registerPrTool(ctx, options)
  registerIssueTool(ctx, options)
  registerFileTool(ctx, options)
  registerApiTool(ctx, options)
}
