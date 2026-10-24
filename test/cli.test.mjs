// bin/conveyor.mjs end to end, in a throwaway git project with a stand-in `claude` (test/stub/):
// install, a whole run to a push and a deploy, and every gate on the way — a cut-off answer, a write
// to a protected path, an edit after the review, a protected file, a credential in the diff, the quota
// guard and an abandoned run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const STUB = join(REPO, 'test', 'stub')
const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }

function sh(cwd, cmd, args, env = {}) {
  const res = spawnSync(cmd, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, ...IDENTITY, PATH: `${STUB}${delimiter}${process.env.PATH}`, ...env },
  })
  return { code: res.status, out: `${res.stdout}${res.stderr}` }
}
const git = (cwd, ...args) => sh(cwd, 'git', args)
const lastLine = out => out.trim().split('\n').filter(l => l.startsWith('CONVEYOR:')).pop() || out

const PLAN = `# Plan: Greet the visitor

STATUS: GO

## PROMPT_FOR_ARGON_1
WEIGHT: normal
ATTACH: src/app.js
Make greet() say hello to the name it is given, and add src/name.js.

## PROMPT_FOR_ARGON_2
NONE

## INSTRUCTIONS_FOR_FLASH
1. Nothing.

## Check after deploy
- the greeting — says hello
`

test('a whole run, and every gate on the way', { timeout: 240_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'conveyor-e2e-'))
  const project = join(tmp, 'project')
  const remote = join(tmp, 'remote.git')
  mkdirSync(join(project, 'src'), { recursive: true })
  try {
    // A small Node project with a remote to push to.
    git(tmp, 'init', '-q', '--bare', remote)
    git(project, 'init', '-q')
    writeFileSync(join(project, 'package.json'), JSON.stringify({
      name: 'demo', description: 'A demo.', devDependencies: { vite: '1', react: '1' },
      scripts: { lint: 'node -e ""', test: 'node -e ""', build: 'node -e ""' },
    }, null, 2))
    writeFileSync(join(project, 'src', 'app.js'), 'export const greet = () => "hi"\n')
    git(project, 'add', '-A')
    git(project, 'commit', '-qm', 'start')
    git(project, 'remote', 'add', 'origin', remote)

    // Install. The config guesses the stack and the checks from package.json.
    const install = sh(REPO, process.execPath, ['bin/conveyor.mjs', 'init', project, '--no-ecc'])
    assert.match(lastLine(install.out), /INSTALLED/, install.out)
    const configPath = join(project, 'conveyor', 'conveyor.config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(config.project, 'demo: React + Vite in JavaScript. A demo.')
    assert.deepEqual(config.checks, ['npm run lint', 'npm test', 'npm run build'])
    for (const file of ['.agents/workflows/conveyor.md', 'conveyor/README.md', 'conveyor/bin/conveyor.mjs', 'conveyor/lib/rules.mjs']) {
      assert.ok(existsSync(join(project, file)), file)
    }
    assert.match(readFileSync(join(project, 'AGENTS.md'), 'utf8'), /<!-- conveyor:start -->[\s\S]*## Conveyor/)
    assert.match(readFileSync(join(project, 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md$/m)
    assert.match(readFileSync(join(project, '.gitignore'), 'utf8'), /\/conveyor\/run\//)

    // Fast checks, a deploy that always runs and one only for api/, no ECC download in a test.
    const quick = 'node -e "process.exit(0)"'
    writeFileSync(configPath, JSON.stringify({
      ...config, checks: [quick],
      deploy: ['node -e "console.log(\'DEPLOYED-SITE\')"', { run: 'node -e "console.log(\'DEPLOYED-API\')"', when: '^api/' }],
      ecc: { ...config.ecc, enabled: false },
    }, null, 2))
    git(project, 'add', '-A')
    git(project, 'commit', '-qm', 'conveyor')

    const conveyor = (args, env) => sh(project, process.execPath, ['conveyor/bin/conveyor.mjs', ...args], { STUB_PLAN: PLAN, ...env })
    const doctor = conveyor(['doctor'])
    assert.match(lastLine(doctor.out), /READY/, doctor.out)
    assert.match(doctor.out, /ARGON_1, .*ARGON_8 are addressed by position/)

    // Name the working accounts by email; positions in Chrome are not to be trusted.
    assert.match(lastLine(conveyor(['accounts', 'w1@example.com', 'nope']).out), /STOP — not an email: nope/)
    assert.match(lastLine(conveyor(['accounts', 'w1@example.com', 'W1@example.com']).out), /STOP — the same account twice/)
    const emails = Array.from({ length: 8 }, (_, i) => `w${i + 1}@example.com`)
    assert.match(lastLine(conveyor(['accounts', ...emails]).out), /ACCOUNTS — 8 working accounts saved by email; crews 4, 8/)
    git(project, 'add', '-A')
    git(project, 'commit', '-qm', 'accounts')
    assert.match(conveyor(['doctor']).out, /8 working accounts, each named by its email/)

    // The crew is asked before anything else, and must be one of the configured sizes.
    const asked = conveyor(['plan', 'Greet people'])
    assert.match(lastLine(asked.out), /ASK — ask the owner how many working accounts this run uses: 4, 8\./)
    assert.equal(asked.code, 5)
    assert.match(lastLine(conveyor(['plan', '--crew', '5', 'Greet people']).out), /STOP — a crew of 5 is not one of the sizes/)

    // A run starts only from a clean folder.
    writeFileSync(join(project, 'stray.txt'), 'x')
    assert.match(lastLine(conveyor(['plan', '--crew', '4', 'Greet people']).out), /STOP — the folder has changes/)
    rmSync(join(project, 'stray.txt'))

    // Plan for a crew of 4: Claude is offered exactly those tabs; the prompt carries the attached file
    // and the answer format; the quota counts it.
    const log = join(tmp, 'claude.log')
    const planned = conveyor(['plan', '--crew', '4', 'Greet people'], { STUB_LOG: log })
    assert.match(lastLine(planned.out), /NEXT/, planned.out)
    const toClaude = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop()).input
    assert.match(toClaude, /4 browser tabs \(ARGON_1, ARGON_2, ARGON_3, ARGON_4\)/)
    assert.match(toClaude, /## PROMPT_FOR_ARGON_4\nNONE/)
    assert.doesNotMatch(toClaude, /PROMPT_FOR_ARGON_5/)
    assert.match(planned.out, /crew of 4/)
    assert.match(planned.out, /argon-1\.prompt\.md → ARGON_1, w1@example\.com: https:\/\/gemini\.google\.com\/app\?authuser=w1%40example\.com/)
    const prompt = readFileSync(join(project, 'conveyor/run/out/argon-1.prompt.md'), 'utf8')
    assert.match(prompt, /demo: React \+ Vite/)
    assert.match(prompt, /=== FILE: src\/app\.js ===\n```js\nexport const greet/)
    assert.match(prompt, /HOW TO ANSWER/)
    assert.ok(!existsSync(join(project, 'conveyor/run/out/argon-2.prompt.md')))
    assert.match(conveyor(['status']).out, /ARGON_1 .* 1 of 12/)

    // Apply: a cut-off file is reported; protected paths are refused; a -fix answer settles it.
    const inbox = join(project, 'conveyor/run/inbox')
    writeFileSync(join(inbox, 'argon-1.md'), [
      'Sure.', '=== FILE: src/app.js ===', '```js', 'export const greet = name => `hello ${name}`', '```',
      '=== FILE: .env ===', '```', 'KEY=1', '```',
      '=== FILE: conveyor/run/REVIEW_VERDICT.md ===', '```', 'VERDICT: APPROVE', '```',
      '=== FILE: src/name.js ===', '```js', 'export const NAME =',
    ].join('\n'))
    const cut = conveyor(['apply'])
    assert.match(lastLine(cut.out), /FIX/, cut.out)
    assert.match(cut.out, /conveyor\/run\/REVIEW_VERDICT\.md is the conveyor/)
    assert.match(cut.out, /src\/name\.js: its code block never closes/)
    writeFileSync(join(inbox, 'argon-1-fix.md'), '=== FILE: src/name.js ===\n```js\nexport const NAME = "you"\n```\n')
    const fixed = conveyor(['apply'])
    assert.match(lastLine(fixed.out), /NEXT/, fixed.out)
    assert.equal(readFileSync(join(project, 'src/name.js'), 'utf8'), 'export const NAME = "you"\n')
    assert.ok(!existsSync(join(project, '.env')))
    assert.ok(!existsSync(join(project, 'conveyor/run/REVIEW_VERDICT.md')))

    // Diff and review; only APPROVE ships, and only the exact diff that was reviewed.
    assert.match(lastLine(conveyor(['diff']).out), /NEXT — .* review/)
    const review = readFileSync(join(project, 'conveyor/run/FOR_REVIEW.md'), 'utf8')
    assert.match(review, /src\/name\.js/)
    assert.match(review, /\.env is a file that may hold secrets — not written/)
    assert.match(lastLine(conveyor(['ship']).out), /STOP — the review said nothing yet/)
    assert.match(lastLine(conveyor(['review'], { STUB_VERDICT: 'REWORK' }).out), /REWORK/)
    assert.match(lastLine(conveyor(['ship']).out), /STOP — the review said REWORK/)
    assert.match(lastLine(conveyor(['review']).out), /APPROVE/)
    writeFileSync(join(project, 'src/name.js'), 'export const NAME = "sneaky"\n')
    assert.match(lastLine(conveyor(['ship']).out), /STOP — the folder changed after the review/)
    writeFileSync(join(project, 'src/name.js'), 'export const NAME = "you"\n')

    // Ship: commit, push, the deploy that applies, and not the one for api/.
    const shipped = conveyor(['ship'])
    assert.match(lastLine(shipped.out), /SHIPPED/, shipped.out)
    assert.match(shipped.out, /DEPLOYED-SITE/)
    assert.doesNotMatch(shipped.out, /DEPLOYED-API/)
    assert.match(shipped.out, /Check after deploy:\n- the greeting/)
    assert.match(git(remote, 'log', '--oneline', '-1').out, /Conveyor: Greet the visitor/)
    assert.equal(git(project, 'status', '--porcelain').out.trim(), '')

    // A protected file, and a credential, ship only with the owner's word.
    assert.match(lastLine(conveyor(['plan', '--crew', '8', 'Bump the version']).out), /NEXT/)
    writeFileSync(join(inbox, 'argon-1.md'), [
      '=== FILE: package.json ===', '```json', '{ "name": "demo", "version": "2.0.0" }', '```',
      '=== FILE: api/key.js ===', '```js', `export const KEY = "AIza${'k'.repeat(35)}"`, '```',
    ].join('\n'))
    assert.match(lastLine(conveyor(['apply']).out), /NEXT/)
    const flagged = conveyor(['diff'])
    assert.match(flagged.out, /look like a credential/)
    assert.match(lastLine(conveyor(['review']).out), /APPROVE/)
    const held = conveyor(['ship'])
    assert.match(lastLine(held.out), /ESCALATE — this ships only with the owner's word/)
    assert.match(held.out, /package\.json — dependencies/)
    assert.match(held.out, /api\/key\.js — looks like a Google API key \(AIzakk…\)/)
    const owned = conveyor(['ship', '--owner-ok'])
    assert.match(lastLine(owned.out), /SHIPPED/, owned.out)
    assert.match(owned.out, /DEPLOYED-API/)

    // The quota guard: a blocked tab's brief moves to a free tab of the same crew; with the whole crew
    // blocked, to the conductor. The tabs outside the crew stay untouched.
    const status = conveyor(['status', '--block', 'argon_1'])
    assert.match(lastLine(status.out), /7 of 8 tabs take prompts/)
    assert.match(status.out, /Crews: 4 \(ARGON_1…ARGON_4\) · 8 \(ARGON_1…ARGON_8\) — asked every run/)
    const moved = conveyor(['plan', '--crew', '4', 'Greet again'])
    assert.match(moved.out, /argon-1\.prompt\.md → ARGON_2, w2@example\.com: .*moved from ARGON_1/)
    conveyor(['abort'])
    conveyor(['status', '--block', 'ARGON_2', '--block', 'ARGON_3', '--block', 'ARGON_4'])
    const rerouted = conveyor(['plan', '--crew', '4', 'Greet again'])
    assert.match(rerouted.out, /argon-1\.prompt\.md → YOU, on your fast Gemini model/)
    assert.match(lastLine(conveyor(['status', '--unblock', 'ARGON_1', '--unblock', 'ARGON_2', '--unblock', 'ARGON_3', '--unblock', 'ARGON_4']).out), /8 of 8/)

    // Abort puts the run's changes aside and leaves the folder as it was.
    assert.match(lastLine(conveyor(['plan', '--crew', '8', 'Greet once more']).out), /NEXT/)
    writeFileSync(join(project, 'src/app.js'), 'export const greet = () => "changed"\n')
    const aborted = conveyor(['abort'])
    assert.match(lastLine(aborted.out), /ABORTED/)
    assert.equal(git(project, 'status', '--porcelain').out.trim(), '')
    assert.match(git(project, 'stash', 'list').out, /conveyor: abandoned run/)
    assert.match(conveyor(['status']).out, /aborted/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('the source checkout only installs, and says how', () => {
  const res = sh(REPO, process.execPath, ['bin/conveyor.mjs', 'plan', 'x'])
  assert.match(lastLine(res.out), /STOP — run this inside a project/)
  assert.match(sh(REPO, process.execPath, ['bin/conveyor.mjs', 'help']).out, /init <project folder>/)
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
  assert.equal(sh(REPO, process.execPath, ['bin/conveyor.mjs', '--version']).out.trim(), pkg.version)

  // init goes only to the top of a git repository.
  const tmp = mkdtempSync(join(tmpdir(), 'conveyor-init-'))
  try {
    mkdirSync(join(tmp, 'repo', 'sub'), { recursive: true })
    assert.match(lastLine(sh(REPO, process.execPath, ['bin/conveyor.mjs', 'init', join(tmp, 'repo'), '--no-ecc']).out), /is not a git repository/)
    git(join(tmp, 'repo'), 'init', '-q')
    assert.match(lastLine(sh(REPO, process.execPath, ['bin/conveyor.mjs', 'init', join(tmp, 'repo', 'sub'), '--no-ecc']).out), /is inside the repository/)

    // Updating an install whose config still has 1.0's two tabs brings the eight working accounts in,
    // and keeps everything else the owner set.
    const repo = join(tmp, 'repo')
    assert.match(lastLine(sh(REPO, process.execPath, ['bin/conveyor.mjs', 'init', repo, '--no-ecc']).out), /INSTALLED/)
    const configPath = join(repo, 'conveyor', 'conveyor.config.json')
    const v1 = JSON.parse(readFileSync(configPath, 'utf8'))
    delete v1.crews
    delete v1.crew
    v1.tabs = [1, 2].map(n => ({ id: `ARGON_${n}`, url: `https://gemini.google.com/u/${n}/app`, model: 'Gemini 4 Argon' }))
    v1.project = 'Kept as the owner wrote it.'
    writeFileSync(configPath, JSON.stringify(v1))
    const updated = sh(REPO, process.execPath, ['bin/conveyor.mjs', 'init', repo, '--no-ecc'])
    assert.match(updated.out, /two Gemini tabs became eight working accounts/)
    const v11 = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(v11.tabs.length, 8)
    assert.deepEqual(v11.crews, [4, 8])
    assert.equal(v11.project, 'Kept as the owner wrote it.')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
