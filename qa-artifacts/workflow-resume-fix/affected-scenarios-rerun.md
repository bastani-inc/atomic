# Affected real-tmux scenarios rerun

Tested the rebuilt `packages/coding-agent/dist-dev/cli.js` (`sha256 552f75605db2a9fb7025dec94dad5b6cf5778974b03023422d10e23e642d328f`) with the canonical fixture (`sha256 a4ef1332ae34bad28a05215334f45b79bac56721c9ec982ac9ec042ebba50327`) copied into each scenario-local isolated project cwd. Commands were entered with literal tmux `send-keys` invocations. Copied agent credentials/settings were removed after each run.

## 1. `multiple-resumable-roots` — ACCEPT

- Root A: `e6c43e63-cb2b-4566-ad57-8cdaeb5f35b0`
  - created: `2026-07-13T11:07:32.884Z`
  - updated: `2026-07-13T11:07:32.891Z`
- Root B: `085ef251-6f2e-4537-bbe8-7a6204ed9f39`
  - created: `2026-07-13T11:07:37.550Z`
  - updated: `2026-07-13T11:07:37.555Z`
- The deterministic ordering rule selects B first because it has the newest `updatedAt`. The initial selector visibly highlights its first of two rows, and accepting without navigation completes B with `answer-newest-B`.
- Full-ID selector searches isolate A and B; each searched full ID occurs exactly once in its capture.
- A remains as the sole selector row afterward and completes independently with `answer-remaining-A`.
- Both final markers occur exactly once. Both graph captures visibly show `✓ complete`.
- Unrelated model/tool diagnostic count is zero; completed graph processes were terminated before follow-up model activity, so no reconciliation was required.
- Command-only creator TUIs did not emit JSONL session files before explicit termination. The durable root-session `createdAt`/`updatedAt`, durable file mtimes, selector-relative `now`, and this persistence fact are recorded in `raw/root-ids-and-timestamps.json`.

Primary artifacts:

- `qa-artifacts/workflow-resume-fix/after/multiple-resumable-roots/result.json`
- `qa-artifacts/workflow-resume-fix/after/multiple-resumable-roots/raw/root-ids-and-timestamps.json`
- `qa-artifacts/workflow-resume-fix/after/multiple-resumable-roots/raw/03-default-newest-first.txt`
- `qa-artifacts/workflow-resume-fix/after/multiple-resumable-roots/raw/04-id-search-newest-b.txt`
- `qa-artifacts/workflow-resume-fix/after/multiple-resumable-roots/raw/05-id-search-a.txt`
- `qa-artifacts/workflow-resume-fix/after/multiple-resumable-roots/raw/06-root-b-completed-tui.txt`
- `qa-artifacts/workflow-resume-fix/after/multiple-resumable-roots/raw/07-only-root-a-selector.txt`
- `qa-artifacts/workflow-resume-fix/after/multiple-resumable-roots/raw/08-root-a-completed-tui.txt`
- `qa-artifacts/workflow-resume-fix/after/multiple-resumable-roots/raw/tmux-command-transcript.txt`

## 2. `stale-picker-row-revalidation` — ACCEPT

- Root: `29492219-7d34-4f0f-b4fd-4675a63e7094`
- The selector was opened with literal `/workflow resume` while the row was resumable.
- A helper resumed and completed the root; its graph visibly shows `✓ complete`.
- Before the already-open selector row was selected, helper Atomic PID `2218` was explicitly sent `SIGTERM`.
- Post-termination evidence records `kill -0` exit `1` and tmux `pane_dead=1`.
- Selecting the stale row was refused exactly once with `No durable workflow found for id/prefix: 29492219-7d34-4f0f-b4fd-4675a63e7094`.
- `checkpoint-before`, the helper answer marker, and the final marker each occur exactly once.

Primary artifacts:

- `qa-artifacts/workflow-resume-fix/after/stale-picker-row-revalidation/result.json`
- `qa-artifacts/workflow-resume-fix/after/stale-picker-row-revalidation/raw/01-stale-row-open.txt`
- `qa-artifacts/workflow-resume-fix/after/stale-picker-row-revalidation/raw/03-helper-completed-tui.txt`
- `qa-artifacts/workflow-resume-fix/after/stale-picker-row-revalidation/raw/helper-atomic.pid`
- `qa-artifacts/workflow-resume-fix/after/stale-picker-row-revalidation/raw/helper-process-cleanup.txt`
- `qa-artifacts/workflow-resume-fix/after/stale-picker-row-revalidation/raw/04-stale-selection-refused.txt`
- `qa-artifacts/workflow-resume-fix/after/stale-picker-row-revalidation/raw/tmux-command-transcript.txt`

## Cleanup and isolation

Each scenario used its own `project/.atomic/workflows`, isolated HOME, durable directory, session directory, marker directory, and short tmux socket. Both sockets were removed, no scenario CLI process remained, and credential filename/value scans were empty. See each scenario's `raw/post-run-cleanup-and-secret-scan.txt`.
