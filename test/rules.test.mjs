// lib/rules.mjs — what a browser chat may write, what ships only with the owner, how plans, answers
// and verdicts are read, the quota guard and the secret scan: each is a gate a run relies on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  block, compileRules, deployFor, fenceFor, fill, fingerprint, firstMatch, ownerReasons, projectPath,
  quotaView, readAnswer, readBrief, readPlan, readVerdict, recordSent, routeFor, scanSecrets, section,
  slug, tabPrompt, tail,
} from '../lib/rules.mjs'

test('paths are made relative to the project, and anything outside it is refused', () => {
  assert.deepEqual(projectPath('./src/App.jsx'), { ok: true, path: 'src/App.jsx' })
  assert.deepEqual(projectPath('`src\\pages\\Home.jsx`'), { ok: true, path: 'src/pages/Home.jsx' })
  for (const bad of ['../x.js', 'src/../../x.js', '/etc/passwd', 'C:/Windows/x.js', '  ']) {
    assert.equal(projectPath(bad).ok, false, bad)
  }
})

test('rules are compiled from patterns or { pattern, reason }, and the first match wins', () => {
  const rules = compileRules(['^a/', { pattern: '^b/', reason: 'bee' }], 'default')
  assert.equal(firstMatch(rules, 'a/x'), 'default')
  assert.equal(firstMatch(rules, 'b/x'), 'bee')
  assert.equal(firstMatch(rules, 'c/x'), null)
  assert.deepEqual(ownerReasons(['a/1', 'c/2'], rules), [{ path: 'a/1', reason: 'default' }])
})

test('deploy commands run always, or only when a matching path changed', () => {
  const entries = ['deploy site', { run: 'deploy api', when: '^api/' }]
  assert.deepEqual(deployFor(entries, ['src/a.js']), ['deploy site'])
  assert.deepEqual(deployFor(entries, ['api/x.js']), ['deploy site', 'deploy api'])
  assert.equal(slug('ARGON_1'), 'argon-1')
})

const PLAN = `# Plan: Pricing block on the home page

STATUS: GO

## PROMPT_FOR_ARGON_1 — the component
WEIGHT: heavy
ATTACH: src/pages/Home.jsx, \`src/constants.js\`
- ATTACH: src/index.css
Build the block.

## PROMPT_FOR_ARGON_2
NONE — the first tab is enough

## Check after deploy
- https://example.com/ — three cards
`

test('a plan is read by its headings and its STATUS, WEIGHT and ATTACH lines', () => {
  const plan = readPlan(PLAN)
  assert.equal(plan.title, 'Pricing block on the home page')
  assert.equal(plan.status, 'GO')
  assert.deepEqual(readBrief(section(plan, 'PROMPT_FOR_ARGON_1')), {
    prompt: 'Build the block.', attach: ['src/pages/Home.jsx', 'src/constants.js', 'src/index.css'], heavy: true,
  })
  assert.equal(readBrief(section(plan, 'PROMPT_FOR_ARGON_2')), null)
  assert.equal(section(plan, 'CHECK AFTER DEPLOY'), '- https://example.com/ — three cards')
  assert.equal(readPlan(PLAN.replace('STATUS: GO', 'STATUS: ESCALATE')).status, 'ESCALATE')
  assert.equal(readPlan('# Plan: x').status, null)
  assert.equal(readBrief('ATTACH: none\n'), null)
  assert.equal(readBrief('Do it.').heavy, false)
})

test('the prompt for a tab carries the project, the brief, the files in safe fences, and the format', () => {
  const text = tabPrompt({ project: 'A Vue site.', prompt: 'Do it.', files: [
    { path: 'src/a.vue', content: '<template/>\n' },
    { path: 'docs/b.md', content: 'text\n```js\nx\n```\n' },
    { path: 'src/new.js', missing: true },
  ] })
  assert.match(text, /A Vue site\./)
  assert.match(text, /TASK\nDo it\./)
  assert.match(text, /=== FILE: src\/a\.vue ===\n```vue\n<template\/>\n```/)
  assert.match(text, /=== FILE: docs\/b\.md ===\n````md\n/)
  assert.match(text, /=== FILE: src\/new\.js === \(does not exist yet/)
  assert.match(text, /HOW TO ANSWER/)
  assert.equal(fenceFor('has ```` four'), '`````')
  assert.equal(block('x\n', 'js'), '```js\nx\n```')
})

test('an answer is read file by file, whatever marks the chat adds around the FILE line', () => {
  const answer = [
    'Here you go.',
    '=== FILE: src/a.jsx ===', '```jsx', 'export const A = () => null', '```',
    '**=== FILE: src/b.css ===**', '', '```css', '.b { color: red; }', '```',
    '### === FILE: docs/c.md ===', '````markdown', 'Example:', '```js', 'x()', '```', '````',
    'Notes: done.',
  ].join('\r\n')
  const { files, problems } = readAnswer(answer)
  assert.deepEqual(problems, [])
  assert.deepEqual(files, [
    { path: 'src/a.jsx', content: 'export const A = () => null\n' },
    { path: 'src/b.css', content: '.b { color: red; }\n' },
    { path: 'docs/c.md', content: 'Example:\n```js\nx()\n```\n' },
  ])
})

test('a cut-off answer reports the unfinished file instead of writing half of it', () => {
  const { files, problems } = readAnswer('=== FILE: a.js ===\n```js\nok\n```\n=== FILE: b.js ===\n```js\nfunction b() {')
  assert.deepEqual(files.map(f => f.path), ['a.js'])
  assert.deepEqual(problems.map(p => p.path), ['b.js'])
  assert.match(problems[0].message, /cut off/)
  assert.equal(readAnswer('=== FILE: a.js ===\nI could not.').problems[0].path, 'a.js')
  assert.equal(readAnswer('```js\nx\n```').problems[0].path, null)
  assert.deepEqual(readAnswer('=== FILE: a.js ===\n   ```js\n   one\n     two\n   ```').files, [{ path: 'a.js', content: 'one\n  two\n' }])
})

test('the verdict is the first VERDICT line, and nothing else counts', () => {
  assert.equal(readVerdict('VERDICT: APPROVE\n- fixed a typo'), 'APPROVE')
  assert.equal(readVerdict('# Review\n\n**VERDICT: REWORK**\nlater: VERDICT: APPROVE'), 'REWORK')
  assert.equal(readVerdict('VERDICT: ESCALATE — rules'), 'ESCALATE')
  assert.equal(readVerdict('Looks fine, approve.'), null)
  assert.equal(readVerdict('VERDICT: MAYBE'), null)
})

test('the secret scan flags added lines that look like credentials, and masks them', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js',
    `+const key = "AIza${'x'.repeat(35)}"`,
    `-const old = "AIza${'y'.repeat(35)}"`,
    '+const ok = "not a key"',
    '+++ b/keys.pem',
    '+-----BEGIN RSA PRIVATE KEY-----',
    `+token = "ghp_${'a'.repeat(36)}"`,
  ].join('\n')
  const found = scanSecrets(diff)
  assert.deepEqual(found.map(f => [f.file, f.kind]), [
    ['src/a.js', 'a Google API key'], ['keys.pem', 'a private key'], ['keys.pem', 'a GitHub token'],
  ])
  assert.ok(found.every(f => f.sample.endsWith('…') && f.sample.length <= 7))
  assert.deepEqual(scanSecrets('+++ b/x\n+hello'), [])
})

test('the quota guard holds a tab back at its budget until the oldest request leaves the window', () => {
  const hour = 60 * 60 * 1000
  const now = Date.parse('2026-10-24T20:00:00Z')
  const opts = { ids: ['ARGON_1', 'ARGON_2'], budget: 12, windowMs: 5 * hour }
  let quota = {}
  for (let i = 0; i < 11; i++) quota = recordSent(quota, 'ARGON_1', now - 4 * hour + i * 1000, opts.windowMs)
  assert.equal(quotaView(quota, now, opts).ARGON_1.available, true)
  quota = recordSent(quota, 'ARGON_1', now, opts.windowMs)
  const full = quotaView(quota, now, opts).ARGON_1
  assert.deepEqual([full.used, full.available, full.freesAt], [12, false, now - 4 * hour + 5 * hour])
  assert.equal(quotaView(quota, now + hour + 11_000, opts).ARGON_1.available, true)
  assert.equal(quotaView(quota, now, opts).ARGON_2.available, true)
  const blocked = { ARGON_2: { sent: [], blockedUntil: '2026-10-25T01:00:00Z' } }
  assert.equal(quotaView(blocked, now, opts).ARGON_2.available, false)
  assert.equal(quotaView(blocked, Date.parse('2026-10-25T01:00:01Z'), opts).ARGON_2.available, true)
})

test('a held-back tab\'s brief goes to the fast model, or to Claude when it is heavy', () => {
  const view = { ARGON_1: { available: true }, ARGON_2: { available: false } }
  assert.equal(routeFor('ARGON_1', true, view), 'TAB')
  assert.equal(routeFor('ARGON_2', false, view), 'FLASH')
  assert.equal(routeFor('ARGON_2', true, view), 'CLAUDE')
})

test('fingerprints, placeholders and tails', () => {
  assert.notEqual(fingerprint('+x'), fingerprint('+y'))
  assert.equal(fill('{{A}} and {{B}} and {{C}}', { A: '{{B}}', B: '$&' }), '{{B}} and $& and {{C}}')
  assert.equal(tail('a\r\nb\r\nc', 2), '…\nb\nc')
})
