// The conveyor's rules as pure functions: how plans, answers and verdicts are read, which paths an
// answer may write, which changes need the owner, what a tab is sent, the pre-review, the quota guard
// for the tabs and the one for Claude's own limits, and the secret scan. No files and no processes
// here, so test/rules.test.mjs can pin all of it; bin/conveyor.mjs does the I/O around them.

import { createHash } from 'node:crypto'

// ── Paths ───────────────────────────────────────────────────────────────────────────────────────

export const cleanPath = raw => String(raw || '').trim()
  .replace(/^[`'"*]+|[`'"*,;]+$/g, '')
  .replace(/\\/g, '/')
  .replace(/^\.\//, '')

// A path from a plan or an answer, relative to the project root — or why it cannot be one.
export function projectPath(raw) {
  const path = cleanPath(raw)
  if (!path) return { ok: false, path, reason: 'an empty path' }
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return { ok: false, path, reason: 'an absolute path' }
  if (path.split('/').includes('..')) return { ok: false, path, reason: 'outside the project' }
  return { ok: true, path }
}

// [{ re, reason }] from config entries, each a pattern string or { pattern, reason }.
export function compileRules(entries, fallbackReason) {
  return (entries || []).map(entry => typeof entry === 'string'
    ? { re: new RegExp(entry), reason: fallbackReason }
    : { re: new RegExp(entry.pattern), reason: entry.reason || fallbackReason })
}

// The reason of the first rule that matches `path`, or null.
export const firstMatch = (rules, path) => rules.find(r => r.re.test(path))?.reason ?? null

// The changed paths that need the owner before they ship, each with its reason.
export function ownerReasons(paths, rules) {
  return paths.flatMap(path => {
    const reason = firstMatch(rules, path)
    return reason ? [{ path, reason }] : []
  })
}

// The deploy commands this change calls for: plain strings always, { run, when } when a changed
// path matches `when`.
export function deployFor(entries, paths) {
  return (entries || []).flatMap(entry => {
    if (typeof entry === 'string') return [entry]
    return !entry.when || paths.some(p => new RegExp(entry.when).test(p)) ? [entry.run] : []
  })
}

// ARGON_1 → argon-1, for file names.
export const slug = id => String(id).toLowerCase().replace(/_/g, '-')

// ── Working accounts ────────────────────────────────────────────────────────────────────────────
//
// In Chrome, /u/N/ is not an account: it is the Nth account in the order they signed in, and it shifts
// when one signs out or back in — so the second working account may sit at /u/2/ today and /u/5/
// tomorrow. A tab is therefore named by its account's email, and Gemini is opened with ?authuser=<email>,
// which Google resolves to whatever position that account has now. A tab given only by position still
// works, but doctor warns about it.

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// The address a tab is opened at: its own url when the config gives one, else Gemini for its account.
export const tabUrl = tab => tab.url || `https://gemini.google.com/app?authuser=${encodeURIComponent(tab.account)}`

// The /u/N/ position a url pins, or null.
export const positionOf = url => {
  const m = /\/u\/(\d+)(\/|$)/.exec(String(url || ''))
  return m ? Number(m[1]) : null
}

// How a tab is shown to people and agents: its account, or its position when it has none.
export const tabLabel = tab => tab.account || (positionOf(tab.url) !== null ? `account at /u/${positionOf(tab.url)}/ (by position)` : tab.url)

// ── The plan ────────────────────────────────────────────────────────────────────────────────────

// The plan as data: its title, STATUS, REVIEW (deep or standard, null when missing), and each "## "
// section by name.
export function readPlan(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n')
  const title = (/^#\s+Plan:\s*(.+)$/m.exec(src)?.[1] || '').trim()
  const status = /^\s*STATUS:\s*\**\s*(GO|ESCALATE)\b/m.exec(src)?.[1] || null
  const review = /^\s*REVIEW:\s*\**\s*(deep|standard)\b/im.exec(src)?.[1]?.toLowerCase() || null
  const sections = []
  for (const part of src.split(/^##\s+/m).slice(1)) {
    const nl = part.indexOf('\n')
    sections.push({
      name: (nl < 0 ? part : part.slice(0, nl)).trim(),
      body: nl < 0 ? '' : part.slice(nl + 1).trim(),
    })
  }
  return { title, status, review, sections }
}

// The first section whose heading starts with `key` ("PROMPT_FOR_ARGON_1 — the backend" counts).
export function section(plan, key) {
  const found = plan.sections.find(s => s.name.toUpperCase().startsWith(key.toUpperCase()))
  return found ? found.body : ''
}

// Folders of nothing but images, fonts or media are one line in the map, whatever their depth.
const ASSET = /\.(png|jpe?g|gif|webp|avif|ico|bmp|svg|woff2?|ttf|otf|eot|mp[34]|wav|ogg|webm|mov|pdf|zip|gz)$/i

// The project's files for the architect in at most `max` lines, so it can go straight to the files a
// task needs instead of spending turns looking around: every file when they fit, else the deepest
// folders folded into one line each ("src/data/lessons/ — 214 files").
export function fileMap(paths, max = 250) {
  const root = { name: '', dirs: new Map(), files: [] }
  for (const path of paths) {
    const parts = String(path).split('/').filter(Boolean)
    if (!parts.length) continue
    let node = root
    for (const dir of parts.slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { name: dir, dirs: new Map(), files: [] })
      node = node.dirs.get(dir)
    }
    node.files.push(parts[parts.length - 1])
  }
  const count = node => node.files.length + [...node.dirs.values()].reduce((n, d) => n + count(d), 0)
  const assets = node => node.files.every(f => ASSET.test(f)) && [...node.dirs.values()].every(assets)
  const depth = node => 1 + Math.max(0, ...[...node.dirs.values()].map(depth))
  const render = (node, prefix, level, limit, out) => {
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${prefix}${dir.name}/`
      if (assets(dir)) out.push(`${path} — ${count(dir)} files (images, fonts, media)`)
      else if (level >= limit) out.push(`${path} — ${count(dir)} files`)
      else render(dir, path, level + 1, limit, out)
    }
    for (const file of [...node.files].sort()) out.push(`${prefix}${file}`)
    return out
  }
  for (let limit = depth(root); limit >= 1; limit--) {
    const out = render(root, '', 1, limit, [])
    if (out.length <= max) return out.join('\n')
  }
  const out = render(root, '', 1, 1, [])
  return [...out.slice(0, max), `… and ${out.length - max} more`].join('\n')
}

// A PROMPT_FOR_<TAB> section: the brief, its WEIGHT, and the files the program pastes in after it.
// NONE, or nothing, means that tab sits this run out.
export function readBrief(body) {
  const text = String(body || '').trim()
  if (!text || /^NONE\b/i.test(text)) return null
  const attach = []
  let heavy = false
  const prompt = text.split('\n').filter(line => {
    const weight = /^\s*(?:[-*]\s*)?WEIGHT:\s*(\w+)/i.exec(line)
    if (weight) { heavy = weight[1].toLowerCase() === 'heavy'; return false }
    const m = /^\s*(?:[-*]\s*)?ATTACH:\s*(.*)$/i.exec(line)
    if (!m) return true
    attach.push(...m[1].split(/[,\s]+/).map(cleanPath).filter(p => p && !/^none$/i.test(p)))
    return false
  }).join('\n').trim()
  if (!prompt) return null
  return { prompt, attach: [...new Set(attach)], heavy }
}

// ── What a tab is sent, and what comes back ─────────────────────────────────────────────────────

const LANGS = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', vue: 'vue', svelte: 'svelte',
  css: 'css', scss: 'scss', html: 'html', json: 'json', jsonc: 'jsonc', md: 'md', yml: 'yaml',
  yaml: 'yaml', py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby',
  php: 'php', cs: 'csharp', sh: 'bash', sql: 'sql', toml: 'toml',
}
export const langFor = path => LANGS[(/\.([^./]+)$/.exec(path)?.[1] || '').toLowerCase()] ?? ''

// A fence longer than any backtick run inside, so a file holding ``` cannot close its own block.
export function fenceFor(content) {
  const runs = String(content).match(/`{3,}/g) || []
  return '`'.repeat(Math.max(3, ...runs.map(r => r.length + 1)))
}

export function block(content, lang = '') {
  const fence = fenceFor(content)
  return `${fence}${lang}\n${String(content).replace(/\n$/, '')}\n${fence}`
}

export const ANSWER_FORMAT = `HOW TO ANSWER — a program reads your answer, so follow this exactly:
1. For every file you create or change, give the WHOLE file: never a fragment, a diff or "rest unchanged".
2. Right before each file, on its own line and outside any code block, write: === FILE: path/from/project/root ===
3. Then the file in ONE fenced code block. If the file itself contains \`\`\`, fence it with four backticks.
4. Paths are relative to the project root, with forward slashes, exactly as in CURRENT FILES for existing files.
5. Change only what the task needs; keep everything else in a file exactly as it is, comments included.
6. No text between files. After the last file, at most five lines of notes.`

// The text pasted into a tab: the project, the brief, the current files it needs, and the format.
export function tabPrompt({ project, prompt, files = [] }) {
  const parts = [
    `You are writing code for a project you cannot see. ${project || ''}`.trim(),
    'Everything you need is below.',
    `TASK\n${prompt}`,
  ]
  if (files.length) {
    parts.push('CURRENT FILES')
    for (const f of files) {
      parts.push(f.missing
        ? `=== FILE: ${f.path} === (does not exist yet — create it)`
        : `=== FILE: ${f.path} ===\n${block(f.content, langFor(f.path))}`)
    }
  }
  parts.push(ANSWER_FORMAT)
  return parts.join('\n\n') + '\n'
}

// "=== FILE: path ===", tolerating the bold, heading or comment marks a chat UI may add around it.
const MARKER = /^\s*(?:[#>*_`]+\s*|\/\/\s*)*=+\s*FILE:\s*(.+?)\s*=+\s*[*_`]*\s*$/i
const FENCE = /^(\s*)(`{3,}|~{3,})([^`]*)$/
const CLOSE = /^\s*(`{3,}|~{3,})\s*$/

// The files in an answer copied from a tab, and what is wrong with it: each problem names its file
// when it has one. A block that never closes means the answer was cut off — that file is reported,
// not written half-done.
export function readAnswer(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const files = []
  const problems = []
  let i = 0
  while (i < lines.length) {
    const marker = MARKER.exec(lines[i])
    if (!marker) { i++; continue }
    const path = cleanPath(marker[1])
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    const open = j < lines.length ? FENCE.exec(lines[j]) : null
    if (!open) {
      problems.push({ path, message: 'no code block after its FILE line' })
      i = j
      continue
    }
    const fence = open[2]
    const indent = new RegExp(`^ {0,${open[1].length}}`)
    const body = []
    let k = j + 1
    let closed = false
    for (; k < lines.length; k++) {
      const close = CLOSE.exec(lines[k])
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) { closed = true; break }
      body.push(lines[k].replace(indent, ''))
    }
    if (!closed) {
      problems.push({ path, message: 'its code block never closes — the answer was probably cut off' })
      break
    }
    files.push({ path, content: body.join('\n') + '\n' })
    i = k + 1
  }
  if (!files.length && !problems.length) problems.push({ path: null, message: 'no "=== FILE: path ===" blocks in the answer' })
  return { files, problems }
}

// ── The pre-review ──────────────────────────────────────────────────────────────────────────────
//
// Before Claude sees a run's diff, a working account that wrote none of it reads it with fresh eyes
// and sends back whole corrected files for what is plainly wrong. Claude then reviews the whole diff,
// those fixes included, as before — the pre-review only spares it the rounds spent on mistakes a
// cheaper reader catches.

export const PREREVIEW_FORMAT = `HOW TO ANSWER — a program reads your answer, so follow this exactly:
1. The first line is exactly PREREVIEW: PASS (nothing to fix) or PREREVIEW: FIX.
2. Then each problem on its own line: - path/of/file: what is wrong and why. At most 15 lines.
3. With FIX, for every file you correct: on its own line === FILE: path/from/project/root ===, then the
   WHOLE corrected file in ONE fenced code block (four backticks if it contains \`\`\`). Fix only the
   problems you listed; keep everything else in the file exactly as it is.`

// The text pasted into the pre-review tab. `files` are the changed files as they are now; without
// them the reader can only list problems, and is told so.
export function prereviewPrompt({ project, task, goal, checks, diff, files = null }) {
  const parts = [
    `You are the first reviewer of a change to a project you cannot see. ${project || ''}`.trim(),
    'A senior reviewer reads the change after you. Your job: catch what is plainly wrong, so it reaches them clean.',
    `THE TASK\n${task}`,
  ]
  if (goal) parts.push(`WHAT THE CHANGE MUST DO\n${goal}`)
  parts.push(`CHECKS (lint, tests, build)\n${checks}`)
  parts.push(`LOOK FOR
- bugs: wrong logic, a broken import or export, an unhandled empty, null or error case, a crash;
- behaviour that differs from the task, or breaks something that worked;
- security: user data another user could read or change, unescaped HTML, a secret in the code;
- leftovers: debug output, dead code, a TODO standing in for the work;
- invented content presented as fact: testimonials, numbers, people.
Do not restyle, rename or refactor, and add nothing the task did not ask for. If all is well, say PASS.`)
  parts.push(`THE DIFF\n${block(diff, 'diff')}`)
  if (files?.length) {
    parts.push('THE CHANGED FILES AS THEY ARE NOW')
    for (const f of files) parts.push(`=== FILE: ${f.path} ===\n${block(f.content, langFor(f.path))}`)
    parts.push(PREREVIEW_FORMAT)
  } else {
    parts.push(PREREVIEW_FORMAT.replace(/\n3\. With FIX[\s\S]*$/, '\n3. The change is too large to send the files: list the problems only, and send no files.'))
  }
  return parts.join('\n\n') + '\n'
}

// The pre-review's answer: PASS or FIX (null when the line is missing), the problems it lists, and
// the files it sends back, read like any answer.
export function readPrereview(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n')
  const verdict = /^\s*\**\s*PREREVIEW:\s*\**\s*(PASS|FIX)\b/m.exec(src)?.[1] || null
  const head = src.split('\n')
  const firstFile = head.findIndex(line => MARKER.test(line))
  const issues = (firstFile < 0 ? head : head.slice(0, firstFile))
    .filter(line => /^\s*[-*•]\s+\S/.test(line))
    .map(line => line.replace(/^\s*[-*•]\s+/, '').trim())
    .slice(0, 30)
  const { files, problems } = firstFile < 0 ? { files: [], problems: [] } : readAnswer(src.split('\n').slice(firstFile).join('\n'))
  return { verdict, issues, files, problems }
}

// The tab for the pre-review: one with room that wrote no code in this run, the most room first (in
// the order of the tabs on a tie); else any tab with room; else null.
export function prereviewTab(view, ids, coders = []) {
  const free = ids.filter(id => view[id]?.available && view[id].used < view[id].budget)
  const best = list => [...list].sort((a, b) =>
    (view[b].budget - view[b].used) - (view[a].budget - view[a].used) || ids.indexOf(a) - ids.indexOf(b))[0] ?? null
  return best(free.filter(id => !coders.includes(id))) ?? best(free)
}

// ── The review ──────────────────────────────────────────────────────────────────────────────────

export const VERDICTS = ['APPROVE', 'REWORK', 'ESCALATE']

// The first "VERDICT: X" at the start of a line, or null.
export function readVerdict(text) {
  return /^\s*\**\s*VERDICT:\s*\**\s*(APPROVE|REWORK|ESCALATE)\b/m.exec(String(text || ''))?.[1] || null
}

// What the reviewer approved, as one hash: any edit after the review gives a different one.
export const fingerprint = text => createHash('sha256').update(String(text)).digest('hex')

// ── The secret scan ─────────────────────────────────────────────────────────────────────────────

const SECRET_SHAPES = [
  [/AIza[0-9A-Za-z_-]{35}/, 'a Google API key'],
  [/\bAQ\.[A-Za-z0-9_-]{30,}/, 'a Google API key'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, 'an OpenAI API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b[rs]k_live_[0-9a-zA-Z]{20,}/, 'a Stripe live key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
]

// Lines a diff adds that look like a credential: [{ file, kind, sample }], the sample masked.
export function scanSecrets(diff) {
  const found = []
  let file = null
  for (const line of String(diff || '').split('\n')) {
    const head = /^\+\+\+ b\/(.+)$/.exec(line)
    if (head) { file = head[1]; continue }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    for (const [re, kind] of SECRET_SHAPES) {
      const m = re.exec(line)
      if (m) { found.push({ file, kind, sample: `${m[0].slice(0, 6)}…` }); break }
    }
  }
  return found
}

// Lines a diff adds that carry one of the working accounts' emails, which are kept out of git on
// purpose: [{ file, kind, sample }], the address masked.
export function scanEmails(diff, emails) {
  const wanted = emails.filter(Boolean).map(e => e.toLowerCase())
  if (!wanted.length) return []
  const found = []
  let file = null
  for (const line of String(diff || '').split('\n')) {
    const head = /^\+\+\+ b\/(.+)$/.exec(line)
    if (head) { file = head[1]; continue }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const hit = wanted.find(e => line.toLowerCase().includes(e))
    if (hit) found.push({ file, kind: 'a working account\'s email', sample: `${hit[0]}…@${hit.split('@')[1]}` })
  }
  return found
}

// ── The quota guard ─────────────────────────────────────────────────────────────────────────────
//
// No outside program can read how much of a tab's limit is left, so the conveyor counts what it
// sends: every prompt routed to a tab is one heavy request in a rolling window. At `budget` requests
// — set to about 70–75% of the real limit — the tab is held back until the oldest request leaves the
// window, and the rest stays in reserve. Use outside the conveyor is invisible to this count;
// `status --block <TAB>` records what the owner sees.

// Each tab as of `now`: requests in the window, whether it takes another, and when it frees.
export function quotaView(state, now, { ids, budget, windowMs }) {
  const view = {}
  for (const id of ids) {
    const entry = state?.[id] || {}
    const sent = (entry.sent || []).map(t => Date.parse(t)).filter(t => t > now - windowMs).sort((a, b) => a - b)
    const blockedUntil = entry.blockedUntil && Date.parse(entry.blockedUntil) > now ? Date.parse(entry.blockedUntil) : null
    const full = sent.length >= budget
    const freesAt = blockedUntil ?? (full ? sent[sent.length - budget] + windowMs : null)
    view[id] = { used: sent.length, budget, available: !blockedUntil && !full, freesAt }
  }
  return view
}

// The state with one more request on `id`, and anything older than the window dropped.
export function recordSent(state, id, now, windowMs) {
  const entry = { ...(state?.[id] || {}) }
  entry.sent = [...(entry.sent || []).filter(t => Date.parse(t) > now - windowMs), new Date(now).toISOString()]
  return { ...state, [id]: entry }
}

// Which tab answers each brief, within the crew the owner chose for this run. A brief keeps its own tab
// while that has room; a brief whose tab is held back (or lies outside the crew) goes to the crew tab
// with the fewest briefs so far and the most room, so the work stays spread out; when no crew tab has
// room, to a spare — a working account outside the crew — the same way, so the crew stays at full
// strength; when none has room either, to the conductor itself — on its fast model, or on a Claude
// model when the brief is heavy.
// → { [briefId]: { route: 'TAB', tab, spare? } | { route: 'FLASH' } | { route: 'CLAUDE' } }
export function assignTabs(briefs, view, crew, spares = []) {
  const all = [...crew, ...spares.filter(id => !crew.includes(id))]
  const room = Object.fromEntries(all.map(id => [id, view[id]?.available ? view[id].budget - view[id].used : 0]))
  const load = Object.fromEntries(all.map(id => [id, 0]))
  const out = {}
  const waiting = []
  for (const brief of briefs) {
    if (crew.includes(brief.id) && room[brief.id] > 0) {
      room[brief.id]--
      load[brief.id]++
      out[brief.id] = { route: 'TAB', tab: brief.id }
    } else {
      waiting.push(brief)
    }
  }
  const pick = ids => ids.filter(id => room[id] > 0).sort((a, b) => load[a] - load[b] || room[b] - room[a])[0]
  for (const brief of waiting) {
    const tab = pick(crew) ?? pick(all.slice(crew.length))
    if (tab) {
      room[tab]--
      load[tab]++
      out[brief.id] = crew.includes(tab) ? { route: 'TAB', tab } : { route: 'TAB', tab, spare: true }
    } else {
      out[brief.id] = { route: brief.heavy ? 'CLAUDE' : 'FLASH' }
    }
  }
  return out
}

// The crew size from `--crew 8` or `--crew=8`, the accounts from `--accounts a,b` (or --accounts=a,b),
// and the args without them. → { crew, accounts, rest }
export function readCrewArg(args) {
  const rest = []
  let crew = null
  let accounts = null
  for (let i = 0; i < args.length; i++) {
    const size = /^--crew(?:=(\d+))?$/.exec(args[i])
    const named = /^--accounts(?:=(.*))?$/.exec(args[i])
    if (size) crew = Number(size[1] ?? args[++i])
    else if (named) accounts = String(named[1] ?? args[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    else rest.push(args[i])
  }
  return { crew, accounts, rest }
}

// The working accounts the owner named, in the owner's order. Each name is a whole email, a part of
// one before the @ ("aliseevna"), a tab id (ARGON_3) or its number (3); commas split names too.
// A name that fits no account, or more than one, is a problem to put back to the owner.
// → { ids, problems }
export function pickAccounts(tabs, names) {
  const ids = []
  const problems = []
  for (const raw of names.flatMap(n => String(n).split(',')).map(n => n.trim()).filter(Boolean)) {
    const name = raw.toLowerCase()
    const email = tab => String(tab.account || '').toLowerCase()
    const exact = tabs.filter(t => t.id.toLowerCase() === name || t.id.toLowerCase() === `argon_${name}` || email(t) === name)
    const found = exact.length ? exact : tabs.filter(t => t.account && email(t).split('@')[0].includes(name))
    if (found.length > 1) problems.push(`"${raw}" fits ${found.map(t => t.account || t.id).join(', ')} — which one?`)
    else if (!found.length) problems.push(`"${raw}" fits no working account`)
    else if (ids.includes(found[0].id)) problems.push(`"${raw}" is ${found[0].account || found[0].id}, named already`)
    else ids.push(found[0].id)
  }
  if (!ids.length && !problems.length) problems.push('no account was named')
  return { ids, problems }
}

// ── Claude's own limits ─────────────────────────────────────────────────────────────────────────
//
// Claude Code knows how much of the subscription's five-hour and weekly limits is used, and says so:
// run with --output-format stream-json, a session emits a rate_limit_event after its first request
// (only then, however long it runs). So the conveyor reads the limits with a tiny call before and after
// each Claude step: the guard works on the real numbers — the owner's own use of Claude included —
// and the difference is what the step cost.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// { fiveHour: { used, resetsAt } | null, week: … | null, rejected: { resetsAt, type } | null } from a
// rate_limit_info, or null when it tells nothing: used is a fraction (0.31), resetsAt a time in ms.
export function readLimits(info) {
  if (!info || typeof info !== 'object') return null
  const at = s => (typeof s === 'number' ? s * 1000 : null)
  const window = w => (w && typeof w.utilization === 'number' ? { used: w.utilization, resetsAt: at(w.resetsAt) } : null)
  const windows = info.unifiedWindows || {}
  const fiveHour = window(windows.five_hour) ?? (info.rateLimitType === 'five_hour' ? window(info) : null)
  const week = window(windows.seven_day) ?? (info.rateLimitType === 'seven_day' ? window(info) : null)
  const rejected = info.status === 'rejected' ? { resetsAt: at(info.resetsAt), type: info.rateLimitType || null } : null
  return fiveHour || week || rejected ? { fiveHour, week, rejected } : null
}

// What one stream-json run of Claude Code reported: the model, the last limits it gave, whether it
// finished well, its closing text, its cost in API dollars, its turns and tokens.
export function readClaudeStream(text) {
  let model = null
  let limits = null
  let result = null
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('{')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'system' && event.subtype === 'init') model = event.model ?? model
    else if (event.type === 'rate_limit_event') limits = readLimits(event.rate_limit_info) ?? limits
    else if (event.type === 'result') result = event
  }
  const usage = result?.usage || {}
  return {
    model,
    limits,
    ok: Boolean(result) && !result.is_error && result.subtype === 'success',
    text: typeof result?.result === 'string' ? result.result.trim() : '',
    costUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
    turns: result?.num_turns ?? null,
    tokensIn: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
    tokensOut: usage.output_tokens || 0,
  }
}

// How far into the current week the clock is, from the week's reset time: 0 at its start, 1 at its end.
export const weekPassed = (resetsAt, now) => Math.min(1, Math.max(0, 1 - (resetsAt - now) / WEEK_MS))

// The share of the week an even pace would have spent by `now`, counted from `base` — the week's use
// when the conveyor first saw this week, or when the owner said to count from then. What was spent
// before the base stays as it is, whoever spent it; what was left is spread evenly over the rest of
// the week. Without a base for this week, from the week's start. → a fraction, or null
export function weekPace(week, now, base = null) {
  if (!week?.resetsAt) return null
  const from = base && Math.abs((base.resetsAt ?? 0) - week.resetsAt) < 60 * 1000 ? base : { used: 0, at: week.resetsAt - WEEK_MS }
  const span = week.resetsAt - from.at
  if (span <= 0) return 1
  return from.used + (1 - from.used) * Math.min(1, Math.max(0, (now - from.at) / span))
}

// A window's use as of `now`: none once it has reset.
const usedNow = (window, now) => (window && !(window.resetsAt && window.resetsAt <= now) ? window.used : 0)

// Which model the next Claude step runs on, from the limits as last read:
// - stop, when Claude refuses for now, or the five-hour or weekly limit is at stopAt% — the step would
//   be cut off halfway, which wastes what it spent;
// - the economy model for a routine review, from switchAt% of the five-hour limit, while the week is
//   being spent faster than an even pace (more than weekAhead points ahead of weekPace, from
//   `weekBase`), and while Claude refuses the main model alone (a weekly cap on it) — until
//   `mainRefusedUntil`;
// - the main model otherwise, and when there is no reading.
// → { tier: 'main' | 'economy' | 'stop', model, effort, why, until? }
export function claudeChoice(limits, now, claude, { routine = false, mainRefusedUntil = 0, weekBase = null } = {}) {
  const pct = n => `${Math.round(n)}%`
  const five = usedNow(limits?.fiveHour, now) * 100
  const week = usedNow(limits?.week, now) * 100
  const stop = (why, until) => ({ tier: 'stop', model: null, effort: null, why, until: until ?? null })
  const main = why => ({ tier: 'main', model: claude.model, effort: claude.effort, why })
  const economy = why => ({ tier: 'economy', model: claude.economy.model, effort: claude.economy.effort, why })
  if (limits?.rejected && !(limits.rejected.resetsAt && limits.rejected.resetsAt <= now)) {
    return stop(`Claude refuses for now (${limits.rejected.type?.replace('_', '-') || 'a usage limit'} reached)`, limits.rejected.resetsAt)
  }
  if (five >= claude.stopAt) return stop(`the five-hour limit is at ${pct(five)}`, limits.fiveHour.resetsAt)
  if (week >= claude.stopAt) return stop(`the weekly limit is at ${pct(week)}`, limits.week.resetsAt)
  if (routine) return economy('a routine review (the plan says REVIEW: standard)')
  if (mainRefusedUntil > now) return economy(`Claude refuses ${claude.model} for now`)
  if (five >= claude.switchAt) return economy(`the five-hour limit is at ${pct(five)}; from ${claude.switchAt}% the economy model works`)
  if (claude.weekAhead !== null && limits?.week?.resetsAt && week > 0) {
    const pace = weekPace(limits.week, now, weekBase) * 100
    if (week > pace + claude.weekAhead) return economy(`the week is ${pct(week)} spent, ahead of an even pace (${pct(pace)} by now), so it is saved for later`)
  }
  return main(limits ? `the five-hour limit is at ${pct(five)}, the week at ${pct(week)}` : 'Claude Code reported no limits')
}

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────

// Fill {{KEY}} placeholders in one pass, so a value that contains "{{X}}" stays as it is.
export const fill = (template, values) =>
  String(template).replace(/\{\{([A-Z_]+)\}\}/g, (all, key) => (key in values ? String(values[key]) : all))

// The last `max` lines of a command's output.
export function tail(text, max) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').trimEnd().split('\n')
  return lines.length <= max ? lines.join('\n') : ['…', ...lines.slice(-max)].join('\n')
}
