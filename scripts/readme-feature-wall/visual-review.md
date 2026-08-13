# Feature-wall visual review

Reviewed on 2026-08-11 against the shipped GIFs and posters, re-derived from the media
frames rather than from the tape each clip was supposed to produce.

## Method

```bash
scripts/readme-feature-wall/contact-sheet.sh gif --all
```

The command writes one 3x3 sampled-frame sheet per GIF to
`/private/tmp/atomic-feature-wall/sheets/gif-<lesson>.jpg`. For GIFs, it first expands
encoded frame delays onto the declared 12 fps timeline, then selects each timestamp. This
means a long-held frame appears at every sampled time when it is actually on screen. The
same run writes `gif-holds.tsv`, with the start and duration of every clip's longest hold,
and flags holds of three seconds or more for close review.

Each row below states what is visible in the corrected sheets and poster, whether it is
the feature the README row claims, and whether the clip is legible at a half-width column.
No capture, render, masker, VHS, gifski, or validation process was running while the sheets
were generated and read.

## Privacy scope

Narrowed by the repository owner: their own name, personal file names, unrelated session
or workflow-run names, and ordinary local paths are acceptable on screen. Only a
credential or the operator's provider/model label is disqualifying. The privacy column
below reports against that scope; `validate.mjs` is the deterministic check.

## What changed in this repair

The 27 core captures, the other twelve expanded-wall captures, and their shipped media
remain unchanged. A.8 was re-cut from its existing real raw Atomic recording, in original
time order, to show the full plain-English request followed by `Created and reloaded
successfully`, the generated `.atomic/workflows/review-changes.ts` path, and its smoke run.
The unrelated oversized-read error and its long hold are no longer in the GIF. Its poster
now shows the creation/reload result.

`contact-sheet.sh` now decodes GIF timing before sampling instead of using input-side seek.
It generated all 39 sheets again and reported every longest hold. `validate.mjs` rejects any
decoded frame held over 7.5 seconds. Its OCR pass now expands each GIF onto the same
declared timeline but writes only the frames it will inspect, deletes each clip's sampled
PNGs at once, and removes the temporary root even on failure. This keeps the gate
disk-bounded without changing its first, last, evenly spaced, poster, or dual-PSM coverage.

## Held-frame audit

Ten unchanged clips triggered the three-second review flag: 1.1, 2.2, 2.3, 3.1, 3.2,
3.5, 4.2, 4.3, 6.1, and A.3. The corrected sheets show that each hold stays on its
named feature: the first-session explanation, compaction result, session record, greet
result, blocked command, theme source, model JSON, SDK source, builtin list, or pirate-mode
answer. None holds an unrelated or failed screen. A.8's longest decoded
hold is 0.41 seconds.

## Results

| Row | Named feature visible in sampled frames | Crop, legibility, and privacy | Result |
|---|---|---|---|
| 1.1 | `@greeter.ts` is read, explained, and run with `!bun greeter.ts`. | Prompt, tool result, and shell result remain readable; statusline private fields are painted. | Pass |
| 1.2 | A tagged hashline edit changes the greeting, then a second edit shows the fresh tag and final source. | Edit hunks and outcomes fit the frame; no provider label is visible. | Pass |
| 1.3 | The full-screen structured question UI moves through format and comments questions to review. | Options and active selection are clear at half width. | Pass |
| 1.4 | The todo tool creates two file-based todos and lists both with states and tags. | Todo ids, titles, and status remain readable. | Pass |
| 2.1 | Session tree output, branch choice, and fork-from-message picker are shown. | Tree labels and branch point are readable. | Pass |
| 2.2 | The compaction boundary card reads `Context compacted / Compacted from 16,324 tokens`, then the question `What is the repo rule? Quote it exactly.` is answered with the pinned rule quoted back: `"never rename exported functions in this repo."` | Card, question, and quoted answer are readable; statusline fields are painted. | Pass |
| 2.3 | `/name` and `/session` show the session record, then `jq -r "[.type,.id,.parentId]|@tsv"` prints the file one event per line: `session`, `model_change`, `thinking_level_change`, four `message` rows, and `session_info`, each with its id and parent id. | The chain output is the poster frame and is readable; the session header, which carries the provider field, is never printed. | Pass |
| 3.1 | A project-local extension registers `greet`, reloads, and returns `Hello, Ada!`. | Extension source and real tool result are clear. | Pass |
| 3.2 | A project-local hook blocks the requested destructive shell command with its policy message. | Rejection panel is centered and readable. | Pass |
| 3.3 | A full-screen keyboard-driven question component replaces the editor and records a choice. | Four choices and selection motion are clear. | Pass |
| 3.4 | Atomic writes `SKILL.md`, reloads resources, loads `[skill] repo-stats`, and runs its shell steps. | Skill header, activation, and tool work are readable; the startup provider row is painted. | Pass |
| 3.5 | The custom theme JSON is displayed and appears in the `/theme` picker as `my-theme`. | Palette values and picker entry are readable. | Pass |
| 4.1 | Headless print output and JSON event names appear from real CLI commands. | Both modes fit in one terminal view and remain readable. | Pass |
| 4.2 | A local provider and models are written to `models.json` and read back. | Local URL and model entries are legible; these are lesson content, not the operator's provider. | Pass |
| 4.3 | The SDK example imports Atomic, creates a model runtime and agent session, and subscribes to events. | The core code fits at half width. | Pass |
| 5.1 | Three bundled specialists run in parallel with distinct live progress and tool counts. | Agent names and state changes remain readable. | Pass |
| 5.2 | Worktree-isolated agent records are inspected, then both diffs and cleanup results are synthesized. | Separate worker evidence and final diffs are readable. | Pass |
| 5.3 | Planner and worker sessions register, exchange an intercom task, read the file, and return the summary. | Both panes and sent/received messages are clear. | Pass |
| 5.4 | The worker refuses to decide alone and runs `intercom ask supervisor`; the supervisor pane shows the incoming question, the human types `Reply: "Return false. Do not throw."`, `Reply sent to worker` confirms delivery, and the worker reports `Updated src-client.ts per supervisor's decision` with `null email returns false`. | Both panes are legible; the ask, the human answer, and the applied decision are all on screen. | Pass |
| 5.5 | `fresh` registers, planner sends context and TypeScript snippet attachments, and the receiver acknowledges both. | Attachment names and receipt are readable in both panes. | Pass |
| 5.6 | The project-local `/handoff` flow sends its brief and snippet, then `fresh` replies with validated status. | Send, attachment, reply, and final status are readable. | Pass |
| 6.1 | The builtin workflow list is browsed and Atomic recommends `adversarial-verification` with inputs. | Workflow names, summaries, and answer remain readable. | Pass |
| 6.2 | A two-branch fan-out run lists both live stages and reports `Steered live stage` twice. | Exact preserved steer and success messages are readable; statusline fields are painted. | Pass |
| 6.3 | Valid project-local workflow TypeScript is shown, resources reload, the run starts, and its tracked stage completes. | Schema, command, workflow notices, and output are readable. | Pass |
| 6.4 | The graph reaches an awaiting-input node, opens the real risk selector, and moves among low, medium, and high. | Gate prompt and choices are clear; the run remains paused. | Pass |
| 6.5 | The run is analysing `demo-app/server.js` when the process is killed (`zsh: killed atomic`), Atomic is started again, and `/workflow resume` lists the retained runs with their checkpoint counts, including `fan-out-and-synthesize ✓ completed 35 checkpoints` and `security-review-demo ✓ completed 12 checkpoints`. | Kill, restart, and the retained-run list are readable. The picker lists runs from this machine, which the narrowed privacy scope allows. | Pass |
| 6.6 | The graph view holds steady while `repair-1` runs against the hardcoded API key audit finding, then the header reaches 4/4 complete. | Audit finding, ticking repair timer, footer, and final complete state are readable with no launch flash or prompt frames. | Pass |
| W.1 | A normal chat request names `plain-english-demo`; Atomic calls the workflow tool, returns a full run id, and shows the live run in the BACKGROUND panel. | The request, dispatch card, running status, topic, and run id are clear; private statusline fields are painted. | Pass |
| W.2 | `/workflow inputs typed-input-demo` shows required `path` text and `depth` integer fields; a static key/value launch starts the run and `/workflow status` lists it. | The contract, validated values `src-client.ts` and `2`, dispatch card, and status remain readable. | Pass |
| W.3 | The session lists workflows, inspects `control-demo`, launches it, checks status, opens the connect picker, and enters the live graph. | List, input contract, full run id, picker, and `tracked-work` graph node fit the crop. | Pass |
| A.1 | `/hotkeys` shows remappable action ids, the global map is installed, `/reload` reports refreshed keybindings, and CTRL+J creates a two-line submitted message. | The action list, reload notice, and both lines are readable; the global file exists only in the throwaway HOME. | Pass |
| A.2 | The permission-gate extension catches `sudo echo hi`, opens the real Yes/No selector, moves to No, and returns `Blocked by user`. | Prompt, selection motion, command, and blocked tool result are clear; the harmless command never runs. | Pass |
| A.3 | `/pirate` reports `Arrr! Pirate mode enabled!`; the next answer starts `Arrr!` and explains TypeScript generics correctly. | Toggle notice, prompt, and mutated two-sentence answer are readable; private statusline fields are painted. | Pass |
| A.4 | Slash autocomplete includes the project `component` template, whose arguments expand into `Create a React component named Button with features: onClick handler disabled support`. | Autocomplete motion and the expanded prompt are legible; later tool work is real agent follow-through. | Pass |
| A.5 | One plain-English review request opens a real `subagent parallel (3)` panel with `codebase-analyzer`, `debugger`, and `codebase-pattern-finder` advancing independently. | Agent roles, live tool counts, token counts, and elapsed motion remain readable; no edit is made. | Pass |
| A.7 | Default and `redteam` sessions appear side by side; the default session can list `redworker` through a read-only peek, but its send is not delivered across groups. | Both group labels, synthetic session names, failed send, and isolation explanation are legible; OCR finds no private provider/model label. | Pass |
| A.8 | The first eight sampled frames show the complete prose contract for `review-changes` and Atomic starting the authoring task; the last shows `Created and reloaded successfully`, `.atomic/workflows/review-changes.ts`, and a real smoke-run id. | The request and result are readable, the poster is the creation result, and the prior oversized-read error is absent; longest hold is 0.41 seconds. | Pass |
| A.9 | The `research-and-verify` orchestrator shows a completed artifact root and partition followed by two concurrently running branch stages from the nested fan-out builtin. | The selected window stays inside the real graph viewer; parent name, child stages, timers, edges, and controls are clear without a chat statusline. | Pass |
| A.10 | `/workflow inputs ralph` leads into a one-loop run; the graph shows prompt refinement complete and `research-1` running beneath it. | Contract, bounded launch, run id, and live research-first graph are readable; `create_pr` remains false. | Pass |

**Result: 39/39 passed.** No clip is only a title card, unrelated screen, reused capture, or misleading substitute. The corrected timeline review found no hidden padded error screen.

## Limits worth stating

- **6.5 does not show a resumed run replaying cached stages.** That path needs the
  Postgres-backed durable backend; in this capture environment `/workflow resume <run-id>`
  answers `Run not found`, and a take that filmed it shipped an error card under a row
  promising recovery. The row's copy was rewritten to claim only what the frames show:
  runs checkpoint as they go and survive the process, listed and resumable after a kill.
- **5.4 uses two real sessions rather than a subagent's `contact_supervisor`.** Three takes
  with the subagent bridge produced a child reporting the capability was unavailable in
  this environment, which is the opposite of the row's claim. The intercom ask is the same
  escalation shape, it is real, and the row's copy describes it exactly.
- **A.5 focuses on the concurrent review phase.** The selected window proves the three
  independent roles and their live progress; the row copy does not claim that the final
  synthesis appears in the clip.
- **A.9 shows the first nested builtin while it is active.** The exact prepared parent source
  calls both `fanOutAndSynthesize` and `adversarialVerification`, but the selected window
  proves nesting through the expanded fan-out child stages rather than waiting for the
  second child to start.
