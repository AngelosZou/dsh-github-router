import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

/** Load the factory and capture the locale.register call. */
function loadClientModule() {
  let captured = null
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec
      },
    },
  }
  new Function('window', SOURCE)(fakeWindow)
  const reactStub = { createElement: (tag, props, ...children) => ({ tag, props, children }) }
  const runtimeStub = {
    createSnapshotStore: (init) => {
      let state = init
      return {
        getSnapshot: () => state,
        subscribe: () => () => {},
        set: (next) => {
          state = next
        },
        update: (mutator) => {
          mutator(JSON.parse(JSON.stringify(state)))
        },
      }
    },
  }
  const exports = captured.factory((name) => {
    if (name === 'react') return reactStub
    if (name === '@deepseek-ai/dsh-client-runtime/client') return runtimeStub
    throw new Error('unexpected require in factory: ' + name)
  })
  const localeCalls = []
  exports.apply({
    locale: {
      bind: () => (key) => key,
      register: (...args) => {
        localeCalls.push(args)
      },
    },
    effect: (fn) => {
      fn()
    },
    slots: {
      inject: () => {},
    },
    get: () => undefined,
  })
  return { localeCalls }
}

describe('localization compliance', () => {
  it('registers the namespace with both shipped locales (zh + en)', () => {
    const { localeCalls } = loadClientModule()
    assert.equal(localeCalls.length, 1)
    const [ns, dicts] = localeCalls[0]
    assert.equal(ns, 'dsh-github-router')
    assert.deepEqual(Object.keys(dicts).sort(), ['en', 'zh'])
  })

  it('keeps the zh and en dictionaries exactly balanced', () => {
    const { localeCalls } = loadClientModule()
    const { zh, en } = localeCalls[0][1]
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    assert.deepEqual(enKeys, zhKeys, 'every zh key has an en counterpart and vice versa')
    for (const key of zhKeys) {
      assert.ok(typeof zh[key] === 'string' && zh[key].trim().length > 0, `zh.${key} is a non-empty string`)
      assert.ok(typeof en[key] === 'string' && en[key].trim().length > 0, `en.${key} is a non-empty string`)
    }
  })

  it('every t(...) literal used in the bundle resolves to a dictionary key', () => {
    const { localeCalls } = loadClientModule()
    const { zh } = localeCalls[0][1]
    const used = new Set()
    const re = /(?<![A-Za-z])t\('([^']+)'\)/g
    let match
    while ((match = re.exec(SOURCE)) !== null) used.add(match[1])
    assert.ok(used.size > 5, 'the scan found the bundle t() calls')
    for (const key of used) {
      assert.ok(key in zh, `t('${key}') has a dictionary entry`)
    }
  })

  it('keeps all user-visible copy inside the dictionaries', () => {
    // Remove comments and the two dictionary blocks from the source;
    // whatever is left (the component, the form, the section registration)
    // must contain no CJK characters — i.e. no hardcoded Chinese UI copy
    // outside zhDict.
    const withoutComments = SOURCE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\n)\s*\/\/[^\n]*/g, '')
    const withoutDicts = withoutComments.replace(/var zhDict = \{[\s\S]*?\n    \};\n    var enDict = \{[\s\S]*?\n    \};/, '')
    assert.equal(/[\u4e00-\u9fff]/.test(withoutDicts), false, 'no CJK literals outside the zh dictionary')
  })
})
