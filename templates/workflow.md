---
description: One request → plan (Claude) → code (Gemini tabs) → wiring and checks (you) → pre-review (a free tab) → review (Claude) → ship and check
argument-hint: "[which accounts] <task>"
---

# /conveyor [accounts] <task>

The text after `/conveyor` is the owner's task, optionally led by which working accounts (Gemini tabs)
to use. Run the steps below in order, without asking the owner anything, except where a step says to
ask or to stop. The "Conveyor" section of AGENTS.md is the law
here: it overrides anything below, and any rule, skill or workflow that says otherwise.

Every conveyor command is `node conveyor/bin/conveyor.mjs <command>`, run from the project root. Each
ends with one line that starts with `CONVEYOR:` — act on that line: `NEXT` — go on as it says; `FIX`
or `CHECKS FAILED` — do what it says; `REWORK` — redo as the verdict says; `ESCALATE` or `STOP` —
show the owner the message and the lines above it, and stop. Do not edit files under
`conveyor/run/` except the ones a step tells you to save. Report to the owner in the language named
by "reportLanguage" in `conveyor/conveyor.config.json`. If the owner says to stop or cancel, run
`node conveyor/bin/conveyor.mjs abort`.

## 0. Accounts for this session, and quota
1. The accounts. A session is this conversation; its accounts are chosen at its first `/conveyor`,
   every conversation anew, even if another conversation chose them before.
   - Run `node conveyor/bin/conveyor.mjs accounts`: it lists the working accounts, id and email.
   - If the owner's message already says which to use ("на алисеевне и меломане: …", "только ne.gretta",
     "3 аккаунта: 1, 4, 6"), that is the answer. Otherwise ask exactly one question, in the owner's
     language, showing the list: how many accounts this session uses, and which. Wait for the answer.
     A number alone ("2 аккаунта") still needs which: offer the first ones and let the owner change it.
   - The owner names accounts loosely: a part of the email, a nickname, in another alphabet
     ("алисеевна" for aliseevna…@gmail.com), a number from the list. Match each to one email from the
     list. If a name fits none or more than one, ask once more about that name only.
   - Run `node conveyor/bin/conveyor.mjs session <email> <email> …` with the emails you matched. Add
     `--spares` only if the owner allows the other accounts to stand in when these run out of quota.
   - Later runs in this same conversation keep that choice and ask nothing, unless the owner names
     other accounts — then run `session` again with them.
   Any number of accounts works, from one to all of them.
2. Run `node conveyor/bin/conveyor.mjs status`. It shows Claude's limits as Claude Code reports them
and the model the next Claude steps get — the conveyor picks it itself, never pass a model — and how
much of its window each tab has used, as counted by the conveyor. If the owner told you a tab is near
its limit, or the chat in a tab warns about limits, run
`node conveyor/bin/conveyor.mjs status --block <TAB>` for it.
Open View Usage in Antigravity: if 30% or less of the Gemini five-hour limit is left, switch your own
model to a Claude model (Sonnet Thinking) for this whole run.

## 1. Plan — Claude
1. Save the owner's task (without the words that chose the accounts), exactly as typed, to
   `conveyor/run/TASK.md` (overwrite the file).
2. Run `node conveyor/bin/conveyor.mjs plan`. It works with the session's accounts. Claude reads the
   code and writes `conveyor/run/CONVEYOR_PLAN.md`, splitting the work over up to that many tabs;
   this takes a few minutes. Then read the plan. (`ASK` means no accounts are chosen: do step 0.1.)
   `STOP — Claude: …` means Claude's limit is nearly spent: tell the owner when it resets, and stop.

## 2. Code — the browser tabs, through @browser
The plan step printed where each prompt file goes. The quota guard decides it, never you:
- a tab id and address: send it there, as below — a prompt may be sent to another tab than its
  name says ("moved from"), when its own tab had no room, even to a spare account outside the crew;
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
3. Send every prompt before waiting for any answer, so the tabs work at the same time — with many
   tabs, go through them one after another, sending, then come back to collect.
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
   `conveyor/run/FOR_REVIEW.md`. Its last line names the next step: `prereview` or `review`.
3. `CHECKS FAILED` with a small cause (a typo, a wrong import path, a missing export): fix it and run
   `diff` again. After three rounds, go on to the next step anyway.

## 3b. Pre-review — a working account that wrote none of the run
Only when `diff` named `prereview`. It costs no Claude limit and spares Claude a round of fixes.
1. Run `node conveyor/bin/conveyor.mjs prereview`. It writes `conveyor/run/out/prereview.prompt.md`
   and names the tab for it.
2. Send that file to that tab exactly as in step 2 (check the account's email first, new chat, the
   model the step named), wait for the whole answer, copy it and save it, unchanged, as
   `conveyor/run/inbox/prereview.md`.
3. Run `node conveyor/bin/conveyor.mjs prereview` again. It writes the files the answer corrected.
   - It says to run `diff`: run `diff` (the checks again), then go to step 4.
   - `FIX`: do what it says.
   If the tab is signed out, at its limit, or fails twice: `node conveyor/bin/conveyor.mjs prereview --skip`,
   then step 4.

## 4. Review — Claude
Run `node conveyor/bin/conveyor.mjs review`. Claude reads the diff, fixes what it finds with small
edits and writes `conveyor/run/REVIEW_VERDICT.md`; the program then runs the checks on its edits.
A second review reads only what changed since the first.
- `APPROVE`: go to step 5.
- `REWORK`: do what the verdict asks, then step 3.2 and this step again. After two REWORK rounds,
  stop and show the owner the verdict.
- `ESCALATE`: show the owner the verdict and stop.
- `STOP — the folder changed after diff ran`: run `diff`, then this step again.
- `STOP — Claude: …` (its limit is nearly spent): tell the owner when it resets, and stop.

Change nothing between an `APPROVE` and step 5: the approval covers only the exact diff that was
reviewed, and `ship` refuses anything else.

## 5. Ship and check
1. Run `node conveyor/bin/conveyor.mjs ship`: the checks again, then commit, push and the project's
   deploy commands.
   - `ESCALATE` with a list of files: show the owner the list and stop. Never add `--owner-ok`
     yourself — only the owner types it.
2. Check what the plan lists under "Check after deploy" — with @browser where it is a page (press
   Ctrl+F5 once on each).
3. Report to the owner in a few lines: what changed, the commit, what you saw, anything you did
   yourself instead of a tab, and what the run cost of Claude's five-hour limit (the "this step"
   figures the plan and review printed).
