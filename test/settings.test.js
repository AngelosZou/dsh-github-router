import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { installSettings } from '../lib/settings.js'
import { resolveOptions } from '../lib/config.js'

/** A fake settings seam that captures the namespace registration. */
function fakeSettingsService(initial = {}) {
  const state = {
    value: initial.value ?? {},
    base: initial.base ?? {},
    revision: initial.revision ?? 0,
    writable: initial.writable ?? true,
  }
  return {
    state,
    registrations: [],
    register(ns, schema, options) {
      this.registrations.push({ ns, schema, options })
      return {
        ns,
        get: () => ({ ...options.base, ...state.value }),
        watch: () => () => {},
      }
    },
    describe({ redactSecrets }) {
      assert.equal(redactSecrets, true)
      return [
        {
          ns: 'dsh-github-router',
          value: state.value,
          base: state.base,
          user: {},
          revision: state.revision,
        },
      ]
    },
    writable: state.writable,
  }
}

/** Mount the wiring and capture the settings-service injection. */
function mount(settingsService) {
  const ctx = {
    inject: (deps, callback) => {
      if (deps.includes('settings') && settingsService !== undefined) {
        callback({
          settings: settingsService,
          effect: () => () => {},
        })
      }
    },
  }
  const installed = installSettings(ctx, { retries: 2 })
  return { installed }
}

describe('installSettings (host)', () => {
  it('registers the namespace with the schema, base layer, and live applies', () => {
    const settings = fakeSettingsService({ value: {} })
    mount(settings)
    assert.equal(settings.registrations.length, 1)
    const registration = settings.registrations[0]
    assert.equal(registration.ns, 'dsh-github-router')
    assert.equal(typeof registration.schema, 'function', 'schema is a schemastery schema')
    assert.deepEqual(registration.options.base, { retries: 2 })
    assert.equal(registration.options.applies, 'live')
  })

  it('resolves the options thunk from the registered scope', () => {
    const settings = fakeSettingsService({ value: { proxy: 'http://p.example' } })
    const { installed } = mount(settings)
    assert.equal(installed.options().retries, 2) // composition base layer
    assert.equal(installed.options().proxy, 'http://p.example') // user/value layer
  })

  it('falls back to the composition config when the settings service is absent', () => {
    const { installed } = mount(undefined)
    assert.deepEqual(installed.options(), resolveOptions({ retries: 2 }))
  })
})
