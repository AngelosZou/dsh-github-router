/**
 * The `github-router` skill: teaches the agent to use the github_* tools
 * instead of shell curl/gh/git for GitHub reads, and how to diagnose
 * connectivity with one probe call.
 * @module dsh-github-router/skill
 */

const SKILL = {
  name: 'github-router',
  description:
    'Read GitHub repositories through the github_* tools (probe, pr, issue, file, api) with internal multi-route fallback (API, gh CLI, git protocol, page HTML, mirrors) — read-only, never writes or pushes.',
  whenToUse:
    'When a task needs GitHub data (PR review, issue triage, file inspection, repo metadata) and especially when shell-side curl / gh / git / Invoke-WebRequest fails with TLS, proxy, or permission errors.',
  source: 'custom',
  invocation: { modelInvocable: true, userInvocable: true },
  content: `# github-router

## Use the tools
- \`github_probe\` — one call reports which routes are live (api direct/proxy, gh CLI, git, page HTML, mirrors) with timings and a recommendation. Call it FIRST when GitHub access fails or is slow; do not retry shell commands.
- \`github_pr\` — load a pull request: metadata, description, discussion (issue + inline review comments), reviews, commits, changed files, and the unified diff. Toggle parts with includeDiscussion/includeReviews/includeCommits/includeFiles/includeDiff and cap sizes with maxDiffBytes / maxItems. Pass \`localRepo\` (or rely on session-cwd auto-detection) to read commits/diff from a local clone with zero network.
- \`github_issue\` — load an issue with body, labels, and comments.
- \`github_file\` — read one file (or list a directory) at a branch/tag/sha; returns content, size, truncation state, and the serving route.
- \`github_api\` — READ-ONLY escape hatch: any api.github.com GET path (e.g. /repos/o/r/commits). Always GET; there is no write verb.

## Why not curl / gh / git in a shell
The DSH shell sandbox frequently breaks GitHub access (TLS credential resets, proxy misrouting, permission errors), and retrying costs many turns. The github_* tools run in the host process and route internally: api.github.com → gh CLI → git protocol → PR/issue page HTML parse → user-configured mirrors, returning per-part route attribution and failure notes in ONE call. Do NOT escalate sandbox permissions for GitHub reads — call the tools.

## Reviewing a PR (the common case)
1. \`github_pr\` for the full picture (meta + discussion + commits + files + diff).
2. \`github_file\` for specific files at the PR head sha when the diff cap is too small.
3. \`github_probe\` when everything failed, to see which routes are live before any retry.
For PRs in a local clone, pass \`localRepo\` pointing at the checkout — commits/diff then come from local git with no network at all.

## Security and limits
- Every tool is read-only: no writes, pushes, comments, or mutations exist anywhere in the plugin.
- Anonymous API use is rate-limited (60 requests/hour per IP); configure a GitHub token in Settings → Plugins → dsh-github-router (token or GITHUB_TOKEN env) for 5000/hour. Responses are cached to save quota.
- Mirrors are OFF by default (third parties see requested paths); enable them in settings only if you accept that.
- Token values are redacted in all tool output.
`,
}

export function registerSkill(ctx) {
  ctx.skills.register(SKILL)
}
