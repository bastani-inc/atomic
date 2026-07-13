# Workflow Resume Final Matrix

## Frozen build identity

- HEAD: `404d7e5173093471bdb849aae39536638efc4629`
- Workflow source manifest: `6b02cb9f96e06d403f83d7c8130d2fe7cd2d9ac7058f873f0b44712ea86cd4b4`
- `dist-dev/cli.js`: `552f75605db2a9fb7025dec94dad5b6cf5778974b03023422d10e23e642d328f`
- Base fixture: `ac762e71b4440093f66a1ab4c0e8c4f0203fb0c847ecfceea0d9cd47c3e947bf`
- Runtime workflow source copy: byte-identical.

## Observed full-screen TUI matrix

| Scenario | Result |
|---|---|
| active-duplicate-resume-refused | PASS |
| completed-run-exclusion | PASS |
| exact-session-after-ctrl-c | PASS |
| fresh-empty-session-selector | PASS |
| incompatible-definition-on-resume | PASS |
| multiple-resumable-roots | PASS |
| nested-child-root-only | PASS |
| rapid-resume-command-burst | PASS |
| recoverable-failure-resume | PASS |
| repeated-resume-across-two-prompts | PASS |
| resume-picker-then-workflow-resume | PASS |
| selector-cancel-reopen | PASS |
| sigkill-after-next-prompt-render | PASS |
| stale-picker-row-revalidation | PASS |

## Fingerprint verification

All 14 `result.json` records report `outcome=pass`, tested HEAD `404d7e517`, source manifest `6b02cb9f…`, and bundle `552f7560…`. Each scenario retains its TUI transcript, literal tmux command log, marker evidence, and preserved durable snapshot.
