# Uniform final-build `/workflow resume` tmux matrix

## Build identity

Every scored scenario in this report ran against the same source and bundle:

- HEAD: `af5472addf0f46b0c65ef85ff67b0e44c0250c18`
- Source diff SHA-256: `86155d18c212045a57d6a3c7c8d0ce8a816d89adfa24ffc5f5857a3d8c7a4e68`
- `dist-dev/cli.js` SHA-256: `552f75605db2a9fb7025dec94dad5b6cf5778974b03023422d10e23e642d328f`
- Authoritative fixture SHA-256: `a4ef1332ae34bad28a05215334f45b79bac56721c9ec982ac9ec042ebba50327`

The fixture was installed only under each scenario's isolated `ATOMIC_CODING_AGENT_DIR/workflows`. Repository `.atomic` was never used. The completed-run workaround and incompatible-definition V2 mutation were confined to their own isolated agent workflow copies.

## Result

**13 pass, 1 known fixture environment failure, 0 product failures.**

| Scenario | Outcome | Primary evidence |
|---|---|---|
| exact-session-after-ctrl-c | pass | `after/exact-session-after-ctrl-c/raw/02-resumed.txt` |
| resume-picker-then-workflow-resume | pass | `after/resume-picker-then-workflow-resume/raw/03-workflow-picker.txt` |
| fresh-empty-session-selector | pass | `after/fresh-empty-session-selector/raw/02-selector.txt` |
| repeated-resume-across-two-prompts | pass | `after/repeated-resume-across-two-prompts/raw/03-post-completion.txt` |
| multiple-resumable-roots | pass | `after/multiple-resumable-roots/raw/ordering-assertion.json` |
| recoverable-failure-resume | environment_failure | `after/recoverable-failure-resume/raw/03-empty-stage-failure.txt` |
| completed-run-exclusion | pass | `after/completed-run-exclusion/raw/03-direct-refusal.txt` |
| nested-child-root-only | pass | `after/nested-child-root-only/raw/01-root-selector.txt` |
| active-duplicate-resume-refused | pass | `after/active-duplicate-resume-refused/raw/02-direct-refusal.txt` |
| stale-picker-row-revalidation | pass | `after/stale-picker-row-revalidation/raw/03-stale-selection.txt` |
| rapid-resume-command-burst | pass | `after/rapid-resume-command-burst/raw/03-burst-main.txt` |
| selector-cancel-reopen | pass | `after/selector-cancel-reopen/raw/02-reopened.txt` |
| sigkill-after-next-prompt-render | pass | `after/sigkill-after-next-prompt-render/raw/01-unique-second-prompt-sync.txt` |
| incompatible-definition-on-resume | pass | `after/incompatible-definition-on-resume/raw/refusal-diagnostic.txt` |

## Hash and resume invariants

Every scenario preserves at least one durable-state snapshot. `raw/status-reconciliation.txt` records the handle status, checkpoint count, resumability, and non-empty `definitionHash`. No persisted scored handle lacks `definitionHash`.

`exact-session-after-ctrl-c` proves a successful same-definition hashed resume: run `80b2446b-a2aa-40d1-82d9-7303bac2e631` retained its original ID, reopened exact host session `019f5b2c-e7d5-7bd1-8e44-ef708eeebb47`, and completed with singular checkpoint/final markers.

## Reviewer-gap evidence

- **Multiple roots:** `root-ids-timestamps.jsonl` records full IDs, labels, creation/update timestamps, and hashes. `01-ordering-selector-with-ids.txt` toggles Path display and shows newer root `8f4ecaa5-6796-422b-8ae8-077741a10fb7` above older root `f4abdc9a-84f6-4c3b-8adb-1701a4b1f544`; `ordering-assertion.json` reconciles the rows and timestamps. Both marker files complete independently.
- **Stale picker:** helper PID `10054` completed the candidate and exited with `dead=1 status=0` before stale selection (`helper-exit-before-stale-selection.txt`). Stale selection then returned the handled missing-durable refusal without another marker.
- **Rapid burst:** `single-burst-payload.txt` records both identical commands; `harness-commands.sh` records one literal `tmux send-keys ... <cmd> Enter <cmd> Enter` IPC call. The first resumed and the second reported already running; explicit HIL input completed once.
- **SIGKILL boundary:** `01-unique-second-prompt-sync.txt` contains the exact `E2E second answer for final-sigkill` text before PID kill. `process-after-kill.txt` proves death. Exact-session recovery resumed only the pending second prompt and all four markers remained singular.
- **Incompatible V1→V2:** only the isolated agent fixture changed. `definition-version-hashes.txt` records V1/V2 file hashes. Both targeted resume attempts emitted `changed since its durable checkpoint was created; refusing resume before stage execution`. Durable SHA-256 remained byte-identical across both attempts, and `v2_marker_count` is zero.
- **Status reconciliation:** every scenario includes `raw/status-reconciliation.txt`, combining the result, authoritative durable handle snapshot(s), and marker events.

## Known fixture environment failure

`recoverable-failure-resume` replays the checkpoint, records `recovered-after-failure` and `final` once, then reaches the authoritative fixture defect: its successful fail-once branch creates no `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, or `ctx.workflow`. Atomic correctly reports `Workflow run completed without creating any workflow stages`. This is the same known environment failure, not a product defect.

## Literal tmux procedure and cleanup

Each scenario contains `harness-commands.sh` with literal `/workflow resume` submissions and control-key actions. All slash-command behavior was exercised through the full-screen TUI; workflow APIs were not substituted.

Each `raw/cleanup.txt` records cleanup scope, commands, agent-directory absence, socket absence, and scoped process output. Final global checks report:

- copied agent/auth/cache directories: removed
- tmux servers/sockets: removed
- scenario Atomic processes: 0
- credential-pattern matches: 0
- repository `.atomic/workflows/workflow-resume-e2e-fixture.ts`: absent

Machine-readable results are in `matrix-summary.json`; every scenario also has its own `result.json`.
