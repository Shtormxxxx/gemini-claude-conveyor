## Conveyor

One request from the owner runs the whole loop: Antigravity's `/conveyor <task>`
(`.agents/workflows/conveyor.md`). The steps that must be exact are commands of
`node conveyor/bin/conveyor.mjs`; the settings are in `conveyor/conveyor.config.json`; the owner's
guide is `conveyor/README.md`.

| Role | Who | Does |
|---|---|---|
| Architect | Claude, run headless by `conveyor plan` | reads only what the task needs and writes `conveyor/run/CONVEYOR_PLAN.md`: a brief for each tab, the wiring for the conductor, and whether the review must be deep. Writes no long code. |
| Coders | the crew for this run: 4 or 8 working accounts, Gemini in the owner's Chrome (`tabs`, `crews` in the config) | answer `conveyor/run/out/<name>.prompt.md` with whole files |
| Pre-reviewer | a working account that wrote none of the run, through `conveyor prereview` | reads the diff first and sends back whole corrected files for what is plainly wrong |
| Conductor | Antigravity, with @browser | carries prompts and answers, runs every command, wires imports, fixes small build errors |
| Reviewer | Claude, run headless by `conveyor review` | reads the diff in `conveyor/run/FOR_REVIEW.md` (a second review: only what changed), fixes with small edits, writes `VERDICT:` |

What the program enforces, so no agent has to remember it:
- A run starts only from a clean working tree, so its diff is exactly its own work.
- Planning may not change project files; files that may hold secrets are never pasted into a chat,
  and neither is a diff with a line that looks like a key or a working account's email.
- Answers are written only inside the project, and never to secrets, git, installed packages, build
  output, lockfiles, the agents' rules or the conveyor itself; an answer applied once is not applied
  again over later edits. The pre-review may correct only the run's own files.
- Claude reviews only the folder that `conveyor diff` described; the checks run again on its edits.
- `ship` happens only after `VERDICT: APPROVE` of the exact diff in the folder; any edit after the
  review voids the approval.
- Dependencies, CI, `.gitignore`, secrets files, the conveyor, the agents' rules, the paths the owner
  lists in the config, anything that looks like a credential, and very large runs ship only with the
  owner's word: `node conveyor/bin/conveyor.mjs ship --owner-ok`, which only the owner types.
- Working accounts are named by email (`node conveyor/bin/conveyor.mjs accounts …`), kept in the
  git-ignored `conveyor/accounts.local.json` — never write them into a tracked file — and never trusted by
  their /u/N/ position in Chrome, which shifts when accounts sign in or out. Before sending to a tab,
  the conductor checks the email in its account menu; a tab whose account is missing is blocked.
- The crew: each run uses the first N working accounts, N chosen at the start (`plan --crew N`, one of
  "crews"); the plan splits the work over up to N tabs that work at the same time.
- The quota guard: each tab gets `quota.budget` heavy requests per `quota.windowHours` (about 70–75%
  of its real limit). A tab past it is held back and its briefs go to the crew tab with the most room,
  then to a spare (an account outside the crew); when none has room, to the conductor's fast model,
  and briefs marked `WEIGHT: heavy` to a Claude model in Antigravity, which has its own limit.
- Claude's own limits: before and after each plan and review the program reads the real five-hour and
  weekly use from Claude Code. The main model (`claude.model`) works while they allow; the economy
  model (`claude.economy`) takes routine reviews (the plan's `REVIEW: standard`), every step from
  `claude.switchAt`% of the five-hour limit, and every step while the week runs ahead of an even
  pace — what was left at the conveyor's first reading of the week, spread over the days left
  (`status --week-from-now` counts from now); at `claude.stopAt`% no step starts. Claude's steps
  load only five tools — no MCP servers, no skills. Never pass a model to the conveyor yourself.

Everything under `conveyor/run/` is run-time state and is not tracked by git.
