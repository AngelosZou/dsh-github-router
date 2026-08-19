/**
 * One compact system-prompt guidance section (the 100–129 tool-guidance
 * band): GitHub reads go through the github_* tools, not the shell.
 * @module dsh-github-router/guidance
 */

const SECTION_NAME = 'dsh-github-router:guidance'
const SECTION_ORDER = 118

const GUIDANCE_TEXT =
  'GitHub reads (PR / issue / file / API data) should go through the github_* tools provided by the dsh-github-router plugin: ' +
  'github_pr, github_issue, github_file, github_api, and github_probe for connectivity diagnosis. ' +
  'Do not fight shell-side GitHub failures (curl / gh / git / Invoke-WebRequest) with retries or sandbox escalation — ' +
  'the shell sandbox commonly breaks GitHub TLS/proxy access, while the tools run host-side and route internally ' +
  '(api.github.com → gh CLI → git protocol → page HTML parse → configured mirrors), returning per-part route attribution in one call. ' +
  'All github_* tools are read-only: they never write, push, comment, or mutate anything.'

export function registerGuidance(ctx) {
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: () => GUIDANCE_TEXT,
  })
}
