# Goal first-resume verification for #3466

## Result and limits

The historical first reviewer resume remains unexplained. Its captures show an empty editor and `Working`, but no command-acceptance receipt or resumed execution. Neither proves that input was dropped. The editor clears before dispatch, and `Working` can cover command preflight. The historical in-memory command and ownership state was not recorded.

Two new reviewer-outage runs accepted their first visibly submitted `/workflow resume` and completed in the same Atomic process. All three reviewers executed after acceptance. An orchestrator-outage run also accepted its first resume, executed the interrupted orchestrator and completed. No accepted-resume product defect was reproduced, so this follow-up makes no product change and adds no speculative regression test. The earlier #3466 implementation commits retain their test-first coverage.

This evidence proves the correctly submitted first-resume path. It does not retroactively establish whether the historical attempt was dropped, queued, refused, or stalled before admission. Do not describe the old timeout as a proven input-timing bug or as a proven product defect.

## Candidate and environment

- Candidate `bf77db2a590c9e39297f9147309049508eba6dc0`, following `b5a152a56` and `b2436bffa`.
- Linux, Node 24.21.0, rebuilt interactive Atomic CLI, isolated HOME and scratch repository.
- Dedicated PostgreSQL on loopback port 25467. The injector verifies the postmaster's exact isolated data directory before both signals, stops it and its children for 165 seconds, then resumes them.
- Dedicated tmux session, 160 columns by 48 rows. Existing unrelated sessions and database clusters are untouched.
- Real authenticated `openai-codex/gpt-6.1-sol-fast:medium`, with a verification-only catalog filter. No provider mock, backend mock, or product-code injection.
- Raw local evidence stays in the worktree's ignored `.artifacts/3466-r4/` directory. It is not a hosted artifact and contains private session transcripts, so it is not attached to this document.

## Command-receipt procedure

1. Wait for a main-chat editor, not just the absence of `Working`. If resume opened the graph overlay, return to main chat and verify the editor is visible.
2. Type the complete slash command without Enter. Capture and assert that its full text is visible, accounting for editor line wrapping.
3. Press Enter once and capture the resulting pane.
4. Require a persisted `workflows:lifecycle-notice` with `details.kind = resumed`, the exact run ID, `actor = user`, and a timestamp after submission. A cleared editor or successful `tmux send-keys` call is not a receipt.
5. Require new running stage checkpoints, post-receipt assistant execution in each interrupted stage transcript, and completed task-result checkpoints. The original stage session identities may be reused; new model execution, not a new session ID, is the assertion.
6. Require the same goal ID, a completed ledger, one receipt, three reviews, one complete decision, one work-turn-start event, and exact `hello\n` output bytes. For reviewer outages, the orchestrator result must predate resume and replay rather than rerun.

## Outage runs

| Run | First resume submitted, UTC | Accepted, UTC | Result |
| --- | --- | --- | --- |
| `687d76a4-3448-44af-bd0b-f091e7ec4586` | 2026-10-06 18:23:51.187 | 18:23:52.150 | Complete; all three reviewers executed after acceptance |
| `6b199233-9efa-4b7b-b6cc-665b7fd13913` | 2026-10-06 18:28:59.687 | 18:29:00.548 | Complete; all three reviewers executed after acceptance |
| `84452e8d-9342-42c1-b94e-f6e61d04fc3d` | 2026-10-06 18:33:27.242 | 18:33:28.186 | Complete; interrupted orchestrator executed after acceptance |

All interrupted ledgers stayed `active` with no decision. Both reviewer runs retained the completed orchestrator receipt. No scenario used `/workflow quit`, a CLI restart, or a second resume.

The local `*-first-resume-typed.txt` files prove editor delivery. The `*-command-receipt.json` files preserve accepted lifecycle events. The `*-assertions.json` and `*-fresh-execution.json` files record ledger, SQL, transcript and output assertions.

The main-session receipt verifier also counts exactly one persisted resume admission per run and requires all three runs' receipts in the same main CLI session file. This supports the first-admission and same-session claims independently of the scenario summary's assigned `attempt` and `noQuitOrRestart` fields.

## Observation errors found during this follow-up

- The first start-command assertion compared wrapped editor lines with an unwrapped command. It refused to press Enter. Normalizing whitespace fixed the observer; the unsubmitted draft was cleared before retry.
- The first reviewer observer searched for a chat receipt while the graph overlay hid that surface. The persisted resumed lifecycle event proved acceptance. The existing run was inspected without sending another resume.
- An existing-run observer omitted its filename variable and stopped after ledger assertions. Adding the variable allowed the remaining file and SQL assertions to run.
- The second reviewer's final status command was typed into a graph overlay that opened after the receipt. The visible-command gate refused Enter. Returning to main chat fixed observation. This reproduces a concrete automation focus error, but does not prove that this was the historical first resume's cause.

## Automated checks

- `npm run build` passed from the authorized worktree.
- `npm run check` passed, including Biome, both typecheck passes, typetests and shrinkwrap validation.
- Focused unit run passed, 53 tests across `builtin-workflows-goal-03`, `builtin-workflows-goal-infra-resume`, `builtin-workflows-goal-legacy-infra`, `builtin-workflows-goal-schema-exhaustion`, `builtin-workflows-goal-reviewer-failfast`, `workflow-dependency-self-pause-resume` and `changelog`.
- No whole-repository suite or hosted CI run was performed. This follow-up is not pushed.

User guides and changelogs are unchanged because this follow-up changes no shipped behavior. The existing Goal recovery guidance and #3466 Unreleased entries already describe the implemented behavior.
