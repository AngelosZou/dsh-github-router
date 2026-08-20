/**
 * Host-side settings wiring for dsh-github-router.
 *
 * The `dsh-github-router` namespace rides the official settings seam
 * (`ctx.settings.register`): the framework persists the section in the user
 * settings document, validates it against the schema, fences writes with
 * revisions, and redacts secret-role fields on every wire boundary.
 *
 * Since DSH 0.1.0-rc.7 the api-proxy serves every registered settings
 * namespace to the (loopback) browser and the Settings → Plugins section
 * dispatches a plugin-owned card for it, so the client half binds the same
 * namespace through `ctx.settingsScope` and the plugin needs no HTTP routes
 * of its own. This module only registers the namespace and exposes the
 * runtime-options thunk the tools consume; a settings change therefore
 * applies to the NEXT tool call.
 * @module dsh-github-router/settings
 */
import { Config, NAMESPACE, resolveOptions } from './config.js'

/**
 * Register the settings namespace and return the runtime-options thunk.
 * @param ctx - the plugin context.
 * @param config - the composition-layer config subset (the `base` layer).
 */
export function installSettings(ctx, config) {
  const holder = { scope: null }

  ctx.inject(['settings'], (sctx) => {
    holder.scope = sctx.settings.register(NAMESPACE, Config, { base: config, applies: 'live' })
    sctx.effect(() => () => {
      holder.scope = null
    }, 'dsh-github-router: settings scope teardown')
  })

  return {
    options: () => (holder.scope !== null ? resolveOptions(holder.scope.get()) : resolveOptions(config)),
  }
}
