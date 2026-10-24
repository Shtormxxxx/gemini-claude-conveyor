// lib/config.mjs — defaults fill the gaps, mistakes are named, and the built-in guards cannot be
// configured away.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, guards, readConfig } from '../lib/config.mjs'
import { firstMatch } from '../lib/rules.mjs'

test('an empty config is the defaults, with no problems', () => {
  const { config, problems } = readConfig('')
  assert.deepEqual(problems, [])
  assert.deepEqual(config, DEFAULTS)
})

test('the default team is eight working accounts, run as a crew of 4 or 8, asked every run', () => {
  const { config } = readConfig('')
  assert.equal(config.tabs.length, 8)
  assert.deepEqual(config.tabs.map(t => t.url.match(/\/u\/(\d)\//)[1]), ['1', '2', '3', '4', '5', '6', '7', '8'])
  assert.deepEqual(config.crews, [4, 8])
  assert.equal(config.crew, null)
})

test('a config from before crews keeps working with the tabs it has', () => {
  const two = [{ id: 'ARGON_1', url: 'https://gemini.google.com/u/1/app' }, { id: 'ARGON_2', url: 'https://gemini.google.com/u/2/app' }]
  assert.deepEqual(readConfig(JSON.stringify({ tabs: two })).config.crews, [2])
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `T_${i}`, url: 'https://x' }))
  assert.deepEqual(readConfig(JSON.stringify({ tabs: five })).config.crews, [4])
})

test('tabs are named by email or given a url; one account never backs two tabs', () => {
  const ok = readConfig(JSON.stringify({ crews: [2], tabs: [{ id: 'ARGON_1', account: 'one@gmail.com' }, { id: 'ARGON_2', url: 'https://gemini.google.com/u/5/app' }] }))
  assert.deepEqual(ok.problems, [])
  assert.deepEqual(ok.config.tabs.map(t => t.url), ['https://gemini.google.com/app?authuser=one%40gmail.com', 'https://gemini.google.com/u/5/app'])
  const text = readConfig(JSON.stringify({ crews: [4], tabs: [
    { id: 'ARGON_1', account: 'One@gmail.com' }, { id: 'ARGON_2', account: 'one@gmail.com' },
    { id: 'ARGON_3', url: 'https://gemini.google.com/u/2/app' }, { id: 'ARGON_4', url: 'https://gemini.google.com/u/2/app' },
    { id: 'ARGON_5', account: 'not-an-email' }, { id: 'ARGON_6' },
  ] })).problems.join('\n')
  assert.match(text, /ARGON_1 and ARGON_2 are the same account \(one@gmail\.com\)/)
  assert.match(text, /ARGON_3 and ARGON_4 are the same account \(\/u\/2\/\)/)
  assert.match(text, /ARGON_5: "account" must be the account's email/)
  assert.match(text, /ARGON_6: give "account"/)
})

test('the local emails name the tabs in order, and must fit them', () => {
  const { config, problems } = readConfig(JSON.stringify({ crews: [2], tabs: [{ id: 'ARGON_1' }, { id: 'ARGON_2', url: 'https://gemini.google.com/u/3/app' }] }), ['a@gmail.com'])
  assert.deepEqual(problems, [])
  assert.deepEqual(config.tabs.map(t => [t.account, t.url]), [['a@gmail.com', 'https://gemini.google.com/app?authuser=a%40gmail.com'], [undefined, 'https://gemini.google.com/u/3/app']])
  assert.match(readConfig('', Array.from({ length: 9 }, (_, i) => `x${i}@gmail.com`)).problems.join(), /9 emails for 8 tabs/)
  assert.match(readConfig('', ['not-an-email']).problems.join(), /accounts\.local\.json must hold/)
  for (const path of ['conveyor/accounts.local.json', 'accounts.local.json']) assert.ok(firstMatch(guards(readConfig('').config).secrets, path), path)
})

test('crew sizes must fit the tabs, and a fixed crew must be one of them', () => {
  const tabs = Array.from({ length: 10 }, (_, i) => ({ id: `ARGON_${i + 1}`, url: `https://gemini.google.com/u/${i + 1}/app` }))
  assert.deepEqual(readConfig(JSON.stringify({ tabs, crews: [5, 10], crew: 10 })).problems, [])
  assert.match(readConfig(JSON.stringify({ crews: [4, 12] })).problems.join(), /between 1 and 8/)
  assert.match(readConfig(JSON.stringify({ crew: 5 })).problems.join(), /"crew" must be null/)
})

test('a partial config keeps the defaults it does not mention', () => {
  const { config, problems } = readConfig(JSON.stringify({ checks: ['npm test'], quota: { budget: 8 }, ecc: { enabled: false } }))
  assert.deepEqual(problems, [])
  assert.deepEqual(config.checks, ['npm test'])
  assert.deepEqual(config.quota, { budget: 8, windowHours: 5 })
  assert.equal(config.ecc.enabled, false)
  assert.equal(config.ecc.version, DEFAULTS.ecc.version)
})

test('mistakes in the config are named, one by one', () => {
  assert.match(readConfig('{ nope').problems[0], /not valid JSON/)
  const { problems } = readConfig(JSON.stringify({
    checks: 'npm test',
    tabs: [{ id: 'argon', url: 'http://x' }, { id: 'B', url: 'https://x' }, { id: 'B', url: 'https://y' }],
    quota: { budget: 0 },
    ownerOnly: ['('],
    deploy: [{ run: 'x', when: '[' }],
  }))
  const text = problems.join('\n')
  for (const expected of [/"checks"/, /UPPER_CASE/, /a "url" starting with https/, /appears twice/, /quota\.budget/, /"ownerOnly" has a pattern/, /deploy "when"/]) {
    assert.match(text, expected)
  }
})

test('the built-in guards hold whatever the project lists, and the project can add its own', () => {
  const { config } = readConfig(JSON.stringify({ ownerOnly: [{ pattern: '^firestore\\.rules$', reason: 'database rules' }], neverWrite: [], secrets: [] }))
  const g = guards(config)
  for (const secret of ['.env', 'api/.env.local', 'id_rsa', 'certs/site.pem', 'service-account.json', '.npmrc']) {
    assert.ok(firstMatch(g.secrets, secret), secret)
    assert.ok(firstMatch(g.neverWrite, secret), secret)
  }
  for (const path of ['conveyor/bin/conveyor.mjs', '.agents/workflows/conveyor.md', 'AGENTS.md', '.git/config', 'node_modules/x/i.js', 'dist/index.html', 'package-lock.json']) {
    assert.ok(firstMatch(g.neverWrite, path), path)
  }
  // Not even the run's own files: an answer must not be able to write a verdict.
  assert.ok(firstMatch(g.neverWrite, 'conveyor/run/REVIEW_VERDICT.md'))
  for (const path of ['package.json', 'requirements.txt', '.github/workflows/ci.yml', '.gitignore', 'conveyor/conveyor.config.json', 'CLAUDE.md', 'firestore.rules']) {
    assert.ok(firstMatch(g.ownerOnly, path), path)
  }
  assert.equal(firstMatch(g.ownerOnly, 'src/App.jsx'), null)
  assert.equal(firstMatch(g.ownerOnly, 'firestore.rules'), 'database rules')
})
