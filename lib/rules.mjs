// The conveyor's rules as pure functions: how plans, answers and verdicts are read, which paths an
// answer may write, which changes need the owner, what a tab is sent, the quota guard and the secret
// scan. No files and no processes here, so test/rules.test.mjs can pin all of it; bin/conveyor.mjs
// does the I/O around them.

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

// ── The plan ────────────────────────────────────────────────────────────────────────────────────

// The plan as data: its title, STATUS, and each "## " section by name.
export function readPlan(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n')
  const title = (/^#\s+Plan:\s*(.+)$/m.exec(src)?.[1] || '').trim()
  const status = /^\s*STATUS:\s*\**\s*(GO|ESCALATE)\b/m.exec(src)?.[1] || null
  const sections = []
  for (const part of src.split(/^##\s+/m).slice(1)) {
    const nl = part.indexOf('\n')
    sections.push({
      name: (nl < 0 ? part : part.slice(0, nl)).trim(),
      body: nl < 0 ? '' : part.slice(nl + 1).trim(),
    })
  }
  return { title, status, sections }
}

// The first section whose heading starts with `key` ("PROMPT_FOR_ARGON_1 — the backend" counts).
export function section(plan, key) {
  const found = plan.sections.find(s => s.name.toUpperCase().startsWith(key.toUpperCase()))
  return found ? found.body : ''
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

// Where a brief goes: its own tab while that has quota; else the conductor itself on its fast model,
// or — for a brief the plan marked WEIGHT: heavy — on a Claude model, which has a separate limit.
export function routeFor(id, heavy, view) {
  if (view[id]?.available) return 'TAB'
  return heavy ? 'CLAUDE' : 'FLASH'
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
