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

/** A fake host config service behind a fetch stub. */
function fakeHost(initial = {}) {
  const state = {
    value: initial.value ?? {},
    base: initial.base ?? {},
    user: initial.user ?? {},
    revision: initial.revision ?? 0,
    writable: true,
    failGet: false,
    failPost: false,
  }
  const calls = []
  const view = () => ({
    value: { ...state.value },
    base: { ...state.base },
    user: { ...state.user },
    revision: state.revision,
    writable: state.writable,
  })
  const jsonResponse = (status, body) => Promise.resolve({ status, json: () => Promise.resolve(body) })
  globalThis.fetch = (url, init) => {
    calls.push({ url, init })
    if (url !== '/dsh-github-router/config') return jsonResponse(404, { ok: false, error: 'not found' })
    if (init === undefined || init.method === 'GET') {
      return state.failGet
        ? jsonResponse(503, { ok: false, error: 'describe failed' })
        : jsonResponse(200, { ok: true, value: view() })
    }
    if (init.method === 'POST') {
      if (state.failPost) return jsonResponse(409, { ok: false, error: 'mutate rejected' })
      const payload = JSON.parse(init.body)
      if (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision === state.revision) {
        for (const op of payload.ops) {
          if (op.op === 'set') {
            state.user[op.path[0]] = op.value
            state.value[op.path[0]] = op.value
          } else {
            delete state.user[op.path[0]]
            delete state.value[op.path[0]]
          }
        }
        state.revision += 1
        return jsonResponse(200, { ok: true, value: view() })
      }
      return jsonResponse(409, { ok: false, error: 'settings namespace changed since it was read' })
    }
    return jsonResponse(405, { ok: false, error: 'method not allowed' })
  }
  return { state, calls }
}

function fakeCtx() {
  const registrations = []
  return {
    registrations,
    get: () => undefined,
    locale: {
      bind: () => (key) => key,
      register: () => {},
    },
    effect: (fn) => {
      fn()
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

describe('client settings page module', () => {
  it('declares the services the row activates on', () => {
    const mod = loadClientModule()
    assert.deepEqual(mod.inject, ['slots', 'locale'])
  })

  it('registers one independent settings section', () => {
    const mod = loadClientModule()
    fakeHost({ value: { proxy: '' } })
    const ctx = fakeCtx()
    mod.apply(ctx)
    assert.equal(ctx.registrations.length, 1)
    assert.equal(ctx.registrations[0].options.name, 'settings.section')
    assert.equal(ctx.registrations[0].options.id, 'dsh-github-router')
    assert.equal(ctx.registrations[0].options.order, 65)
    assert.equal(typeof ctx.registrations[0].options.label, 'function')
    assert.equal(typeof ctx.registrations[0].component, 'function')
  })

  it('loads the namespace view through the plugin route', async () => {
    const mod = loadClientModule()
    fakeHost({ value: { proxy: 'http://old.example', retries: 1 }, revision: 3 })
    const ctx = fakeCtx()
    mod.apply(ctx)
    const face = faceOf(ctx)
    await tick()
    const snapshot = face.hooks.settings.getSnapshot()
    assert.equal(snapshot.available, true)
    assert.equal(snapshot.writable, true)
    assert.equal(snapshot.fields.proxy.text, 'http://old.example')
    assert.equal(snapshot.fields.retries.text, '1')
  })

  it('stages edits and writes them through POST on save', async () => {
    const mod = loadClientModule()
    const host = fakeHost({ value: { proxy: '' }, revision: 0 })
    const ctx = fakeCtx()
    mod.apply(ctx)
    const face = faceOf(ctx)
    await tick()

    face.edit('proxy', 'http://proxy.example.com:3128')
    let snapshot = face.hooks.settings.getSnapshot()
    assert.equal(snapshot.dirty, true)
    assert.equal(snapshot.fields.proxy.text, 'http://proxy.example.com:3128')
    assert.equal(host.calls.filter((c) => c.init && c.init.method === 'POST').length, 0, 'edits are staged, not written')

    face.save()
    await tick()
    await tick()
    const post = host.calls.find((c) => c.init && c.init.method === 'POST')
    assert.ok(post !== undefined)
    const payload = JSON.parse(post.init.body)
    assert.deepEqual(payload.ops, [{ op: 'set', path: ['proxy'], value: 'http://proxy.example.com:3128' }])
    assert.equal(payload.expectedRevision, 0)
    assert.equal(host.state.user.proxy, 'http://proxy.example.com:3128')
    snapshot = face.hooks.settings.getSnapshot()
    assert.equal(snapshot.dirty, false)
  })

  it('blocks the save when a number field is invalid', async () => {
    const mod = loadClientModule()
    const host = fakeHost({ value: { retries: 1 } })
    const ctx = fakeCtx()
    mod.apply(ctx)
    const face = faceOf(ctx)
    await tick()
    face.edit('retries', 'not-a-number')
    assert.equal(face.hooks.settings.getSnapshot().invalid, true)
    face.save()
    await tick()
    assert.equal(host.calls.some((c) => c.init && c.init.method === 'POST'), false)
  })

  it('parses booleans and csv arrays into typed writes', async () => {
    const mod = loadClientModule()
    const host = fakeHost({ value: { routesMirror: false, mirrors: [] } })
    const ctx = fakeCtx()
    mod.apply(ctx)
    const face = faceOf(ctx)
    await tick()
    face.edit('routesMirror', 'true')
    face.edit('mirrors', 'https://a.example, https://b.example')
    face.save()
    await tick()
    await tick()
    assert.equal(host.state.user.routesMirror, true)
    assert.deepEqual(host.state.user.mirrors, ['https://a.example', 'https://b.example'])
  })

  it('clears overridden fields through unset ops', async () => {
    const mod = loadClientModule()
    const host = fakeHost({
      value: { proxy: 'http://old.example' },
      user: { proxy: 'http://old.example' },
      revision: 5,
    })
    const ctx = fakeCtx()
    mod.apply(ctx)
    const face = faceOf(ctx)
    await tick()
    assert.equal(face.hooks.settings.getSnapshot().fields.proxy.overridden, true)
    face.resetField('proxy')
    face.save()
    await tick()
    await tick()
    const post = host.calls.find((c) => c.init && c.init.method === 'POST')
    assert.deepEqual(JSON.parse(post.init.body).ops, [{ op: 'unset', path: ['proxy'] }])
    assert.equal(host.state.user.proxy, undefined)
  })

  it('exposes the store through the hooks face (useSettings contract)', async () => {
    const mod = loadClientModule()
    fakeHost({ value: { proxy: '' } })
    const ctx = fakeCtx()
    mod.apply(ctx)
    const face = faceOf(ctx)
    await tick()
    assert.ok(face.hooks !== undefined, 'inject face carries the hooks object')
    assert.equal(typeof face.hooks.settings.getSnapshot, 'function')
    assert.equal(typeof face.hooks.settings.subscribe, 'function')
    assert.equal(typeof face.save, 'function')
    assert.equal(typeof face.edit, 'function')
    assert.equal(typeof face.discard, 'function')
  })

  it('marks the page unavailable when the route rejects the read', async () => {
    const mod = loadClientModule()
    const host = fakeHost({ value: {} })
    host.state.failGet = true
    const ctx = fakeCtx()
    mod.apply(ctx)
    const face = faceOf(ctx)
    await tick()
    assert.equal(face.hooks.settings.getSnapshot().available, false)
  })

  it('splits common and advanced fields into two catalogs', () => {
    const mod = loadClientModule()
    fakeHost({ value: {} })
    const ctx = fakeCtx()
    mod.apply(ctx)
    const face = faceOf(ctx)
    const snapshot = face.hooks.settings.getSnapshot()
    // Common fields are present…
    for (const field of ['token', 'tokenEnv', 'proxy', 'routesApi', 'routesGh', 'routesGit', 'routesHtml']) {
      assert.ok(snapshot.fields[field] !== undefined, `common field ${field} exists`)
    }
    // …and the advanced tail is kept in the form too (rendered collapsed).
    for (const field of ['directTimeoutMs', 'cacheTtlMeta', 'routesMirror', 'mirrors', 'repos', 'gitCacheDir']) {
      assert.ok(snapshot.fields[field] !== undefined, `advanced field ${field} exists`)
    }
  })
})
