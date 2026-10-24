---
description: One request → plan (Claude) → code (Gemini tabs) → wiring and checks (you) → review (Claude) → ship and check
argument-hint: "[4|8|9] <task>"
---

# /conveyor [crew] <task>

The text after `/conveyor` is the owner's task, optionally led by the crew size — how many working
accounts (Gemini tabs) this run uses. Run the steps below in order, without asking the
owner anything, except where a step says to stop. The "Conveyor" section of AGENTS.md is the law
here: it overrides anything below, and any rule, skill or workflow that says otherwise.

Every conveyor command is `node conveyor/bin/conveyor.mjs <command>`, run from the project root. Each
ends with one line that starts with `CONVEYOR:` — act on that line: `NEXT` — go on as it says; `FIX`
or `CHECKS FAILED` — do what it says; `REWORK` — redo as the verdict says; `ESCALATE` or `STOP` —
show the owner the message and the lines above it, and stop. Do not edit files under
`conveyor/run/` except the ones a step tells you to save. Report to the owner in the language named
by "reportLanguage" in `conveyor/conveyor.config.json`. If the owner says to stop or cancel, run
`node conveyor/bin/conveyor.mjs abort`.

## 0. Crew and quota
1. The crew: if the owner's message starts with a number that is one of the sizes in "crews" in
   `conveyor/conveyor.config.json` (4, 8 or 9 by default), or says it in words ("на 8 аккаунтах",
   "crew 8"), that is the crew, and the rest of the message is the task. Otherwise — unless "crew"
   in the config is fixed — ask the owner exactly one question, in their language: how many working
   accounts to use this run, listing the sizes; wait for the answer. This is the only question a run
   asks at its start.
2. Run `node conveyor/bin/conveyor.mjs status`. It shows how much of its window each tab has used, as
counted by the conveyor. If the owner told you a tab is near its limit, or the chat in a tab warns
about limits, run `node conveyor/bin/conveyor.mjs status --block <TAB>` for it.
Open View Usage in Antigravity: if 30% or less of the Gemini five-hour limit is left, switch your own
model to a Claude model (Sonnet Thinking) for this whole run.

## 1. Plan — Claude
1. Save the owner's task (without the crew number), exactly as typed, to `conveyor/run/TASK.md`
   (overwrite the file).
2. Run `node conveyor/bin/conveyor.mjs plan --crew <N>` with the crew from step 0. Claude reads the
   code and writes `conveyor/run/CONVEYOR_PLAN.md`, splitting the work over up to N tabs; this takes
   a few minutes. Then read the plan. (`ASK` means the crew was missing: do step 0.1.)

## 2. Code — the browser tabs, through @browser
The plan step printed where each prompt file goes. The quota guard decides it, never you:
- a tab id and address: send it there, as below — a prompt may be sent to another tab than its
  name says ("moved from"), when its own tab had no room;
- "YOU, on your fast Gemini model": write the answer yourself from the prompt file, in its answer
  format, and save it as the inbox file below;
- "YOU, on a Claude model": switch Antigravity's model picker to Sonnet Thinking (Opus Thinking if the
  brief is very hard), write the answer the same way, then switch back.

For each prompt that goes to a tab:
1. With @browser, open the tab's address. Make sure the page is signed in to the tab's account — the
   email the plan step printed: open the account menu (the avatar, top right) and read the email.
   - Another account is open: pick the tab's email in that menu. The address may change to another
     /u/N/ — that is fine, the email is what counts.
   - The email is not in the menu, or Google asks to sign in: do not send there. Run
     `node conveyor/bin/conveyor.mjs status --block <TAB>`, write that part yourself (on a Claude
     model if its brief is heavy), and say so in the report.
   - The tab is named by position ("account at /u/N/") and has no email: send there, but tell the
     owner to name the accounts by email (see `conveyor/README.md`).
2. Start a new chat, make sure the model picker shows the model the plan step named (choose it if
   not), paste the whole prompt file and send it.
3. Send every prompt before waiting for any answer, so the tabs work at the same time — with a crew
   of 8 or 9, go through the tabs one after another, sending, then come back to collect.
4. When an answer has finished (the stop button is gone), press that answer's copy button and save
   the copied text, unchanged, under the prompt's name: `argon-3.prompt.md` → `conveyor/run/inbox/argon-3.md`,
   whichever tab answered it.

If a tab is signed out, says it has hit a limit, or fails twice: run
`node conveyor/bin/conveyor.mjs status --block <TAB>`, write that part yourself from the same prompt
file (on a Claude model if its brief is marked heavy), save it as the same inbox file, and say so in
the report.

5. Run `node conveyor/bin/conveyor.mjs apply`. It writes the files from the answers into the project.
   - `FIX`: in that same chat ask "Send the complete file <path> again, in the same format", save the
     answer as `conveyor/run/inbox/<name>-fix.md` (e.g. `argon-3-fix.md`), and run `apply` again.

## 3. Wiring and checks — you
1. Do exactly what INSTRUCTIONS_FOR_FLASH in the plan says, and nothing more.
2. Run `node conveyor/bin/conveyor.mjs diff`. It runs the project's checks and writes
   `conveyor/run/FOR_REVIEW.md`.
3. `CHECKS FAILED` with a small cause (a typo, a wrong import path, a missing export): fix it and run
   `diff` again. After three rounds, go on to the review anyway.

## 4. Review — Claude
Run `node conveyor/bin/conveyor.mjs review`. Claude reads the diff, fixes what it finds with small
edits and writes `conveyor/run/REVIEW_VERDICT.md`.
- `APPROVE`: go to step 5.
- `REWORK`: do what the verdict asks, then step 3.2 and this step again. After two REWORK rounds,
  stop and show the owner the verdict.
- `ESCALATE`: show the owner the verdict and stop.

Change nothing between an `APPROVE` and step 5: the approval covers only the exact diff that was
reviewed, and `ship` refuses anything else.

## 5. Ship and check
1. Run `node conveyor/bin/conveyor.mjs ship`: the checks again, then commit, push and the project's
   deploy commands.
   - `ESCALATE` with a list of files: show the owner the list and stop. Never add `--owner-ok`
     yourself — only the owner types it.
2. Check what the plan lists under "Check after deploy" — with @browser where it is a page (press
   Ctrl+F5 once on each).
3. Report to the owner in a few lines: what changed, the commit, what you saw, and anything you did
   yourself instead of a tab.
