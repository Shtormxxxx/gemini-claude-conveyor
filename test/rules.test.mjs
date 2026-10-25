// lib/rules.mjs — what a browser chat may write, what ships only with the owner, how plans, answers
// and verdicts are read, the pre-review, the quota guard with its spares, the guard on Claude's
// limits and the secret scan: each is a gate a run relies on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assignTabs, block, claudeChoice, compileRules, deployFor, fenceFor, fileMap, fill, fingerprint, firstMatch,
  ownerReasons, prereviewPrompt, prereviewTab, projectPath, quotaView, readAnswer, readBrief, readClaudeStream,
  pickAccounts, readCrewArg, readLimits, readPlan, readPrereview, readVerdict, recordSent, scanSecrets, section, slug,
  tabPrompt, tail, positionOf, tabLabel, tabUrl, scanEmails, weekPace, weekPassed,
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
  // REVIEW is standard or deep; the template's own "deep | standard", left as it is, reads as deep.
  assert.equal(readPlan(PLAN).review, null)
  assert.equal(readPlan(PLAN.replace('STATUS: GO', 'STATUS: GO\nREVIEW: Standard')).review, 'standard')
  assert.equal(readPlan('REVIEW: deep | standard').review, 'deep')
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

test('the working accounts\' emails are caught in added lines, masked', () => {
  const diff = '+++ b/src/a.js\n+const who = "Work1@Gmail.com"\n-old work2@gmail.com\n+++ b/b.md\n+nothing here'
  assert.deepEqual(scanEmails(diff, ['work1@gmail.com', 'work2@gmail.com']), [{ file: 'src/a.js', kind: 'a working account\'s email', sample: 'w…@gmail.com' }])
  assert.deepEqual(scanEmails(diff, []), [])
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

const tabView = (used, budget = 12, blocked = []) => Object.fromEntries(Object.entries(used).map(([id, n]) =>
  [id, { used: n, budget, available: n < budget && !blocked.includes(id) }]))

test('each brief keeps its own tab while that tab has room', () => {
  const view = tabView({ ARGON_1: 0, ARGON_2: 3, ARGON_3: 11, ARGON_4: 0 })
  const briefs = ['ARGON_1', 'ARGON_2', 'ARGON_3'].map(id => ({ id, heavy: false }))
  assert.deepEqual(assignTabs(briefs, view, ['ARGON_1', 'ARGON_2', 'ARGON_3', 'ARGON_4']), {
    ARGON_1: { route: 'TAB', tab: 'ARGON_1' }, ARGON_2: { route: 'TAB', tab: 'ARGON_2' }, ARGON_3: { route: 'TAB', tab: 'ARGON_3' },
  })
})

test('a held-back tab\'s brief moves to the least busy crew tab with the most room, never outside the crew', () => {
  const view = tabView({ ARGON_1: 12, ARGON_2: 2, ARGON_3: 9, ARGON_4: 1, ARGON_5: 0 }, 12, ['ARGON_3'])
  const crew = ['ARGON_1', 'ARGON_2', 'ARGON_3', 'ARGON_4']
  const briefs = [{ id: 'ARGON_1', heavy: false }, { id: 'ARGON_2', heavy: false }, { id: 'ARGON_3', heavy: true }]
  // ARGON_4 is idle with the most room: it takes ARGON_1's brief; then ARGON_2 and ARGON_4 have one
  // each, and ARGON_4 still has more room, so it takes ARGON_3's too. ARGON_5 is outside the crew.
  assert.deepEqual(assignTabs(briefs, view, crew), {
    ARGON_2: { route: 'TAB', tab: 'ARGON_2' },
    ARGON_1: { route: 'TAB', tab: 'ARGON_4' },
    ARGON_3: { route: 'TAB', tab: 'ARGON_4' },
  })
  // A brief written under a tab outside the crew is moved into it.
  assert.deepEqual(assignTabs([{ id: 'ARGON_7', heavy: false }], view, crew), { ARGON_7: { route: 'TAB', tab: 'ARGON_4' } })
})

test('when no crew tab has room, briefs go to the conductor: fast model, or Claude when heavy', () => {
  const view = tabView({ ARGON_1: 12, ARGON_2: 11, ARGON_3: 0 }, 12, ['ARGON_3'])
  const briefs = [{ id: 'ARGON_1', heavy: false }, { id: 'ARGON_2', heavy: false }, { id: 'ARGON_3', heavy: true }]
  assert.deepEqual(assignTabs(briefs, view, ['ARGON_1', 'ARGON_2', 'ARGON_3']), {
    ARGON_2: { route: 'TAB', tab: 'ARGON_2' },
    ARGON_1: { route: 'FLASH' },
    ARGON_3: { route: 'CLAUDE' },
  })
})

test('with the whole crew out of room, a spare outside it stands in before the conductor does', () => {
  const view = tabView({ ARGON_1: 12, ARGON_2: 12, ARGON_3: 0, ARGON_4: 5 })
  const briefs = [{ id: 'ARGON_1', heavy: false }, { id: 'ARGON_2', heavy: true }]
  // ARGON_3 has the most room and takes the first; then ARGON_4 has fewer briefs and takes the second.
  assert.deepEqual(assignTabs(briefs, view, ['ARGON_1', 'ARGON_2'], ['ARGON_3', 'ARGON_4']), {
    ARGON_1: { route: 'TAB', tab: 'ARGON_3', spare: true },
    ARGON_2: { route: 'TAB', tab: 'ARGON_4', spare: true },
  })
  // The crew comes first: a brief written under a spare goes to a crew tab with room.
  assert.deepEqual(assignTabs([{ id: 'ARGON_3', heavy: false }], tabView({ ARGON_1: 0, ARGON_3: 0 }), ['ARGON_1'], ['ARGON_3']), {
    ARGON_3: { route: 'TAB', tab: 'ARGON_1' },
  })
  // With no room anywhere, the conductor.
  assert.deepEqual(assignTabs(briefs, tabView({ ARGON_1: 12, ARGON_2: 12, ARGON_3: 12 }), ['ARGON_1', 'ARGON_2'], ['ARGON_3']), {
    ARGON_1: { route: 'FLASH' }, ARGON_2: { route: 'CLAUDE' },
  })
})

test('the pre-review goes to the account with the most room that wrote none of the run', () => {
  const ids = ['ARGON_1', 'ARGON_2', 'ARGON_3', 'ARGON_4']
  const view = tabView({ ARGON_1: 3, ARGON_2: 1, ARGON_3: 11, ARGON_4: 0 }, 12, ['ARGON_4'])
  assert.equal(prereviewTab(view, ids, ['ARGON_2']), 'ARGON_1')
  // When every free account wrote code, the one with the most room.
  assert.equal(prereviewTab(view, ids, ['ARGON_1', 'ARGON_2', 'ARGON_3']), 'ARGON_2')
  assert.equal(prereviewTab(tabView({ ARGON_1: 12 }), ['ARGON_1'], []), null)
})

test('the pre-review prompt carries the task, the diff and the files to correct, or asks for problems only', () => {
  const opts = { project: 'A Vue site.', task: 'Add a page.', goal: 'A page.', checks: '✓ passed  npm test', diff: '+x' }
  const text = prereviewPrompt({ ...opts, files: [{ path: 'src/a.vue', content: '<x/>\n' }] })
  for (const expected of [/A Vue site\./, /THE TASK\nAdd a page\./, /WHAT THE CHANGE MUST DO\nA page\./, /CHECKS[^\n]*\n✓ passed {2}npm test/,
    /THE DIFF\n```diff\n\+x\n```/, /=== FILE: src\/a\.vue ===\n```vue\n<x\/>\n```/, /PREREVIEW: PASS/, /3\. With FIX, for every file you correct/]) {
    assert.match(text, expected)
  }
  const bare = prereviewPrompt({ ...opts, files: null })
  assert.doesNotMatch(bare, /THE CHANGED FILES/)
  assert.match(bare, /list the problems only, and send no files/)
})

test('the pre-review answer: its verdict, the problems listed before the files, and the files', () => {
  const answer = readPrereview([
    'Here is my review.', '**PREREVIEW: FIX**', '- src/a.js: off by one', '* src/b.js: no null check',
    '=== FILE: src/a.js ===', '```js', 'x', '```', '- after the files: not a problem line',
  ].join('\r\n'))
  assert.equal(answer.verdict, 'FIX')
  assert.deepEqual(answer.issues, ['src/a.js: off by one', 'src/b.js: no null check'])
  assert.deepEqual(answer.files, [{ path: 'src/a.js', content: 'x\n' }])
  assert.deepEqual(answer.problems, [])
  assert.deepEqual(readPrereview('PREREVIEW: PASS\nAll good.'), { verdict: 'PASS', issues: [], files: [], problems: [] })
  assert.equal(readPrereview('Looks fine to me.').verdict, null)
  assert.match(readPrereview('PREREVIEW: FIX\n=== FILE: a.js ===\n```js\ncut').problems[0].message, /cut off/)
})

test('the architect\'s map lists every file when they fit, and folds the deepest folders when not', () => {
  const paths = ['README.md', 'src/App.jsx', 'src/pages/Home.jsx', 'src/pages/About.jsx', 'src/data/lessons/a.json',
    'src/data/lessons/b.json', 'public/img/a.png', 'public/img/b.woff2']
  assert.equal(fileMap(paths, 100), [
    'public/ — 2 files (images, fonts, media)',
    'src/data/lessons/a.json', 'src/data/lessons/b.json', 'src/pages/About.jsx', 'src/pages/Home.jsx', 'src/App.jsx',
    'README.md',
  ].join('\n'))
  assert.equal(fileMap(paths, 5), ['public/ — 2 files (images, fonts, media)', 'src/data/ — 2 files', 'src/pages/ — 2 files', 'src/App.jsx', 'README.md'].join('\n'))
  assert.equal(fileMap(paths, 2), ['public/ — 2 files (images, fonts, media)', 'src/ — 5 files', '… and 1 more'].join('\n'))
  assert.equal(fileMap([]), '')
})

// What Claude Code printed in a real probe, trimmed: the limits come in a rate_limit_event.
const INFO = {
  status: 'allowed_warning', resetsAt: 1793383200, rateLimitType: 'seven_day', utilization: 0.33,
  unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1792873200, status: 'allowed' }, seven_day: { utilization: 0.33, resetsAt: 1793383200, status: 'allowed' } },
}

test('Claude\'s limits are read from its rate_limit_event, new shape or old', () => {
  assert.deepEqual(readLimits(INFO), {
    fiveHour: { used: 0.08, resetsAt: 1792873200000 }, week: { used: 0.33, resetsAt: 1793383200000 }, rejected: null,
  })
  assert.deepEqual(readLimits({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 100 }), {
    fiveHour: { used: 0.5, resetsAt: 100000 }, week: null, rejected: null,
  })
  assert.deepEqual(readLimits({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 100 }), {
    fiveHour: null, week: null, rejected: { resetsAt: 100000, type: 'seven_day_opus' },
  })
  assert.equal(readLimits({ status: 'allowed' }), null)
  assert.equal(readLimits(null), null)
})

test('a stream-json run is read for its model, last limits, result, cost and tokens', () => {
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5' }),
    'not json at all',
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: INFO }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ' OK ', num_turns: 1, total_cost_usd: 0.00064,
      usage: { input_tokens: 2, cache_creation_input_tokens: 3001, cache_read_input_tokens: 649, output_tokens: 73 } }),
  ].join('\n')
  assert.deepEqual(readClaudeStream(stream), {
    model: 'claude-haiku-5-5', limits: readLimits(INFO), ok: true, text: 'OK', costUsd: 0.00064, turns: 1, tokensIn: 3652, tokensOut: 73,
  })
  assert.equal(readClaudeStream(stream.replace('"is_error":false', '"is_error":true')).ok, false)
  assert.equal(readClaudeStream('').ok, false)
})

test('the guard on Claude\'s limits: main model, economy model, or no step at all', () => {
  const claude = { model: 'opus', effort: 'high', economy: { model: 'sonnet', effort: 'xhigh' }, switchAt: 50, weekAhead: 15, stopAt: 95 }
  const now = Date.parse('2026-10-24T12:00:00Z')
  const hour = 60 * 60 * 1000
  const at = (five, week, weekLeftDays = 6) => ({ fiveHour: { used: five, resetsAt: now + 2 * hour }, week: { used: week, resetsAt: now + weekLeftDays * 24 * hour }, rejected: null })
  const tier = (limits, opts) => claudeChoice(limits, now, claude, opts).tier

  assert.deepEqual(claudeChoice(at(0.1, 0.1), now, claude), { tier: 'main', model: 'opus', effort: 'high', why: 'the five-hour limit is at 10%, the week at 10%' })
  assert.equal(claudeChoice(null, now, claude).why, 'Claude Code reported no limits')
  // A routine review, and every step from 50% of the five-hour limit, on the economy model.
  assert.deepEqual(claudeChoice(at(0.1, 0.1), now, claude, { routine: true }), { tier: 'economy', model: 'sonnet', effort: 'xhigh', why: 'a routine review (the plan says REVIEW: standard)' })
  assert.match(claudeChoice(at(0.5, 0.1), now, claude).why, /five-hour limit is at 50%; from 50% the economy model works/)
  // The week is kept for later when it is spent faster than an even pace: with no base, from the
  // week's start — a seventh of it gone, so 14% plus 15 points may be spent first.
  assert.equal(tier(at(0.28, 0.28)), 'main')
  assert.match(claudeChoice(at(0.1, 0.3), now, claude).why, /the week is 30% spent, ahead of an even pace \(14% by now\)/)
  assert.equal(claudeChoice(at(0.1, 0.9), now, { ...claude, weekAhead: null }).tier, 'main')
  // From a base, what was spent before it stays as it is, whoever spent it, and what was left is spread
  // over the rest of the week: 34% at the base, 66% left for six days, 11 a day.
  const week = at(0, 0).week
  const base = { resetsAt: week.resetsAt, used: 0.34, at: now }
  assert.equal(tier(at(0.1, 0.34), { weekBase: base }), 'main')
  assert.equal(tier(at(0.1, 0.49), { weekBase: base }), 'main')
  assert.match(claudeChoice(at(0.1, 0.5), now, claude, { weekBase: base }).why, /the week is 50% spent, ahead of an even pace \(34% by now\)/)
  const later = now + 24 * hour
  assert.equal(Math.round(weekPace(week, later, base) * 100), 45)
  assert.equal(claudeChoice(at(0.1, 0.6), later, claude, { weekBase: base }).tier, 'main')
  assert.equal(claudeChoice(at(0.1, 0.61), later, claude, { weekBase: base }).tier, 'economy')
  // A base from another week is not this week's.
  assert.equal(weekPace(week, now, { ...base, resetsAt: week.resetsAt - 7 * 24 * hour }).toFixed(6), weekPassed(week.resetsAt, now).toFixed(6))
  // Near the top of either limit no step starts: it would be cut off halfway.
  assert.deepEqual(claudeChoice(at(0.95, 0.1), now, claude), { tier: 'stop', model: null, effort: null, why: 'the five-hour limit is at 95%', until: now + 2 * hour })
  assert.match(claudeChoice(at(0.1, 0.96), now, claude).why, /weekly limit is at 96%/)
  assert.match(claudeChoice({ fiveHour: null, week: null, rejected: { resetsAt: now + hour, type: 'five_hour' } }, now, claude).why, /refuses for now \(five-hour reached\)/)
  // A window that has reset is empty again; a refusal that has passed is over.
  assert.equal(tier({ fiveHour: { used: 0.99, resetsAt: now - 1 }, week: null, rejected: null }), 'main')
  assert.equal(tier({ fiveHour: null, week: null, rejected: { resetsAt: now - 1, type: 'five_hour' } }), 'main')
  // Claude refusing the main model alone moves the steps to the economy one until then.
  assert.match(claudeChoice(at(0.1, 0.1), now, claude, { mainRefusedUntil: now + hour }).why, /refuses opus for now/)
  assert.equal(tier(at(0.1, 0.1), { mainRefusedUntil: now - 1 }), 'main')
  assert.deepEqual([weekPassed(now + 7 * 24 * hour, now), weekPassed(now + 3.5 * 24 * hour, now), weekPassed(now, now)], [0, 0.5, 1])
})

test('a tab named by email opens Gemini for that account, wherever Chrome has put it', () => {
  assert.equal(tabUrl({ account: 'work.2@gmail.com' }), 'https://gemini.google.com/app?authuser=work.2%40gmail.com')
  assert.equal(tabUrl({ account: 'a@b.co', url: 'https://example.com/x' }), 'https://example.com/x')
  assert.equal(positionOf('https://gemini.google.com/u/5/app'), 5)
  assert.equal(positionOf('https://gemini.google.com/app?authuser=a%40b.co'), null)
  assert.equal(tabLabel({ account: 'a@b.co', url: 'x' }), 'a@b.co')
  assert.equal(tabLabel({ url: 'https://gemini.google.com/u/2/app' }), 'account at /u/2/ (by position)')
})

test('the crew size is read from --crew N or --crew=N, and the rest is the task', () => {
  assert.deepEqual(readCrewArg(['--crew', '8', 'Add', 'a', 'page']), { crew: 8, accounts: null, rest: ['Add', 'a', 'page'] })
  assert.deepEqual(readCrewArg(['Fix', '--crew=1']), { crew: 1, accounts: null, rest: ['Fix'] })
  assert.deepEqual(readCrewArg(['--accounts', 'aliseevna, meloman', 'Fix']), { crew: null, accounts: ['aliseevna', 'meloman'], rest: ['Fix'] })
  assert.deepEqual(readCrewArg(['--accounts=3', 'Fix it']), { crew: null, accounts: ['3'], rest: ['Fix it'] })
  assert.deepEqual(readCrewArg(['Fix it']), { crew: null, accounts: null, rest: ['Fix it'] })
})

test('the owner names the session\'s accounts loosely: a part of the email, the email, an id or a number', () => {
  const tabs = ['aliseevna.k@gmail.com', 'meloman77@gmail.com', 'ne.gretta@gmail.com', 'gretta.work@gmail.com']
    .map((account, i) => ({ id: `ARGON_${i + 1}`, account }))
  assert.deepEqual(pickAccounts(tabs, ['aliseevna', 'MELOMAN']), { ids: ['ARGON_1', 'ARGON_2'], problems: [] })
  assert.deepEqual(pickAccounts(tabs, ['ne.gretta']), { ids: ['ARGON_3'], problems: [] })
  assert.deepEqual(pickAccounts(tabs, ['4, argon_2', 'ne.gretta@gmail.com']), { ids: ['ARGON_4', 'ARGON_2', 'ARGON_3'], problems: [] })
  // What fits two accounts, or none, or one already named, goes back to the owner.
  assert.match(pickAccounts(tabs, ['gretta']).problems[0], /"gretta" fits ne\.gretta@gmail\.com, gretta\.work@gmail\.com — which one\?/)
  assert.match(pickAccounts(tabs, ['nobody']).problems[0], /fits no working account/)
  assert.match(pickAccounts(tabs, ['meloman', '2']).problems[0], /named already/)
  assert.match(pickAccounts(tabs, []).problems[0], /no account was named/)
  // The part after the @ names nobody: every account shares it.
  assert.match(pickAccounts(tabs, ['gmail']).problems[0], /fits no working account/)
})

test('fingerprints, placeholders and tails', () => {
  assert.notEqual(fingerprint('+x'), fingerprint('+y'))
  assert.equal(fill('{{A}} and {{B}} and {{C}}', { A: '{{B}}', B: '$&' }), '{{B}} and $& and {{C}}')
  assert.equal(tail('a\r\nb\r\nc', 2), '…\nb\nc')
})
