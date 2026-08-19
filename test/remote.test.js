import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { installRemote } from '../lib/remote.js'
import { resolveOptions } from '../lib/config.js'

/** A fake settings seam with one namespace registration. */
function fakeSettingsService(initial = {}) {
  const state = {
    value: initial.value ?? {},
    base: initial.base ?? {},
    user: initial.user ?? {},
    revision: initial.revision ?? 0,
    writable: true,
  }
  const mutateCalls = []
  return {
    state,
    mutateCalls,
    register(ns, schema, options) {
      state.base = options.base ?? {}
      return {
        ns,
        schema,
        base: options.base,
        get: () => ({ ...state.base, ...state.value }),
        watch: () => () => {},
        mutate: async (ops, expectedRevision) => {
          mutateCalls.push({ ops, expectedRevision })
          if (expectedRevision !== undefined && expectedRevision !== state.revision) {
            const error = new Error(`settings namespace "${ns}" changed since it was read`)
            error.code = 'SETTINGS_CONFLICT'
            throw error
          }
          for (const op of ops) {
            if (op.op === 'set') {
              state.user[op.path[0]] = op.value
              state.value[op.path[0]] = op.value
            } else {
              delete state.user[op.path[0]]
              delete state.value[op.path[0]]
            }
          }
          state.revision += 1
        },
      }
    },
    describe({ redactSecrets }) {
      assert.equal(redactSecrets, true)
      const value = { ...state.base, ...state.value }
      if (value.token !== undefined) delete value.token // mimic secret redaction
      return [
        {
          ns: 'dsh-github-router',
          value,
          base: state.base,
          user: { ...state.user },
          revision: state.revision,
        },
      ]
    },
    writable: state.writable,
  }
}

function fakeRequest({ method = 'GET', url = '/dsh-github-router/config', origin = 'http://127.0.0.1:3080', host = '127.0.0.1:3080', body = undefined }) {
  const request = { method, url, headers: { origin, host } }
  if (body !== undefined) {
    request[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(body, 'utf8')
    }
  }
  return request
}

function fakeResponse() {
  return {
    status: null,
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.body = payload === undefined ? '' : String(payload)
    },
  }
}

/** Mount the plugin wiring and capture the web-server route registration. */
function mount(settingsService) {
  const registered = []
  const ctx = {
    inject: (deps, callback) => {
      if (deps.includes('settings') && settingsService !== undefined) {
        callback({
          settings: settingsService,
          effect: () => () => {},
        })
      }
      if (deps.includes('webServer')) {
        callback({
          effect: (fn) => {
            fn() // run the mount effect immediately, like the seam does
            return () => {}
          },
          webServer: {
            register: (spec) => {
              registered.push(spec)
              return () => {}
            },
          },
        })
      }
    },
    registered,
  }
  const remote = installRemote(ctx, { retries: 2 })
  return { ctx, registered, options: remote.options }
}

function parsed(response) {
  return JSON.parse(response.body)
}

describe('installRemote (host)', () => {
  it('mounts one prefix route on the web server', () => {
    const settings = fakeSettingsService({ value: { proxy: 'http://p.example' } })
    const { registered } = mount(settings)
    assert.equal(registered.length, 1)
    assert.equal(registered[0].kind, 'prefix')
    assert.equal(registered[0].path, '/dsh-github-router')
    assert.equal(typeof registered[0].handler, 'function')
  })

  it('resolves the options thunk from the registered scope', () => {
    const settings = fakeSettingsService({ value: { proxy: 'http://p.example' } })
    const { options } = mount(settings)
    assert.equal(options().retries, 2) // base config layer
    assert.equal(options().proxy, 'http://p.example') // user/value layer
  })

  it('serves the redacted view on GET', async () => {
    const settings = fakeSettingsService({ value: { proxy: '', token: 'secret-token' }, base: {} })
    const { registered } = mount(settings)
    const response = fakeResponse()
    await registered[0].handler(fakeRequest({}), response)
    assert.equal(response.status, 200)
    const body = parsed(response)
    assert.equal(body.ok, true)
    assert.equal(body.value.value.proxy, '')
    assert.equal(body.value.value.token, undefined, 'secrets never cross the wire')
    assert.equal(typeof body.value.revision, 'number')
    assert.equal(body.value.writable, true)
  })

  it('applies POST writes through the seam with revision fencing', async () => {
    const settings = fakeSettingsService({ value: { retries: 1 }, revision: 4 })
    const { registered } = mount(settings)
    const response = fakeResponse()
    const body = JSON.stringify({ ops: [{ op: 'set', path: ['retries'], value: 3 }], expectedRevision: 4 })
    await registered[0].handler(fakeRequest({ method: 'POST', body }), response)
    assert.equal(response.status, 200)
    assert.equal(parsed(response).value.value.retries, 3)
    assert.deepEqual(settings.mutateCalls[0], {
      ops: [{ op: 'set', path: ['retries'], value: 3 }],
      expectedRevision: 4,
    })

    const conflict = fakeResponse()
    await registered[0].handler(fakeRequest({ method: 'POST', body: JSON.stringify({ ops: [{ op: 'set', path: ['retries'], value: 0 }], expectedRevision: 0 }) }), conflict)
    assert.equal(conflict.status, 409)
    assert.ok(String(parsed(conflict).error).includes('changed since it was read'))
  })

  it('rejects malformed ops before touching the seam', async () => {
    const settings = fakeSettingsService({ value: {} })
    const { registered } = mount(settings)
    for (const ops of [
      [],
      [{ op: 'delete', path: ['x'] }],
      [{ op: 'set', path: ['a', 'b'], value: 1 }],
      [{ op: 'set', path: ['x'] }],
    ]) {
      const response = fakeResponse()
      await registered[0].handler(fakeRequest({ method: 'POST', body: JSON.stringify({ ops, expectedRevision: 0 }) }), response)
      assert.equal(response.status, 400)
      assert.equal(parsed(response).ok, false)
    }
    assert.equal(settings.mutateCalls.length, 0)
  })

  it('refuses cross-origin writes', async () => {
    const settings = fakeSettingsService({ value: {} })
    const { registered } = mount(settings)
    const response = fakeResponse()
    await registered[0].handler(fakeRequest({ method: 'POST', origin: 'https://evil.example', body: '{}' }), response)
    assert.equal(response.status, 403)
    assert.equal(settings.mutateCalls.length, 0)
  })

  it('answers 405 for other methods and 404 for unknown paths', async () => {
    const settings = fakeSettingsService({ value: {} })
    const { registered } = mount(settings)
    const wrongMethod = fakeResponse()
    await registered[0].handler(fakeRequest({ method: 'PUT', body: '{}' }), wrongMethod)
    assert.equal(wrongMethod.status, 405)

    const wrongPath = fakeResponse()
    await registered[0].handler(fakeRequest({ url: '/dsh-github-router/other' }), wrongPath)
    assert.equal(wrongPath.status, 404)
  })

  it('reports unavailability when the settings service is absent', async () => {
    const { registered, options } = mount(undefined)
    assert.deepEqual(options(), resolveOptions({ retries: 2 }))
    const response = fakeResponse()
    await registered[0].handler(fakeRequest({}), response)
    assert.equal(response.status, 503)
    assert.equal(parsed(response).ok, false)
  })
})
