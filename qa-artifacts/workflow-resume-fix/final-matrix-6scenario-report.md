# Six-Scenario Workflow Resume Regeneration

Regenerated and certified by observed full-screen Atomic TUI behavior on frozen HEAD `404d7e5173093471bdb849aae39536638efc4629`.

| Scenario | Observed result |
|---|---|
| exact-session-after-ctrl-c | PASS — PID death reached ESRCH; exact-session resume returned to the pending input and completed once. |
| incompatible-definition-on-resume | PASS — both V2 attempts displayed definition-changed refusal; durable bytes unchanged; V2 marker count 0. |
| rapid-resume-command-burst | PASS — real-key commands produced one resumed owner and one already-running refusal; completion markers singular. |
| selector-cancel-reopen | PASS — Escape preserved durable bytes; reopened selection resumed and completed. |
| sigkill-after-next-prompt-render | PASS — killed after the second prompt rendered; exact-session recovery requested only the second response; markers singular. |
| stale-picker-row-revalidation | PASS — helper completed and exited after picker opened; stale selection displayed `No durable workflow found`; no duplicate markers. |

All six results carry source manifest `6b02cb9f96e06d403f83d7c8130d2fe7cd2d9ac7058f873f0b44712ea86cd4b4`, bundle `552f75605db2a9fb7025dec94dad5b6cf5778974b03023422d10e23e642d328f`, fixture fingerprints, literal tmux command histories, and preserved durable JSON snapshots. The complete matrix summary verifies all 14 scenarios uniformly PASS on `404d7e517`.
