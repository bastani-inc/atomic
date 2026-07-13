# Final `/workflow resume` actual-tmux matrix

## Result

**14/14 pass; 0 product failures; 0 environment/fixture failures.**

Every scenario ran through the full-screen Atomic TUI under a real isolated tmux server. Slash commands and answers were sent as terminal input; no workflow API replaced `/workflow resume`.

## Uniform production fingerprint

- Git base HEAD: `f660468db560d1c429037ae12a8258f9aee5318a`
- Current workflow source-manifest SHA-256: `21d683dc93560eb5c1c153bdab90c00f55fbfe69a671f4a6cdeef93618d5b2cf`
- `packages/coding-agent/dist-dev/cli.js` SHA-256: `552f75605db2a9fb7025dec94dad5b6cf5778974b03023422d10e23e642d328f`
- Corrected QA fixture SHA-256: `ac762e71b4440093f66a1ab4c0e8c4f0203fb0c847ecfceea0d9cd47c3e947bf`

The current `packages/workflows` runtime was recopied into `packages/coding-agent/dist/builtin/workflows` before the first run. A post-matrix recomputation produced the identical source-manifest hash. All 14 `result.json` files carry the same production source and CLI hashes. Only two explicitly isolated QA probes vary the fixture: completed-mode adds the already-established minimal proof stage, and incompatible-definition intentionally mutates V1 to V2.

## Scenarios

| Scenario | Outcome | Key proof |
|---|---|---|
| exact-session-after-ctrl-c | pass | Real process exited after Ctrl-C; exact `--session <id>` restored the same chat; targeted resume completed with singular markers. |
| resume-picker-then-workflow-resume | pass | CLI `--resume` picker reopened the prior chat, then `/workflow resume` resumed and completed. |
| fresh-empty-session-selector | pass | A new zero-message session discovered the prior durable root and completed it. |
| repeated-resume-across-two-prompts | pass | Two separate resume cycles answered prompt one and prompt two; all checkpoint/final markers are singular; later targeted resume was refused. |
| multiple-resumable-roots | pass | Two paused roots appeared in the picker; the newer root completed first, the older remained as the sole row, then completed independently. |
| recoverable-failure-resume | pass | Initial intentional failure was resumable; corrected `recoverable-proof` stage completed; checkpoint-before, failure, recovery, and final markers each occurred once. |
| completed-run-exclusion | pass | Scenario-local proof stage completed the root; the selector excluded it and targeted resume reported no durable workflow. |
| nested-child-root-only | pass | Picker exposed only the top-level root, never the nested child; nested prompt resumed and completed with singular child/final markers. |
| active-duplicate-resume-refused | pass | A concurrent process hid the active row; targeted resume reported it was running in another session and directed connect/kill; owner completed once. |
| stale-picker-row-revalidation | pass | A helper completed and exited after a chooser opened; selecting the stale row produced a handled no-durable-workflow error and no duplicate markers. |
| rapid-resume-command-burst | pass | Two rapid targeted commands yielded one dispatch plus `already running in this session`; completion markers remained singular. |
| selector-cancel-reopen | pass | Escape cancelled the picker without changing durable bytes; reopening then resumed and completed. |
| sigkill-after-next-prompt-render | pass | Exact second prompt was rendered before SIGKILL; PID death was recorded; stale lease recovery resumed only prompt two and all markers remained singular. |
| incompatible-definition-on-resume | pass | Two V2 resume attempts were refused before stage execution; durable bytes stayed identical and V2 produced zero final markers. |

## Evidence layout

- `complete-matrix-summary.json`: machine-readable 14-result array.
- `final-source-files.sha256` and `build-hashes.txt`: production identity.
- `<scenario>/result.json`: scored outcome and identical fingerprint.
- `<scenario>/raw/*.txt|json`: tmux captures, durable/process/hash proofs, marker reconciliation, and cleanup.
- `<scenario>/sessions-evidence/`: session JSONL where the TUI created a host session file; zero-message/sessionless slash-only scenarios record the absence in `raw/durable-and-session-evidence.txt` and preserve durable/marker/TUI evidence instead.
- `<scenario>/harness-commands.sh`: ordered literal user actions submitted through tmux.

## Cleanup and redaction

Each isolated credential-bearing agent directory and isolated HOME was removed before scoring. `credential-residue-paths.txt`, `processes-after-cleanup.txt`, and `sockets-after-cleanup.txt` are empty. `secret-scan.txt` is empty after scanning the complete evidence tree, including session JSONL, for common API-token, bearer-token, AWS key, and private-key patterns.
