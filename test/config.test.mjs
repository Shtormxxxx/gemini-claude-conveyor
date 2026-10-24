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
  for (const expected of [/"checks"/, /UPPER_CASE/, /must start with https/, /appears twice/, /quota\.budget/, /"ownerOnly" has a pattern/, /deploy "when"/]) {
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
