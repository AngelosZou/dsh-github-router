# dsh-github-router

**English** | [中文](README.zh.md)

> Read-only GitHub access for a DeepSeek Harness project — load PRs, issues, files, and API data through tools that route internally (API, gh CLI, git protocol, page HTML, mirrors), so an agent never burns turns fighting shell-side TLS or proxy failures.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20.18](https://img.shields.io/badge/Node.js-%3E%3D20.18-brightgreen)](https://nodejs.org/)
[![npm version](https://img.shields.io/npm/v/dsh-github-router)](https://www.npmjs.com/package/dsh-github-router)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin bundle that gives agents GitHub reads without shell retries:

- **Five read-only tools** — `github_probe`, `github_pr`, `github_issue`, `github_file`, `github_api` — plus the `github-router` skill and a system-prompt guidance section. No write, push, comment, or mutation capability exists anywhere in the package.
- **In-tool routing** — every request runs host-side (outside the sandbox's TLS/proxy restrictions) and falls through a route ladder: `api.github.com` (direct → proxy) → `gh` CLI (read-only subcommands) → git protocol (plugin fetch cache, or a local clone read with log/diff/show only) → PR/issue page HTML (strict JSON island extraction) → user-configured raw mirrors.
- **One call, structured outcome** — PRs come back with metadata, discussion, reviews, commits, changed files, and the diff, each part annotated with the route that served it; failures return a route matrix instead of a dozen retried shell commands.
- **Connectivity probe** — `github_probe` reports which routes are live from the host in one call, with timings and a recommended route chain.
- **Zero runtime dependencies** — peers resolve from the DSH profile; proxied requests travel through the plugin's own CONNECT tunnel (no third-party HTTP stack), so the package installs fully offline.
- **Settings page** — an independent Settings entry ("GitHub Router", like the 通知 section): the `dsh-github-router` settings namespace (secret token, proxy, route switches, cache TTLs, byte caps) with staged edits, save/discard, and override badges.
- **Context efficiency** — response caching with per-kind TTLs, byte caps everywhere, list caps with truncation notes, and rate-limit surfacing.

## Requirements

- Node.js >= 20.18
- A DSH profile composed from `@deepseek-ai/dsh-base` (it provides the `tools`, `subprocess`, `skills`, `settings`, and `credentials` services the plugin uses)
- Optional: the `gh` CLI (authenticated) for the gh route; `git` for the git route

## Install

From npm:

```bash
dsh plugin --profile web add dsh-github-router
```

From a local checkout (development):

```bash
dsh plugin --profile web add link:<absolute-path-to-this-repo>
```

From a git host:

```bash
dsh plugin --profile web add github:<owner>/dsh-github-router
```

Then **restart the DSH backend** — the host composition loads at process start. The tools appear in new sessions: `github_probe`, `github_pr`, `github_issue`, `github_file`, `github_api`, plus the `github-router` skill.

## Usage

Agent side:

| Tool | What it does |
| ---- | ------------ |
| `github_probe` | One-shot connectivity matrix (api direct/proxy, gh installed/authed, git ls-remote, page direct/proxy, mirrors, token presence) with timings and a recommended route chain. Call first when access fails or is slow. |
| `github_pr` | Full PR view: metadata, description, discussion (issue + inline review comments), reviews, commits, changed files, and the unified diff, each with route attribution. Parts toggle (`includeDiscussion`/`includeReviews`/`includeCommits`/`includeFiles`/`includeDiff`) and cap (`maxDiffBytes`/`maxItems`). `localRepo` (or session-cwd auto-detection) reads commits/diff from a local clone with zero network. |
| `github_issue` | Issue metadata, body, labels, and comments, with route attribution. |
| `github_file` | File content (or directory listing) at a branch/tag/sha via api contents → raw → mirrors → git; returns size, truncation state, and the serving route. |
| `github_api` | Validated **GET-only** escape hatch for any `api.github.com` endpoint; query values sanitized, responses cached, rate-limit headers surfaced, errors carry stable codes. |

```text
github_probe                                                  # which routes are live right now
github_pr { owner: "o", repo: "r", number: 12 }               # full PR view
github_pr { owner: "o", repo: "r", number: 12, localRepo: "C:/src/r" }  # commits/diff from a local clone
github_issue { owner: "o", repo: "r", number: 34 }
github_file { owner: "o", repo: "r", path: "src/index.js", ref: "main" }
github_api { path: "/repos/o/r/commits", query: { per_page: 5 } }
```

Behavior notes:

- Route order is fixed per part type: API first (direct then proxy), then gh, then page HTML (proxy-first — machines with reset direct TLS usually reach pages through the proxy), then git, then mirrors. Each part records the route that served it.
- Anonymous API use is rate-limited (60 requests/hour per IP); configure a token (Settings or `GITHUB_TOKEN`) for 5000/hour. Responses are cached to save quota; `forceRefresh` bypasses the cache.
- Mirrors are **off by default** — they are third parties that see requested paths; enable them in settings only if you accept that.
- The git route never writes to user repositories: local clones are read with `git log`/`diff`/`show` only, and fetches happen exclusively in the plugin-owned cache under `<DSH_HOME>/storages/dsh-github-router/`.

## Configuration

Settings → **GitHub Router** opens an independent settings page (a nav
entry registered into `settings.section`, the same mechanism as the 通知
section): edits are staged locally and written only on save, fields
overridden by the user are badged, and blank fields fall back to the
defaults below. The same values can be set in the composition (profile
`cordis.patch.yml`) as the plugin's base config; the Settings UI overrides
per user.

| Field | Default | Meaning |
| --- | --- | --- |
| `token` | — | Literal GitHub token (secret; redacted on the wire, write-only input). Prefer `tokenEnv`. |
| `tokenEnv` | `GITHUB_TOKEN` | Environment variable / credential ref naming the token. |
| `proxy` | `''` | Proxy URL for proxy attempts. `''` inherits ambient `HTTP(S)_PROXY`; `direct` never proxies. |
| `directTimeoutMs` / `proxyTimeoutMs` | 8000 / 15000 | Per-attempt timeouts. |
| `retries` | 1 | Retries for idempotent GETs on 429/5xx (honors `Retry-After`). |
| `routesApi` / `routesGh` / `routesGit` / `routesHtml` / `routesMirror` | on / on / on / on / **off** | Route switches (the card shows them as checkboxes). |
| `mirrors` | `[]` | Raw-content mirror bases, e.g. `["https://ghproxy.net"]`. |
| `cacheTtlMeta` / `cacheTtlContent` | 300 / 86400 | Response cache TTLs (PR/issue metadata vs immutable-ish content), in seconds. |
| `maxBytes` | 1048576 | Byte cap for every response body read by the plugin. |
| `repos` | `[]` | Local repositories granted for read-only git-route reads. |
| `gitCacheDir` | `''` | Plugin fetch-cache dir; `''` = `<DSH_HOME>/storages/dsh-github-router/git`. |

## How it works

- **Host-side execution** — plugin code runs in the host process, so the sandbox's TLS credential resets and proxy misrouting never apply. The unrestricted token is compensated by the confinement model in [SECURITY.md](SECURITY.md) — not by weakening the sandbox.
- **Explicit proxy decisions** — global `fetch` does not inherit ambient proxy env; each attempt gets an explicit direct/proxy choice, and proxied requests use a zero-dependency CONNECT tunnel (`node:http`/`node:tls`) with target-hostname TLS validation and `accept-encoding: identity`.
- **Strict parsing** — the page-HTML route extracts only `react-app.embeddedData` JSON islands and runs `JSON.parse` (never evaluated); a bounded BFS copies a whitelist of fields, so CSRF tokens and the raw payload never reach the model.
- **Argv-only subprocesses** — every `gh`/`git` invocation is an argv array with fixed flag lists; user input reaches argv only after regex validation, and nothing is shell-interpolated.
- **Tool contract** — canonical values are lossless JSON (arrays carry no side properties), byte-capped, and rendered as compact text with route attribution.
- **Skill & guidance** — the `github-router` skill teaches tool-first usage and the "never escalate for GitHub reads" rule; one system-prompt section (`dsh-github-router:guidance`, order 118) reminds every session that the github_* tools are the sanctioned path.

## Project layout

| Path | Purpose |
| ---- | ------- |
| `cordis.patch.yml` | Profile patch layer inserting the `dsh-github-router` row |
| `lib/index.js` | Host plugin: settings section, five tools, skill, guidance |
| `lib/client.js` | Browser half: the independent Settings page (hand-written factory bundle, no build step) |
| `lib/config.js` | Settings schema, defaults, runtime option resolution |
| `lib/net.js`, `lib/tunnel.js` | Route-aware HTTP layer; zero-dependency CONNECT proxy tunnel |
| `lib/routes/` | One module per route: `api` (GET-only REST), `gh` (CLI), `git` (protocol), `html` (page parse), `mirror` (raw mirrors) |
| `lib/core/` | Per-call runtime assembly and the `pr`/`issue`/`file`/`probe` aggregators |
| `lib/tools/` | The five model tools |
| `lib/cache.js`, `lib/render.js`, `lib/util.js` | TTL cache, text renderers, guards and shaping |
| `lib/skill.js`, `lib/guidance.js` | Skill content and prompt-injection section |
| `test/` | Runtime-free behavior tests (see Development) |
| `docs/` | Design and analysis documents |

## Development

No build step: the plugin is plain ESM and the tests run with Node directly
(a mock ctx stands in for the DSH services; the real `defineTool` validates
every schema):

```bash
npm test
# or: node --test --test-isolation=none "test/*.test.js"
```

The tests are fully offline — they cover JSON-island extraction, input
guards, URL builders, the TTL cache, commit-log parsing, the tunnel request
head, and the apply() wiring. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development loop, including offline peer resolution.

## Security

Read-only by construction: no write verb exists, tokens attach only to
`api.github.com` and are redacted on every boundary, page payloads are
whitelist-extracted, and the only disk writes are the two plugin-owned
caches under `<DSH_HOME>/storages/dsh-github-router/`. See
[SECURITY.md](SECURITY.md) for the complete threat model and mitigation
list.

## Documentation

- [docs/design.md](docs/design.md) — architecture, route ladder, cache and confinement model, known limitations
- [SECURITY.md](SECURITY.md) — threat model and compensating controls
- [CHANGELOG.md](CHANGELOG.md) — release history

## License

MIT
