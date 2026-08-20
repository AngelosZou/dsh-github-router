# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-21

### Changed

- **Migrated plugin configuration to the framework's plugin-settings mechanism** (requires DSH ≥ 0.1.0-rc.7, which serves every registered settings namespace and dispatches plugin-owned configuration cards). The browser half now registers a `settings.plugin.item` card keyed by the `dsh-github-router` namespace inside Settings → Plugins, bound through `ctx.settingsScope` (shared describe mirror, revision fencing, recovery reads, reconnect invalidation); the plugin-owned `/dsh-github-router/config` web routes and the standalone `settings.section` page are removed. The Host keeps the same `settings.register` seam and adds `applies: 'live'`.
- The token control is now a true write-only field: the configured state comes from the describe mirror's secret slot list (badge: "已配置/configured"), a typed value writes the token, and a blank save clears a configured one.
- Runtime requirements: the settings card needs DSH ≥ 0.1.0-rc.7; the Host-side settings seam alone still works on older compositions (tools resolve the composition config as before).

## [0.1.0] - 2026-08-19

First release.

### Added

- Five read-only model tools: `github_probe`, `github_pr`, `github_issue`, `github_file`, `github_api`
- In-tool route ladder: api.github.com (direct → CONNECT-tunnel proxy) → gh CLI (read-only subcommands) → git protocol (plugin fetch cache + read-only local repo reads) → PR/issue page HTML (strict `react-app.embeddedData` JSON extraction) → user-configured raw mirrors (off by default), with per-part route attribution on every result
- `github_probe` connectivity matrix with per-route timings and a recommended route chain
- TTL response cache with atomic writes and corruption-tolerant reads
- Settings: the `dsh-github-router` namespace on the official settings seam (secret token / `tokenEnv` credential ref, proxy, route switches, cache TTLs, byte caps, granted local repos), an independent Settings page (the dsh-notification `settings.section` mechanism; common fields up top, the long tail in a collapsed "Advanced settings" disclosure), and plugin-owned `/dsh-github-router/config` web routes (the dsh-market pattern) with same-origin enforcement and revision fencing
- `github-router` skill and a system-prompt guidance section (order 118)
- Zero runtime dependencies: zero-dependency CONNECT tunnel for proxied requests; peers resolve from the DSH profile
- 72 offline tests (`node --test`) covering extraction, guards, cache, tunnel, tool wiring, client bundle, config routes, and localization compliance
- Documentation: bilingual README, SECURITY, design notes, and a development guide

### Security

- Read-only by construction: no write/push/comment/mutation verb exists anywhere
- Tokens attach only to api.github.com and are redacted on every wire boundary
- Page HTML is parsed with `JSON.parse` only (never evaluated); a bounded BFS copies a whitelist of fields
- Subprocess calls are argv arrays with fixed flag lists — no shell interpolation
- Configuration writes require same-origin POSTs and are body-capped
