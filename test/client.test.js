import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

/** Load the ModuleLoader factory with stubbed browser globals. */
function loadClientModule() {
  const src = readFileSync(CLIENT_PATH, 'utf8')
  let captured = null
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec
      },
    },
  }
  new Function('window', src)(fakeWindow)
  assert.ok(captured !== null, 'factory registered with the module loader')
  assert.equal(captured.id, 'dsh-github-router')
  const reactStub = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
  }
  const runtimeStub = {
    createSnapshotStore: (init) => {
      let state = init
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe: (fn) => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        set: (next) => {
          state = next
          listeners.forEach((fn) => fn())
        },
        update: (mutator) => {
          const draft = JSON.parse(JSON.stringify(state))
          mutator(draft)
          state = draft
          listeners.forEach((fn) => fn())
        },
      }
    },
  }
  const moduleExports = captured.factory((name) => {
    if (name === 'react') return reactStub
    if (name === '@deepseek-ai/dsh-client-runtime/client') return runtimeStub
    throw new Error('unexpected require in factory: ' + name)
  })
  return { apply: moduleExports.apply, inject: moduleExports.inject }
}

/**
 * The describe mirror's secret-slot face: the only source for whether the
 * redacted `token` field is configured. The fake scope folds token writes
 * into it, mirroring the real SettingsScopeController → mirror accept path.
 */
function fakeMirror(configured = false) {
  let tokenSet = configured
  const listeners = new Set()
  return {
    namespace: (ns) => (ns === 'dsh-github-router' ? { secrets: [{ path: ['token'], set: tokenSet }] } : undefined),
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    foldToken: (value) => {
      tokenSet = value
      listeners.forEach((fn) => fn())
    },
    tokenSet: () => tokenSet,
  }
}

/** A fake framework settings scope: synchronous snapshot + queued writes. */
function fakeScope(initial = {}, mirror = null) {
  const state = {
    status: initial.status ?? 'ready',
    value: { ...(initial.value ?? {}) },
    base: { ...(initial.base ?? {}) },
    user: { ...(initial.user ?? {}) },
    revision: initial.revision ?? 0,
    writable: initial.writable ?? true,
    mode: 'host',
  }
  let failWrites = false
  const listeners = new Set()
  const calls = []
  function notify() {
    listeners.forEach((fn) => fn())
  }
  return {
    state,
    calls,
    failWrites(value) {
      failWrites = value
    },
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    set: async (field, value) => {
      calls.push({ op: 'set', field, value })
      if (failWrites) return
      state.user[field] = value
      state.value[field] = value
      state.revision += 1
      if (field === 'token' && mirror !== null) mirror.foldToken(true)
      notify()
    },
    unset: async (field) => {
      calls.push({ op: 'unset', field })
      if (failWrites) return
      delete state.user[field]
      delete state.value[field]
      state.revision += 1
      if (field === 'token' && mirror !== null) mirror.foldToken(false)
      notify()
    },
  }
}

function fakeCtx(scope, mirror) {
  const registrations = []
  return {
    registrations,
    get: (name) => (name === 'connection' ? {} : undefined),
    locale: {
      bind: () => (key) => key,
      register: () => {},
    },
    effect: (fn) => {
      fn()
      return () => {}
    },
    settingsScope: {
      bind: () => scope,
      describe: () => mirror,
    },
    slots: {
      inject: (slot, generator) => {
        const iterator = generator()
        for (const entry of iterator) registrations.push(entry)
      },
      register: (options, component) => ({ options, component }),
    },
  }
}

function faceOf(ctx) {
  return ctx.registrations[0].options.inject()
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

function mountClient(initial = {}, mirror = null) {
  const mod = loadClientModule()
  const scope = fakeScope(initial, mirror)
  const ctx = fakeCtx(scope, mirror)
  mod.apply(ctx)
  return { mod, scope, ctx, face: faceOf(ctx) }
}

describe('client settings card module', () => {
  it('declares the services the card activates on', () => {
    const mod = loadClientModule()
    assert.deepEqual(mod.inject, ['slots', 'locale', 'settingsScope', 'connection'])
  })

  it('registers one plugin card keyed by the settings namespace', () => {
    const { ctx } = mountClient({ value: { proxy: '' } })
    assert.equal(ctx.registrations.length, 1)
    assert.equal(ctx.registrations[0].options.name, 'settings.plugin.item')
    assert.equal(ctx.registrations[0].options.key, 'dsh-github-router')
    assert.equal(ctx.registrations[0].options.locale, 'dsh-github-router')
    assert.equal(typeof ctx.registrations[0].component, 'function')
  })

  it('binds the namespace and projects the scope snapshot into the form', async () => {
    const { scope, face } = mountClient({ value: { proxy: 'http://old.example', retries: 1 }, revision: 3 })
    await tick()
    const snapshot = face.hooks.settings.getSnapshot()
    assert.equal(snapshot.available, true)
    assert.equal(snapshot.writable, true)
    assert.equal(snapshot.fields.proxy.text, 'http://old.example')
    assert.equal(snapshot.fields.retries.text, '1')
    assert.equal(scope.calls.length, 0, 'reading never writes')
  })

  it('stages edits and writes them through the scope on save', async () => {
    const { scope, face } = mountClient({ value: { proxy: '' }, revision: 0 })
    await tick()

    face.edit('proxy', 'http://proxy.example.com:3128')
    let snapshot = face.hooks.settings.getSnapshot()
    assert.equal(snapshot.dirty, true)
    assert.equal(snapshot.fields.proxy.text, 'http://proxy.example.com:3128')
    assert.equal(scope.calls.length, 0, 'edits are staged, not written')

    face.save()
    await tick()
    await tick()
    assert.deepEqual(scope.calls, [{ op: 'set', field: 'proxy', value: 'http://proxy.example.com:3128' }])
    assert.equal(scope.state.user.proxy, 'http://proxy.example.com:3128')
    snapshot = face.hooks.settings.getSnapshot()
    assert.equal(snapshot.dirty, false)
  })

  it('blocks the save when a number field is invalid', async () => {
    const { scope, face } = mountClient({ value: { retries: 1 } })
    await tick()
    face.edit('retries', 'not-a-number')
    assert.equal(face.hooks.settings.getSnapshot().invalid, true)
    face.save()
    await tick()
    assert.equal(scope.calls.length, 0)
  })

  it('parses booleans and csv arrays into typed writes', async () => {
    const { scope, face } = mountClient({ value: { routesMirror: false, mirrors: [] } })
    await tick()
    face.edit('routesMirror', 'true')
    face.edit('mirrors', 'https://a.example, https://b.example')
    face.save()
    await tick()
    await tick()
    assert.equal(scope.state.user.routesMirror, true)
    assert.deepEqual(scope.state.user.mirrors, ['https://a.example', 'https://b.example'])
  })

  it('clears overridden fields through unset writes', async () => {
    const { scope, face } = mountClient({
      value: { proxy: 'http://old.example' },
      user: { proxy: 'http://old.example' },
      revision: 5,
    })
    await tick()
    assert.equal(face.hooks.settings.getSnapshot().fields.proxy.overridden, true)
    face.resetField('proxy')
    face.save()
    await tick()
    await tick()
    assert.deepEqual(scope.calls, [{ op: 'unset', field: 'proxy' }])
    assert.equal(scope.state.user.proxy, undefined)
  })

  it('keeps drafts and reports failure when a write does not land', async () => {
    const { scope, face } = mountClient({ value: { proxy: '' } })
    await tick()
    scope.failWrites(true)
    face.edit('proxy', 'http://proxy.example.com:3128')
    face.save()
    await tick()
    await tick()
    const snapshot = face.hooks.settings.getSnapshot()
    assert.equal(snapshot.failed, true)
    assert.equal(snapshot.dirty, true)
  })

  it('writes a typed token and verifies it through the secret slot list', async () => {
    const mirror = fakeMirror(false)
    const { scope, face } = mountClient({ value: {} }, mirror)
    await tick()
    assert.equal(face.hooks.settings.getSnapshot().fields.token.configured, false)
    face.edit('token', 'ghp_abc')
    face.save()
    await tick()
    await tick()
    assert.deepEqual(scope.calls, [{ op: 'set', field: 'token', value: 'ghp_abc' }])
    assert.equal(mirror.tokenSet(), true)
    assert.equal(face.hooks.settings.getSnapshot().dirty, false)
  })

  it('clears a configured token with a blank draft and stays inert otherwise', async () => {
    const mirror = fakeMirror(true)
    const { scope, face } = mountClient({ value: {} }, mirror)
    await tick()
    assert.equal(face.hooks.settings.getSnapshot().fields.token.configured, true)
    face.edit('token', '')
    face.save()
    await tick()
    await tick()
    assert.deepEqual(scope.calls, [{ op: 'unset', field: 'token' }])

    const unconfiguredMirror = fakeMirror(false)
    const { scope: scope2, face: face2 } = mountClient({ value: {} }, unconfiguredMirror)
    await tick()
    face2.edit('token', '')
    face2.save()
    await tick()
    await tick()
    assert.equal(scope2.calls.length, 0, 'blank draft without a configured token writes nothing')
  })

  it('exposes the store through the hooks face (useSettings contract)', async () => {
    const { face } = mountClient({ value: { proxy: '' } })
    await tick()
    assert.ok(face.hooks !== undefined, 'inject face carries the hooks object')
    assert.equal(typeof face.hooks.settings.getSnapshot, 'function')
    assert.equal(typeof face.hooks.settings.subscribe, 'function')
    assert.equal(typeof face.save, 'function')
    assert.equal(typeof face.edit, 'function')
    assert.equal(typeof face.discard, 'function')
  })

  it('renders null while the namespace is not served', () => {
    const { ctx } = mountClient({ value: {}, status: 'loading' })
    const component = ctx.registrations[0].component
    const face = faceOf(ctx)
    const useSettings = () => face.hooks.settings.getSnapshot()
    const rendered = component({ useSettings, t: (key) => key })
    assert.equal(rendered, null, 'the card renders nothing until the scope is ready')
  })

  it('splits common and advanced fields into two catalogs', () => {
    const { face } = mountClient({ value: {} })
    const snapshot = face.hooks.settings.getSnapshot()
    for (const field of ['token', 'tokenEnv', 'proxy', 'routesApi', 'routesGh', 'routesGit', 'routesHtml']) {
      assert.ok(snapshot.fields[field] !== undefined, `common field ${field} exists`)
    }
    for (const field of ['directTimeoutMs', 'cacheTtlMeta', 'routesMirror', 'mirrors', 'repos', 'gitCacheDir']) {
      assert.ok(snapshot.fields[field] !== undefined, `advanced field ${field} exists`)
    }
  })
})
