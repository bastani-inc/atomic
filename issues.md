<!-- manual-pr-1819-tmux-loop -->
# Manual QA observations outside PR #1819 direct scope

These findings were observed while manually testing PR #1819. They were not fixed because they are adjacent or unrelated to the feature's direct behavior.

## [P2] Main-chat Enter events can be lost during live background-workflow redraws under tmux

- Classification: `feature_adjacent`
- Reproduction: While a background workflow card is actively updating, use tmux send-keys -l to type a /workflow status or connect command followed by tmux send-keys Enter. The command can remain in the editor and a delayed C-m retry is needed to execute it.
- Evidence: PR1819-07-status-wide.txt shows the typed status command still resident in the editor after Enter; PR1819-07-status-wide-cm.txt shows it executing after a follow-up C-m; command-logs/tmux-actions.log records the retries. Every capture also prints 'tmux extended-keys is off' warning, indicating a harness/terminal timing interaction rather than a workflow-logic defect. Report-only: it did not prevent obtaining any required evidence (retries succeeded).
- Relevant files: `.atomic/workflows/runs/manual-pr-1819/1784167320843/iteration-1/pane-captures/PR1819-07-status-wide.txt`, `.atomic/workflows/runs/manual-pr-1819/1784167320843/iteration-1/pane-captures/PR1819-07-status-wide-cm.txt`, `.atomic/workflows/runs/manual-pr-1819/1784167320843/iteration-1/command-logs/tmux-actions.log`

## [P3] Pre-existing external/global workflows using the deprecated defineWorkflow API emit IMPORT_FAILED diagnostics

- Classification: `unrelated`
- Reproduction: Launch the entrypoint with the real configured ATOMIC_CODING_AGENT_DIR. Startup prints ~15 workflow-discovery IMPORT_FAILED diagnostics for the user's own global/external workflows under ~/.atomic/agent/workflows and ~/linkedIn-workflows because they call the removed defineWorkflow() helper.
- Evidence: PR1819-01.txt (and every capture header) lists '(0, _workflows.defineWorkflow) is not a function' for codex-fast-mode, headless-policy, hil-*, pr-review-runbook, linkedin-* etc., all located outside the isolated QA HOME; the local pr1819-manual fixture still discovers successfully (WORKFLOWS 18 registered). These are the tester's personal deprecated-API workflows, not caused by the PR or the fixture, and did not block evidence collection.
- Relevant files: `.atomic/workflows/runs/manual-pr-1819/1784167320843/iteration-1/pane-captures/PR1819-01.txt`, `.atomic/workflows/runs/manual-pr-1819/1784167320843/iteration-1/environment/environment.txt`

## [P3] Fresh process does not advertise the paused durable workflow on startup

- Classification: `feature_adjacent`
- Reproduction: Gracefully quit a durable run and exit process 1, then start a new exact-entrypoint process with the same isolated HOME/session dir. No resumable-workflow startup guidance appears; explicit `/workflow resume <id>` nevertheless reuses the original ID, re-asks the prompt, and completes (Case PR1819-11).
- Evidence: PR1819-11.startup-guidance.txt records the startup observation as false; PR1819-11.pids.txt proves the process boundary; PR1819-11.durable-assertions.json proves same-ID completion. Matrix authoritative decision PR1819-11 declares missing startup guidance report-only and passes on explicit same-ID resume; it did not prevent obtaining required evidence.
- Relevant files: `.atomic/workflows/runs/manual-pr-1819/1784167320843/iteration-2/evidence/PR1819-11.startup-guidance.txt`, `.atomic/workflows/runs/manual-pr-1819/1784167320843/iteration-2/evidence/PR1819-11-process2-startup.txt`, `.atomic/workflows/runs/manual-pr-1819/1784167320843/iteration-2/evidence/PR1819-11.pids.txt`, `.atomic/workflows/runs/manual-pr-1819/1784167320843/iteration-2/evidence/PR1819-11.durable-assertions.json`

## [P3] Real configured agent directory emits 15 legacy workflow import diagnostics (defineWorkflow is not a function)

- Classification: `unrelated`
- Reproduction: Launch the exact entrypoint with isolated HOME and ATOMIC_CODING_AGENT_DIR=/Users/norinlavaee/.atomic/agent. Startup reports 15 workflow discovery diagnostics from pre-existing user/legacy resources; auth, model selection, and the PR fixture remain available.
- Evidence: PR1819-01.txt (and repeated at PR1819-12.txt lines 20-46, PR1819-13-error.txt lines 17-43) show IMPORT_FAILED diagnostics for pre-existing user workflows unrelated to the PR diff. The pr1819-manual fixture was still discovered on cold start and all cases proceeded, so this did not block evidence.
- Relevant files: `.atomic/workflows/runs/manual-pr-1819/1784167320843/iteration-2/evidence/PR1819-01.txt`, `.atomic/workflows/runs/manual-pr-1819/1784167320843/iteration-2/evidence/PR1819-01.ansi.txt`

## [P1] Stage-owned input can stall graceful quit before a durable transition failure is reported

- Classification: `feature_adjacent` / report-only by authoritative user scope decision; this finding must not block PR #1819 acceptance and was not repaired here because main may address it independently.
- Reproduction: Launch `bun packages/coding-agent/src/cli.ts` in tmux with the retained PR1819 durable-fault extension, run `/workflow pr1819-manual mode=durable --no-picker`, wait until the live `durable-checkpoint` stage itself is `awaiting_input`, set `/qa-durable-fault transition`, then run `/workflow quit <run-prefix>`. The command remains at `Working...` for more than 300 seconds and never prints `QA durable transition write failed`.
- Focused diagnosis: A Bun reproduction using public `run()` plus `quitRun()` reached `{ runStatus: "running", stageStatus: "awaiting_input", handleStatus: "awaiting_input", isStreaming: true }`; after 250 ms it timed out with `abortCalls=1` and `transitionCalls=0`. Once the stage-owned input precondition was removed and execution reached the later durable `ctx.ui.input` node, the same backend fault rejected immediately with `QA durable transition write failed`.
- Root cause evidence: `quitRun()` waits for the live stage's pause acknowledgement. `createStageControlHandle.pause()` requests an SDK abort whenever the awaiting-input stage is still streaming; `StageSessionController.requestPause()` awaits that abort, which can remain blocked behind unresolved stage-owned UI. The durable paused-status transition is therefore never attempted. This is distinct from the already-working durable transition propagation path.
- Manual evidence: `.atomic/workflows/runs/manual-pr-1819/1784167320843/iteration-2/evidence/PR1819-12.txt` (fault mode at line 105, stalled `Working...` at line 107, run still active after 6m35s at lines 115-118), `PR1819-12.assertions.txt` (`expected_error_visible=false`, `silent_hang_observed=true`, `waited_over_300_seconds=true`), `PR1819-12.ansi.txt`, and `a1819-i2-1784167320843-transition-fail.pipe.log`. The exact fixtures are retained as `iteration-2/fixture-pr1819-manual.ts.txt` and `iteration-2/fixture-pr1819-durable-fault.source.ts.txt` so TypeScript validation does not compile ignored evidence snapshots.
