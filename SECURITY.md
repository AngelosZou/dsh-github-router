# SECURITY.md

`dsh-github-router` runs **host-side with the host token** — unrestricted by
the agent's sandbox. That freedom is compensated by construction-level
constraints documented here.

## Threat model

The hostile inputs are: (1) agent-supplied tool arguments, (2) remote
GitHub responses (API JSON, git output, HTML pages, file bytes), and (3)
the configured proxy/mirrors (which see request URLs). The agent is assumed
untrusted for argument content; GitHub itself is assumed untrusted for
response content.

## Hard constraints

### 1. Read-only by construction

- The plugin contains **no write verb**. There is no POST/PATCH/PUT/DELETE,
  no body, no push/checkout/reset/merge into user repositories, no comment
  or reaction endpoints. `github_api` accepts only a validated relative
  path and always performs GET.
- The only disk writes are: the TTL response cache and the git fetch cache,
  both under `<DSH_HOME>/storages/dsh-github-router`. A user repository is
  never fetched into — local clones are read with `git log`/`diff`/`show`/
  `rev-parse`/`config --get` only, and only when the user granted the path
  (`repos` setting), passed `localRepo`, or the session cwd's origin
  matches the requested owner/repo.
- Code review note: if a future change adds any mutating capability, it
  must be its own tool behind an explicit user-facing consent surface.

### 2. No shell interpolation

Every subprocess (`gh`, `git`) is spawned as an **argv array** through the
platform subprocess service. Nothing is concatenated into a shell command
string, so argument injection (spaces, `;`, `|`, `--flags`) cannot escape
the argv element. User-derived values reach argv only after validation:

- `owner`/`repo`: `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`
- `number`: positive integer
- api path: starts `/`, no `..`, no spaces/control chars, ≤ 2048 chars
- file path: relative, no `..`, no control chars, ≤ 1024 chars
- ref: plain name/sha, rejects leading `-`, `..`, `~^:*?[]`, ≤ 512 chars
- query values: short strings without control chars, finite numbers,
  booleans; ≤ 20 entries

### 3. Token handling

- The token is attached **only** to `api.github.com` requests (never to
  proxies, mirrors, raw hosts, or the gh CLI — gh uses its own stored
  auth).
- Settings declare the token with `role('secret')`: it is redacted at every
  wire boundary, rendered as a write-only input, and never returned in tool
  output. No output path carries it: tool results contain only parsed
  payload fields, and failure notes carry error messages that never echo
  request headers; proxy URLs in error text are credential-stripped.
- Resolution order: literal setting → credentials service
  (`credentialRef(tokenEnv)`) → environment variable. Nothing is logged.

### 4. Page HTML parsing is JSON-only

The PR/issue page route extracts only
`<script type="application/json" data-target="react-app.embeddedData">`
islands and runs **`JSON.parse`** on them — never `eval`, `Function`, or
any executable interpretation. Extraction is a bounded BFS (depth 10, ≤
40k nodes) that copies a whitelist of fields (title, body text, state,
author, dates, review/discussion items) and drops everything else — CSRF
tokens, session data, and the raw payload never reach the model. Bodies
are HTML-tag-stripped for display and byte-capped.

### 5. Proxy and mirrors

- Global `fetch` does **not** inherit ambient proxy env automatically; each
  attempt gets an explicit proxy decision (`direct` first for API/raw,
  `proxy` first for page HTML), so a broken ambient proxy cannot silently
  hijack traffic.
- Proxied requests travel through the plugin's own zero-dependency CONNECT
  tunnel (node:http/tls): TLS is validated against the target hostname
  exactly as direct requests validate it, the request carries
  `accept-encoding: identity`, and every body passes the same byte cap.
  No third-party HTTP stack is involved.
- Mirrors are **off by default**: they are third parties that see the
  requested repo/path and can substitute bytes. Enabling them in settings
  is an explicit user decision. Mirror responses pass through the same
  byte caps as every other route.

### 6. Response containment

- Every response body (API JSON, HTML, raw files, git stdout) is
  byte-capped (`maxBytes`, default 1 MiB); oversized bodies truncate with
  an explicit marker.
- Non-2xx API responses are classified into stable codes
  (`AUTH_REQUIRED`, `RATE_LIMITED`, `NOT_FOUND`, `HTTP`, `TRANSPORT`,
  `TIMEOUT`, `ABORTED`) so failures are cheap to reason about.
- Cache files are parsed defensively: corrupt or expired entries are
  dropped as misses; writes are tmp+rename (torn files degrade to a miss).

## Residual risks

- **Rate limits**: anonymous API use shares the host IP's 60 req/h quota.
  Configure a token (Settings) to raise it to 5000 req/h; the cache is the
  second line of defense.
- **git fetch cache growth**: repeated fetches grow the cache dir; it is
  shallow (`--depth`), and users may delete it at any time — it rebuilds
  on demand.
- **Mirrors/proxies see URLs**: enabling mirrors or a proxy reveals which
  repos/files are requested. Off by default; opt-in.
- **gh CLI surface**: only fixed subcommands are constructed, but `gh api
  <path>` inherits gh's own scoped token permissions; paths are validated
  and the method is GET, yet an account-scoped token with broad grants
  could still read beyond the public surface. Prefer the API route with
  the plugin token when least-privilege matters.
