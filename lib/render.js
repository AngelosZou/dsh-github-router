/**
 * Model-facing text renderers for the canonical tool values.
 * @module dsh-github-router/render
 */

function routeLine(routes) {
  const parts = Object.entries(routes ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`)
  return parts.length > 0 ? `routes: ${parts.join(', ')}` : 'routes: none'
}

function notesLine(notes) {
  return Array.isArray(notes) && notes.length > 0 ? `notes:\n${notes.map((n) => '  - ' + n).join('\n')}` : ''
}

export function renderPr(value) {
  if (value && typeof value.error === 'string') {
    const routes = value.routes ? `\n${routeLine(value.routes)}` : ''
    const notes = notesLine(value.notes)
    return [{ type: 'text', text: `github_pr failed: ${value.error}${routes}${notes ? '\n' + notes : ''}` }]
  }
  const p = value.pr ?? {}
  const lines = []
  lines.push(`# PR ${p.owner}/${p.repo}#${p.number}: ${p.title ?? '(no title)'}`)
  const flags = []
  if (p.state) flags.push(p.state.toLowerCase())
  if (p.draft) flags.push('draft')
  if (p.merged) flags.push('merged')
  lines.push(
    `state: ${flags.length > 0 ? flags.join(', ') : 'unknown'} | author: ${p.author ?? 'unknown'} | +${p.additions ?? '?'}/-${p.deletions ?? '?'} across ${p.changedFiles ?? '?'} files`,
  )
  if (p.baseRef && p.headRef) lines.push(`base: ${p.baseRef} (${(p.baseSha ?? '').slice(0, 8)}) -> head: ${p.headRef} (${(p.headSha ?? '').slice(0, 8)})`)
  const dates = [p.createdAt ? `created ${p.createdAt}` : null, p.updatedAt ? `updated ${p.updatedAt}` : null, p.mergedAt ? `merged ${p.mergedAt}` : null].filter(Boolean)
  if (dates.length > 0) lines.push(dates.join(' | '))
  if (p.url) lines.push(`url: ${p.url}`)
  if (p.body && p.body.length > 0) {
    lines.push('')
    lines.push('## Description')
    lines.push(p.body)
  }
  if (value.discussion && value.discussion.length > 0) {
    lines.push('', `## Discussion (${value.discussion.length}${value.routes.discussion ? ', via ' + value.routes.discussion : ''})`)
    for (const item of value.discussion) {
      lines.push(`- [${item.kind}] ${item.author ?? 'unknown'}${item.createdAt ? ' @ ' + item.createdAt : ''}${item.path ? ' (' + item.path + ')' : ''}`)
      lines.push('  ' + String(item.body ?? '').split('\n').join('\n  '))
    }
  }
  if (value.reviews && value.reviews.length > 0) {
    lines.push('', `## Reviews (${value.reviews.length})`)
    for (const r of value.reviews) {
      lines.push(`- [${r.state ?? 'review'}] ${r.author ?? 'unknown'}${r.submittedAt ? ' @ ' + r.submittedAt : ''}`)
      if (r.body) lines.push('  ' + String(r.body).split('\n').join('\n  '))
    }
  }
  if (value.files && value.files.length > 0) {
    lines.push('', `## Files (${value.files.length})`)
    for (const f of value.files) {
      const parts = [`${f.path}`, f.status ? ` [${f.status}]` : '', `+${f.additions ?? 0}/-${f.deletions ?? 0}`]
      lines.push(`- ${parts.join(' ')}`)
    }
  }
  if (value.commits && value.commits.length > 0) {
    lines.push('', `## Commits (${value.commits.length})`)
    for (const c of value.commits) {
      lines.push(`- ${(c.sha ?? '').slice(0, 8)} ${c.author ?? ''}${c.date ? ' ' + c.date : ''}: ${String(c.message ?? '').split('\n')[0].slice(0, 140)}`)
    }
  }
  if (value.diff !== null && value.diff !== undefined) {
    lines.push('', `## Diff (via ${value.routes.diff ?? '?'}${value.diffTruncated ? ', truncated' : ''})`)
    lines.push(value.diff)
  }
  lines.push('', routeLine(value.routes))
  const notes = notesLine(value.notes)
  if (notes.length > 0) lines.push(notes)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function renderIssue(value) {
  if (value && typeof value.error === 'string') {
    const routes = value.routes ? `\n${routeLine(value.routes)}` : ''
    const notes = notesLine(value.notes)
    return [{ type: 'text', text: `github_issue failed: ${value.error}${routes}${notes ? '\n' + notes : ''}` }]
  }
  const i = value.issue ?? {}
  const lines = []
  lines.push(`# Issue ${i.owner}/${i.repo}#${i.number}: ${i.title ?? '(no title)'}`)
  lines.push(`state: ${i.state ?? 'unknown'}${i.stateReason ? ' (' + i.stateReason + ')' : ''} | author: ${i.author ?? 'unknown'} | comments: ${i.commentsCount ?? '?'}`)
  const dates = [i.createdAt ? `created ${i.createdAt}` : null, i.updatedAt ? `updated ${i.updatedAt}` : null, i.closedAt ? `closed ${i.closedAt}` : null].filter(Boolean)
  if (dates.length > 0) lines.push(dates.join(' | '))
  if (i.labels && i.labels.length > 0) lines.push(`labels: ${i.labels.join(', ')}`)
  if (i.url) lines.push(`url: ${i.url}`)
  if (i.body && i.body.length > 0) {
    lines.push('', '## Body')
    lines.push(i.body)
  }
  if (value.comments && value.comments.length > 0) {
    lines.push('', `## Comments (${value.comments.length}${value.routes.comments ? ', via ' + value.routes.comments : ''})`)
    for (const c of value.comments) {
      lines.push(`- [${c.kind}] ${c.author ?? 'unknown'}${c.createdAt ? ' @ ' + c.createdAt : ''}`)
      lines.push('  ' + String(c.body ?? '').split('\n').join('\n  '))
    }
  }
  lines.push('', routeLine(value.routes))
  const notes = notesLine(value.notes)
  if (notes.length > 0) lines.push(notes)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function renderFile(value) {
  if (value && typeof value.error === 'string') {
    const failures = Array.isArray(value.failures) && value.failures.length > 0 ? `\nfailures:\n${value.failures.map((f) => '  - ' + f).join('\n')}` : ''
    return [{ type: 'text', text: `github_file failed: ${value.error}${failures}` }]
  }
  if (value.kind === 'directory') {
    const lines = [`directory ${value.path} @ ${value.ref} (${value.entries.length} entries, via ${value.route})`]
    for (const e of value.entries) lines.push(`- ${e.name} (${e.type}${e.size !== null && e.size !== undefined ? ', ' + e.size + ' bytes' : ''})`)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const head = `file ${value.path} @ ${value.ref} (${value.size} bytes, via ${value.route}${value.truncated ? ', truncated at cap' : ''})`
  return [{ type: 'text', text: head + '\n\n' + value.content }]
}

export function renderProbe(value) {
  if (value && typeof value.error === 'string') return [{ type: 'text', text: `github_probe failed: ${value.error}` }]
  const lines = ['# GitHub route probe (host-side connectivity)']
  lines.push(`proxy in use: ${value.proxy ?? 'none'}`)
  lines.push(`token configured: ${value.tokenConfigured ? 'yes' : 'no (anonymous limits)'}`)
  lines.push('')
  for (const c of value.checks) {
    lines.push(`[${c.ok ? 'OK ' : 'FAIL'}] ${c.route.padEnd(16)} ${c.ms}ms  ${c.detail}`)
  }
  lines.push('')
  lines.push('Live routes: ' + (value.live.length > 0 ? value.live.join(', ') : '(none)'))
  lines.push('Recommendation:')
  for (const r of value.recommendation) lines.push(`  - ${r}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function renderApi(value) {
  if (value && typeof value.error === 'string') {
    return [{ type: 'text', text: `github_api failed: ${value.error}${value.path ? ` (${value.path})` : ''}` }]
  }
  const rateClause = value.rateLimit !== null && value.rateLimit !== undefined ? ` (rate limit remaining: ${value.rateLimit})` : ''
  const head = `GET ${value.path} -> HTTP ${value.status}${rateClause}${value.truncated ? ' [truncated]' : ''}`
  let body
  if (value.json !== undefined && value.json !== null) {
    body = JSON.stringify(value.json, null, 2)
  } else {
    body = value.text ?? ''
  }
  if (body.length > 0) return [{ type: 'text', text: head + '\n\n' + body }]
  return [{ type: 'text', text: head }]
}
