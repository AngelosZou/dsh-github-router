import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply, name, inject } from '../lib/index.js'

/** Minimal cordis-shaped context: registries capture, services absent. */
function mockCtx() {
  const registered = []
  const ctx = {
    get: (service) => {
      if (service === 'subprocess') return { spawn: () => { throw new Error('spawn must not run in tests') } }
      if (service === 'credentials') return undefined
      return undefined
    },
    tools: { register: (def) => { registered.push({ kind: 'tool', def }); return () => {} } },
    skills: { register: (skill) => { registered.push({ kind: 'skill', def: skill }); return () => {} } },
    systemPrompt: { section: (section) => { registered.push({ kind: 'section', def: section }) } },
    inject: () => {}, // settings service absent → optional wiring stays inert
    provide: () => {}, // remote service registration is captured elsewhere
    fiber: { state: 1 },
  }
  return { ctx, registered }
}

describe('plugin apply wiring', () => {
  it('declares the cordis entry surface', () => {
    assert.equal(name, 'dsh-github-router')
    assert.deepEqual(inject, ['tools', 'subprocess', 'skills', 'systemPrompt'])
  })

  it('registers all five tools, the skill, and the guidance section', () => {
    const { ctx, registered } = mockCtx()
    apply(ctx, {})
    const tools = registered.filter((r) => r.kind === 'tool').map((r) => r.def.name)
    assert.deepEqual(tools.sort(), ['github_api', 'github_file', 'github_issue', 'github_pr', 'github_probe'].sort())
    for (const r of registered.filter((r) => r.kind === 'tool')) {
      assert.equal(typeof r.def.execute, 'function', r.def.name + ' has execute')
      assert.equal(typeof r.def.output.render, 'function', r.def.name + ' has render')
      assert.ok(r.def.description.length > 40, r.def.name + ' description is informative')
    }
    const skill = registered.find((r) => r.kind === 'skill')
    assert.ok(skill !== undefined)
    assert.equal(skill.def.name, 'github-router')
    assert.ok(skill.def.content.includes('github_pr'))
    const section = registered.find((r) => r.kind === 'section')
    assert.equal(section.def.name, 'dsh-github-router:guidance')
  })

  it('tools reject invalid arguments with a structured error (never throw)', async () => {
    const { ctx, registered } = mockCtx()
    apply(ctx, {})
    const pr = registered.find((r) => r.kind === 'tool' && r.def.name === 'github_pr').def
    const result = await pr.execute({ owner: 'a/b', repo: 'r', number: 1 }, { agent: { session: { header: { cwd: process.cwd() } } } })
    assert.ok(typeof result.error === 'string')
    assert.ok(result.error.includes('owner'))

    const api = registered.find((r) => r.kind === 'tool' && r.def.name === 'github_api').def
    const bad = await api.execute({ path: 'https://evil.example/x' }, {})
    assert.ok(typeof bad.error === 'string')
    assert.ok(bad.error.includes('path'))
  })
})
