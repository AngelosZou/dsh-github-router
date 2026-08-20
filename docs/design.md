# Design

This document describes the architecture of dsh-github-router: the route
ladder, the per-route semantics, the caching and confinement model, the
tool contract, and the known limitations.

## Goals

1. **Read GitHub without shell retries.** The DSH shell sandbox frequently
   breaks GitHub access (TLS credential resets, proxy misrouting); agents
   burn many turns retrying `curl`/`gh`/`git` variants. Every GitHub read
   should be one tool call with a structured outcome.
2. **Route inside the tool.** The healthy path varies over time and per
   endpoint — a typical hostile-network matrix has `api.github.com`
   reachable directly while `github.com` page fetches time out direct and
   only work through a proxy. The plugin must try routes in a fixed,
   documented order and report which one served each part.
3. **Strictly read-only.** No write, push, comment, or mutation verb
   exists. This is a security property, not a roadmap item.
4. **Installable offline.** Zero runtime dependencies: peers resolve from
   the DSH profile, and proxied requests use a self-contained CONNECT
   tunnel instead of a third-party HTTP stack.

## Layers

```
lib/tools/*   defineTool wrappers: validation → core aggregate → render
lib/core/*    per-call runtime (cache, token, transport) + aggregators
lib/routes/*  transport adapters (api, gh, git, html, mirror)
lib/net.js    direct fetch + retry/backoff + error taxonomy
lib/tunnel.js zero-dependency CONNECT proxy client
lib/cache.js  TTL JSON cache (atomic writes, tolerant reads)
```

Tools never speak HTTP; routes never speak `defineTool`. The core
aggregators own the ladder and the per-part attribution.

## Route ladder

Order is fixed per part type and documented in the tool descriptions:

| Part | Ladder |
| --- | --- |
| PR/issue metadata, reviews, files, comments | api → gh → html |
| PR commits / diff | api → gh → git (local clone, then fetch cache) |
| Discussion (timeline items) | api → gh → html |
| File content | api contents → raw → mirrors → git |
| Diagnostics | `github_probe` runs every route once, in parallel |

`attemptLadder` walks direct → proxy for api/raw and proxy → direct for
page HTML. The inversion for HTML is empirical: machines whose direct TLS
to `github.com` is reset usually still reach pages through a working proxy,
while `api.github.com` is more often reachable directly. `effectiveProxy`
resolves the explicit setting, then the ambient `HTTP(S)_PROXY`
environment, then none.

### api route

GET-only client over `api.github.com`. Paths, query keys, and values are
validated before URL construction; the token attaches only here. Non-2xx
responses map to stable codes (`AUTH_REQUIRED`, `RATE_LIMITED`,
`NOT_FOUND`, `HTTP`). Caching keys on the canonical URL with per-kind TTLs
(metadata 300 s, content 86400 s); `forceRefresh` bypasses reads and
refreshes writes.

### gh route

Used only when `gh --version` and `gh auth status` both succeed. The only
subcommands ever constructed are `gh api <path>` (GET) and the `--json`
viewers (`pr view`, `issue view`, `repo view`) plus `pr diff`; JSON field
lists are constants, so user input reaches argv only as validated
owner/repo/number/path values. `gh` uses its own stored credentials — the
plugin token is never passed to it.

### git route

Two strictly separated modes:

- **Fetch cache** — a plugin-owned repo under
  `<DSH_HOME>/storages/dsh-github-router/git/` fetches
  `refs/pull/N/{head,merge}` (shallow), plus branch/HEAD/sha fetches for
  the file tool. `merge^1..head` yields commits and the PR diff; a missing
  merge ref degrades to head-only history with a note. Fetches to one repo
  are serialized by an in-process mutex.
- **Local reads** — user-granted repos (the `repos` setting, an explicit
  `localRepo` argument, or the session cwd when its origin matches the
  requested owner/repo) are read with `rev-parse`/`log`/`merge-base`/
  `diff`/`show` **only**. The plugin never fetches into, checks out,
  resets, or pushes to a user repository. PR refs are looked up as
  `refs/pull/N/{merge,head}`, then `refs/remotes/origin/{pull/N/*, pr/N}`.

### html route

Fetches the PR/issue page and extracts only
`<script type="application/json" data-target="react-app.embeddedData">`
islands via `JSON.parse` — never evaluated. A bounded BFS (depth 10,
≤ 40k nodes) collects whitelisted shapes: a PR/issue root
(number + title + state + body), and `timelineItems`/`reviewThreads`
nodes mapped to comment/review/review-comment entries. Bodies are
tag-stripped for display and byte-capped; CSRF tokens, sessions, and the
raw payload never leave this module.

### mirror route

Off by default: mirrors are third parties that see requested paths and can
substitute bytes. When enabled, each configured base yields two candidates
per file (raw passthrough and the `github.com` `/raw/` route), tried in
order.

## Settings card

The Host registers the `dsh-github-router` settings namespace on the
official settings seam (durable document, schema validation, revision
fencing, `applies: 'live'`). The browser half (`lib/client.js`, a
hand-written ModuleLoader factory bundle with no build step) registers one
plugin configuration CARD into the `settings.plugin.item` slot keyed by the
namespace — the framework's mechanism for plugins distributed outside the
repository (DSH ≥ 0.1.0-rc.7): the Settings → Plugins configurable tab
reads which namespaces the Host serves and dispatches the intersection of
that ledger and the registered cards, so the card appears only when the
namespace is registered and served.

### Framework transport

Since DSH 0.1.0-rc.7 the api-proxy serves every registered settings
namespace (the earlier `WEB_SETTINGS_NAMESPACES` allowlist and its
`settings-not-exposed` answer retired in PR #2404), so the card binds the
namespace through the framework settings transport:
`ctx.settingsScope.bind({ namespace })` returns a `SettingsScope` whose
snapshot carries the redacted resolved section
(`status`/`value`/`base`/`user`/`revision`/`writable`). All consumers
derive from one shared describe mirror, so reads never block activation,
writes carry revision fencing and recovery re-reads, and the mirror
refreshes on `settings/document-updated` and `connection/reset` — a Host
restart no longer strands the form in a failed state. No plugin-owned HTTP
route exists.

### Card form

Edits are staged locally and written only on save, one field per
`scope.set`/`scope.unset`; after each write the card verifies the user
layer (JSON-shaped deep equality) and keeps drafts that did not land.
Secret fields never ride a response, so the token control is write-only:
its configured state comes from the describe mirror's secret slot list
(the snapshot itself redacts it from every layer), a typed value writes the
token through `settings.mutate` (the one direction secrets cross the wire),
and a blank draft clears a configured one.

Because the scope writes **scalar fields by name**, the settings schema is
deliberately flat (`routesApi`, `cacheTtlMeta`, …); the Host projects it
into the nested runtime shape (`routes.api`, `cacheTtlSeconds.meta`) in
`resolveOptions`. The composition layer can still carry the same flat
keys. The card shows the common fields up top (token, proxy, main route
switches) and the long tail (timeouts, retries, cache TTLs, mirrors,
repos, git cache dir) in a collapsed "Advanced settings" disclosure.

## Cache

`TtlCache` stores `{v, ts, ttlMs, value}` per canonical URL under
`<DSH_HOME>/storages/dsh-github-router/cache/`. Writes are tmp+rename
(atomic); corrupt or expired entries degrade to misses. Cache entries carry
rate-limit headers so successful reads surface remaining quota without an
extra request. An in-memory layer avoids disk churn for repeated hits
within one host process.

## Confinement

- **Host-side execution** is the point of the plugin (the sandbox's TLS
  failures do not apply), and is compensated by construction: no write
  verb, whitelist parsing, byte caps, argv-only subprocesses.
- **Disk writes** happen only under `<DSH_HOME>/storages/dsh-github-router/`
  (response cache + fetch cache). User repositories are read-only targets
  and require explicit grant.
- **Secrets** — the token attaches only to api.github.com; the settings
  schema marks it `role('secret')` (redacted on every wire boundary,
  write-only input); proxy credentials are stripped from error text.

## Tool contract

- Execute returns lossless JSON: no `undefined`-valued fields, and arrays
  carry no enumerable side properties (this bit `github_api` list
  endpoints in 0.1.0 and is covered by the `JSON.parse(JSON.stringify(...))`
  round-trip in the tool body).
- Every tool declares `isConcurrencySafe: () => true` (pure reads; cache
  writes commute) and a cooperative `timeoutMs`; execute forwards
  `exec.signal` to fetches and subprocesses.
- Renders are compact text with per-part route attribution; list caps
  append "showing N of M" notes instead of silently dropping entries.

## Known limitations

- **Fallback routes are unexercised while the API is healthy.** The ladder
  is failover, not fan-out: when api succeeds, gh/html/git are not called
  (saving quota). Forcing a specific route per call is not yet supported.
- **Anonymous quota is shared per IP** (60 req/h). A PR aggregation costs
  up to six calls. Token configuration is the intended mitigation; the
  cache is the second line.
- **The HTML route depends on GitHub's page layout.** The extraction is
  shape-based (whitelisted fields, not fixed paths), but a major page
  redesign may require updating the matchers. It is a fallback, never the
  primary route.
- **Rate-limit notes on list endpoints.** Array responses carry no side
  metadata (lossless-JSON requirement), so `github_api` list calls do not
  surface remaining quota; object endpoints do.
