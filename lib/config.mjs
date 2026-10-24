// conveyor/conveyor.config.json → a checked config with every default filled in. The built-in guards
// are added to whatever the project lists and are never replaced by it: a config can protect more,
// never less.

import { compileRules } from './rules.mjs'

export const DEFAULTS = {
  project: '',
  reportLanguage: 'Russian',
  checks: [],
  deploy: [],
  push: true,
  claude: { model: 'opus' },
  tabs: [
    { id: 'ARGON_1', url: 'https://gemini.google.com/u/1/app', model: 'Gemini 4 Argon' },
    { id: 'ARGON_2', url: 'https://gemini.google.com/u/2/app', model: 'Gemini 4 Argon' },
  ],
  quota: { budget: 12, windowHours: 5 },
  limits: { maxChangedFiles: 60, maxDiffChars: 150000 },
  secrets: [],
  neverWrite: [],
  ownerOnly: [],
  ecc: { enabled: true, version: '2.2.3', profile: 'minimal', target: 'antigravity' },
}

// Files that may hold credentials, in any folder. Nothing that matches is pasted into a chat or
// written from one.
export const BUILT_IN_SECRETS = [
  '(^|/)\\.env($|\\.)',
  '(^|/)\\.dev\\.vars',
  '(^|/)\\.npmrc$',
  '(^|/)\\.netrc$',
  '(^|/)\\.mcp\\.json$',
  '(^|/)id_(rsa|ed25519|ecdsa)',
  '\\.(pem|key|p12|pfx|keystore|jks)$',
  '(^|/)(credentials|service[-_]?account|secrets?)[^/]*\\.(json|ya?ml)$',
  '(^|/)\\.claude/settings\\.local\\.json$',
]

// The conveyor — its program, its config and its run files — and the rules every agent reads. A run
// must not be able to loosen the gates it is held to, so answers never write these and changes to
// them never ship without the owner. (conveyor/run/ is git-ignored, so it never shows in a diff.)
const CONVEYOR = '^(conveyor/|\\.agents/|\\.agent/|AGENTS\\.md$|CLAUDE\\.md$|GEMINI\\.md$)'

export const BUILT_IN_NEVER_WRITE = [
  { pattern: CONVEYOR, reason: 'the conveyor or the agents\' rules' },
  { pattern: '^\\.git(/|$)', reason: 'git\'s own files' },
  { pattern: '(^|/)(node_modules|\\.venv|venv|__pycache__)/', reason: 'installed packages' },
  { pattern: '^(dist|build|\\.next|\\.nuxt|\\.svelte-kit|\\.output|\\.firebase|\\.wrangler|\\.vercel)/', reason: 'build or tool output' },
  { pattern: '(^|/)(package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|bun\\.lockb?|poetry\\.lock|Pipfile\\.lock|Cargo\\.lock|go\\.sum|composer\\.lock|Gemfile\\.lock)$', reason: 'a lockfile (only the package manager writes it)' },
  { pattern: '^\\.claude/', reason: 'Claude Code\'s settings' },
]

export const BUILT_IN_OWNER_ONLY = [
  { pattern: CONVEYOR, reason: 'the conveyor itself or the agents\' rules' },
  { pattern: '(^|/)(package\\.json|package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|bun\\.lockb?|requirements[^/]*\\.txt|pyproject\\.toml|poetry\\.lock|Pipfile(\\.lock)?|go\\.(mod|sum)|Cargo\\.(toml|lock)|Gemfile(\\.lock)?|composer\\.(json|lock))$', reason: 'dependencies, and the scripts the checks run' },
  { pattern: '^(\\.github|\\.gitlab|\\.circleci)/|^\\.gitlab-ci\\.yml$|(^|/)(Dockerfile|docker-compose[^/]*\\.ya?ml)$', reason: 'CI and infrastructure' },
  { pattern: '(^|/)\\.gitignore$', reason: 'what git ignores — it can hide files from the review' },
]

const ID = /^[A-Z][A-Z0-9_]*$/

// { config, problems }: the project's config over the defaults, and what is wrong with it.
export function readConfig(text) {
  const problems = []
  let raw = {}
  try {
    raw = text ? JSON.parse(text) : {}
  } catch (e) {
    return { config: DEFAULTS, problems: [`conveyor.config.json is not valid JSON: ${e.message}`] }
  }
  const config = {
    ...DEFAULTS,
    ...raw,
    claude: { ...DEFAULTS.claude, ...raw.claude },
    quota: { ...DEFAULTS.quota, ...raw.quota },
    limits: { ...DEFAULTS.limits, ...raw.limits },
    ecc: { ...DEFAULTS.ecc, ...raw.ecc },
    tabs: raw.tabs ?? DEFAULTS.tabs,
  }

  if (typeof config.project !== 'string') problems.push('"project" must be a sentence about the project')
  if (!Array.isArray(config.checks) || config.checks.some(c => typeof c !== 'string')) problems.push('"checks" must be a list of commands')
  if (!Array.isArray(config.deploy) || config.deploy.some(d => typeof d !== 'string' && typeof d?.run !== 'string')) {
    problems.push('"deploy" must be a list of commands, or of { "run": command, "when": regex }')
  }
  if (!Array.isArray(config.tabs)) {
    problems.push('"tabs" must be a list')
  } else {
    const ids = new Set()
    for (const tab of config.tabs) {
      if (!ID.test(tab?.id || '')) problems.push(`tab id "${tab?.id}" must be UPPER_CASE, like ARGON_1`)
      else if (ids.has(tab.id)) problems.push(`tab id ${tab.id} appears twice`)
      else ids.add(tab.id)
      if (!/^https:\/\//.test(tab?.url || '')) problems.push(`tab ${tab?.id}: "url" must start with https://`)
    }
  }
  if (!(config.quota.budget >= 1)) problems.push('"quota.budget" must be 1 or more')
  if (!(config.quota.windowHours > 0)) problems.push('"quota.windowHours" must be more than 0')
  for (const key of ['secrets', 'neverWrite', 'ownerOnly']) {
    if (!Array.isArray(config[key])) { problems.push(`"${key}" must be a list`); continue }
    try { compileRules(config[key], key) } catch (e) { problems.push(`"${key}" has a pattern that is not a valid regex: ${e.message}`) }
  }
  for (const entry of Array.isArray(config.deploy) ? config.deploy.filter(d => d?.when) : []) {
    try { new RegExp(entry.when) } catch (e) { problems.push(`deploy "when" is not a valid regex: ${e.message}`) }
  }
  return { config, problems }
}

// The guards in force: the built-ins first, then the project's own.
export function guards(config) {
  const secrets = compileRules([...BUILT_IN_SECRETS, ...config.secrets], 'a file that may hold secrets')
  return {
    secrets,
    neverWrite: [...secrets, ...compileRules([...BUILT_IN_NEVER_WRITE, ...config.neverWrite], 'a protected path')],
    ownerOnly: [...compileRules(BUILT_IN_OWNER_ONLY), ...secrets, ...compileRules(config.ownerOnly, 'a path the owner protects')],
  }
}
