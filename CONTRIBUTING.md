# Contributing

Thanks for your interest in dsh-github-router. This plugin is small,
plain-ESM, and dependency-free at runtime — the development loop is
correspondingly simple.

## Development loop

```bash
npm test
# or: node --test --test-isolation=none "test/*.test.js"
```

The tests run with Node directly, with zero network access. A mock cordis
context stands in for the DSH services, while the real
`@deepseek-ai/dsh-tools` `defineTool` validates every tool schema — so
schema mistakes fail in `test/apply.test.js` rather than at host boot.

After changing anything in `lib/`, re-run the tests and then reinstall the
plugin into a local profile:

```bash
dsh plugin --profile <profile> add link:<absolute-path-to-this-repo>
```

Restart the DSH backend to pick up host-side changes (the host composition
loads at process start).

## Offline peer resolution

The plugin's imports (`@deepseek-ai/dsh-tools`, `dsh-settings`,
`dsh-credentials`, `schemastery`, `cordis`) are peer dependencies and
resolve from the DSH profile in production. To run the tests without a
registry round-trip, create a local junction inside the checkout:

```powershell
New-Item -ItemType Junction -Path node_modules\@deepseek-ai -Target <dschome>\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai
```

(`node_modules/` is git-ignored; the junction is a local convenience only.)

## Conventions

- **Plain ESM, no build step.** No TypeScript, no bundler.
- **One module per concern** — `lib/routes/*` are transport adapters with no
  knowledge of the tools; `lib/core/*` aggregate routes; `lib/tools/*` are
  the only modules that touch `defineTool`.
- **No shell interpolation.** Every subprocess is an argv array; anything
  user-derived must pass a guard in `lib/util.js` first.
- **Lossless JSON.** Tool execute results must round-trip
  `JSON.parse(JSON.stringify(value))` unchanged — never attach enumerable
  side properties to arrays, never return `undefined`-valued fields.
- **Tests for every guard and parser.** Input guards, the JSON-island
  walker, the tunnel request head, and the TTL cache all have offline
  tests; add one whenever behavior changes.

## Security rules for contributions

This plugin runs host-side with the host token. Before adding anything,
re-read [SECURITY.md](SECURITY.md). Hard rules:

1. **No write capability, ever.** No POST/PATCH/PUT/DELETE, no push, no
   comments. If a mutating capability is ever proposed, it must be a
   separate tool behind an explicit user-facing consent surface — and it
   still needs a strong justification to exist here.
2. **No execution of remote content.** Page payloads are `JSON.parse`-only;
   never introduce `eval`/`Function` or any HTML/script interpretation.
3. **Secrets stay out of outputs.** Tokens attach only to api.github.com;
   proxy URLs in error text must be credential-stripped.
4. **Bounded everything.** Every response body, walk, list, and retry needs
   an explicit cap with a visible truncation note.

## Releasing

1. Bump `version` in `package.json`, update `CHANGELOG.md` (Keep a
   Changelog), commit.
2. `npm test` (runs via `prepublishOnly` as well).
3. `npm publish` and verify the package through
   `dsh plugin --profile <profile> add dsh-github-router` in a fresh
   profile.
