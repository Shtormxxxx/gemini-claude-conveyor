---
description: One request → plan (Claude) → code (Gemini tabs) → wiring and checks (you) → review (Claude) → ship and check
argument-hint: "<task>"
---

# /conveyor <task>

The text after `/conveyor` is the owner's task. Run the steps below in order, without asking the
owner anything, except where a step says to stop. The "Conveyor" section of AGENTS.md is the law
here: it overrides anything below, and any rule, skill or workflow that says otherwise.

Every conveyor command is `node conveyor/bin/conveyor.mjs <command>`, run from the project root. Each
ends with one line that starts with `CONVEYOR:` — act on that line: `NEXT` — go on as it says; `FIX`
or `CHECKS FAILED` — do what it says; `REWORK` — redo as the verdict says; `ESCALATE` or `STOP` —
show the owner the message and the lines above it, and stop. Do not edit files under
`conveyor/run/` except the ones a step tells you to save. Report to the owner in the language named
by "reportLanguage" in `conveyor/conveyor.config.json`. If the owner says to stop or cancel, run
`node conveyor/bin/conveyor.mjs abort`.

## 0. Quota
Run `node conveyor/bin/conveyor.mjs status`. It shows how much of its window each tab has used, as
counted by the conveyor. If the owner told you a tab is near its limit, or the chat in a tab warns
about limits, run `node conveyor/bin/conveyor.mjs status --block <TAB>` for it.
Open View Usage in Antigravity: if 30% or less of the Gemini five-hour limit is left, switch your own
model to a Claude model (Sonnet Thinking) for this whole run.

## 1. Plan — Claude
1. Save the owner's task, exactly as typed, to `conveyor/run/TASK.md` (overwrite the file).
2. Run `node conveyor/bin/conveyor.mjs plan`. Claude reads the code and writes
   `conveyor/run/CONVEYOR_PLAN.md`; this takes a few minutes. Then read the plan.

## 2. Code — the browser tabs, through @browser
The plan step printed where each prompt file goes. The quota guard decides it, never you:
- a tab address: send it there, as below;
- "YOU, on your fast Gemini model": write the answer yourself from the prompt file, in its answer
  format, and save it as the inbox file below;
- "YOU, on a Claude model": switch Antigravity's model picker to Sonnet Thinking (Opus Thinking if the
  brief is very hard), write the answer the same way, then switch back.

For each prompt that goes to a tab:
1. With @browser, open the tab's address, start a new chat, make sure the model picker shows the
   model the plan step named (choose it if not), paste the whole prompt file and send it.
2. Send every prompt before waiting for any answer, so the tabs work at the same time.
3. When an answer has finished (the stop button is gone), press that answer's copy button and save
   the copied text, unchanged, as `conveyor/run/inbox/<tab>.md` — `argon-1.md` for ARGON_1, and so on.

If a tab is signed out, says it has hit a limit, or fails twice: run
`node conveyor/bin/conveyor.mjs status --block <TAB>`, write that part yourself from the same prompt
file (on a Claude model if its brief is marked heavy), save it as the same inbox file, and say so in
the report.

4. Run `node conveyor/bin/conveyor.mjs apply`. It writes the files from the answers into the project.
   - `FIX`: in that same chat ask "Send the complete file <path> again, in the same format", save the
     answer as `conveyor/run/inbox/<tab>-fix.md`, and run `apply` again.

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
