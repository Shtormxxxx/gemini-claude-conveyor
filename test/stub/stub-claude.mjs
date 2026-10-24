// A stand-in for the `claude` CLI in test/cli.test.mjs: it answers --version and auth status, and
// in print mode plays the architect or the reviewer by writing the files the real one would.
// STUB_PLAN is the plan to write; STUB_VERDICT the verdict (APPROVE by default).

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('9.9.9 (stub)'); process.exit(0) }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0) }

const input = readFileSync(0, 'utf8')
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, input }) + '\n')
if (input.includes('You are the architect')) {
  writeFileSync('conveyor/run/CONVEYOR_PLAN.md', process.env.STUB_PLAN || '')
} else if (input.includes('You are the reviewer')) {
  writeFileSync('conveyor/run/REVIEW_VERDICT.md', `VERDICT: ${process.env.STUB_VERDICT || 'APPROVE'}\n- checked the diff\n`)
}
console.log('stub claude: done')
