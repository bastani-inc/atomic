# Final matrix worker report

## Outcome

Completed a fresh actual-Atomic-TUI tmux run of all 14 `/workflow resume` scenarios after discarding the stale partial evidence and recopying the current workflows runtime into the coding-agent builtin runtime directory.

- Passed: **14/14**
- Product failures: **0**
- Environment/fixture failures: **0**
- Uniform current source manifest: `21d683dc93560eb5c1c153bdab90c00f55fbfe69a671f4a6cdeef93618d5b2cf`
- Uniform CLI bundle: `552f75605db2a9fb7025dec94dad5b6cf5778974b03023422d10e23e642d328f`

The corrected recoverable-failure fixture now passes: its first run fails intentionally after one checkpoint, `/workflow resume` replays that checkpoint, `recoverable-proof` supplies a real stage, and the run completes with exactly one each of checkpoint-before, intentional-first-failure, recovered-after-failure, and final markers.

## Preserved evidence

Authoritative evidence is under `qa-artifacts/workflow-resume-fix/final/`:

- `final-report.md`
- `complete-matrix-summary.json`
- `final-source-files.sha256`, `build-hashes.txt`, `scenario-fixture-hashes.txt`
- 14 scenario directories with result, TUI captures, harness actions, markers, session/durable reconciliation, process/hash proof, and cleanup proof
- empty `secret-scan.txt`, `credential-residue-paths.txt`, `processes-after-cleanup.txt`, and `sockets-after-cleanup.txt`

Notable executable proofs include exact-session Ctrl-C process death and exact-id reopen, `--resume` picker flow, concurrent cross-process refusal, rapid duplicate refusal, stale-row revalidation, SIGKILL stale-lease recovery, byte-identical incompatible-definition refusal, completed exclusion, and independent two-root ordering/completion.

No production source, tests, docs, commits, branches, pushes, or PRs were changed by this matrix worker.
