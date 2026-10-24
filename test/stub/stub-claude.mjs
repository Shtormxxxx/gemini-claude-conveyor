// A stand-in for the `claude` CLI in test/cli.test.mjs. It answers --version, --help and auth status;
// in print mode it speaks stream-json like the real one — an init event, a tool use, the limits, a
// result — and plays the architect or the reviewer by writing the files the real one would.
// STUB_PLAN is the plan to write; STUB_VERDICT the verdict (APPROVE by default); STUB_EDIT "path=text"
// a file the reviewer changes; STUB_FIVE and STUB_WEEK the limits used, in percent (10 and 20);
// STUB_REFUSE a limit that refuses the call (five_hour, or seven_day_opus for Opus alone).

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('9.9.9 (stub)'); process.exit(0) }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0) }
if (args[0] === '--help') {
  console.log(['--model', '--effort', '--fallback-model', '--tools', '--allowedTools', '--permission-mode', '--output-format', '--verbose',
    '--strict-mcp-config', '--disable-slash-commands', '--exclude-dynamic-system-prompt-sections', '--no-session-persistence'].join('\n'))
  process.exit(0)
}

const input = readFileSync(0, 'utf8')
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, input, cwd: process.cwd() }) + '\n')
const model = args[args.indexOf('--model') + 1]
const emit = event => console.log(JSON.stringify(event))
// The windows reset at fixed times, as Claude's do: STUB_BASE pins them for a whole test.
const now = Number(process.env.STUB_BASE || Math.floor(Date.now() / 1000))
const refuse = process.env.STUB_REFUSE
const refused = refuse && (refuse === 'five_hour' || model === 'opus')

emit({ type: 'system', subtype: 'init', model: `claude-${model}-stub`, tools: [] })
emit({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: refused ? 'rejected' : 'allowed',
    ...(refused ? { rateLimitType: refuse, resetsAt: now + 3600 } : {}),
    unifiedWindows: {
      five_hour: { utilization: Number(process.env.STUB_FIVE ?? 10) / 100, resetsAt: now + 3 * 3600 },
      seven_day: { utilization: Number(process.env.STUB_WEEK ?? 20) / 100, resetsAt: now + 5 * 24 * 3600 },
    },
  },
})
if (refused) {
  emit({ type: 'result', subtype: 'success', is_error: true, result: 'You have hit your limit', num_turns: 1, total_cost_usd: 0, usage: {} })
  process.exit(1)
}
if (input.includes('You are the architect')) {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: `${process.cwd()}/conveyor/run/CONVEYOR_PLAN.md` } }] } })
  writeFileSync('conveyor/run/CONVEYOR_PLAN.md', process.env.STUB_PLAN || '')
} else if (input.includes('You are the reviewer')) {
  if (process.env.STUB_EDIT) {
    const at = process.env.STUB_EDIT.indexOf('=')
    writeFileSync(process.env.STUB_EDIT.slice(0, at), `${process.env.STUB_EDIT.slice(at + 1)}\n`)
  }
  writeFileSync('conveyor/run/REVIEW_VERDICT.md', `VERDICT: ${process.env.STUB_VERDICT || 'APPROVE'}\n- checked the diff\n`)
}
emit({
  type: 'result', subtype: 'success', is_error: false, result: 'stub claude: done', num_turns: 3, total_cost_usd: 0.42,
  usage: { input_tokens: 5, cache_creation_input_tokens: 12000, cache_read_input_tokens: 30000, output_tokens: 2500 },
})
