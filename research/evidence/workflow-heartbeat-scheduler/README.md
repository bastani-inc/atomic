# Terminal evidence — workflow heartbeat scheduling and queued delivery (#1975, slice 2)

A real interactive Atomic CLI, driven through tmux, with a workflow authored at
`heartbeatIntervalMinutes: 1`. Nothing is typed between the launch and the two
heartbeat cards, so neither card can be a side effect of a keystroke.

## How to reproduce

```sh
tmux new-session -d -s hb-e2e -x 200 -y 50
bash scripts/e2e/workflow-heartbeat-evidence.sh hb-e2e /tmp/hb-evidence
tmux kill-session -t hb-e2e
```

The script starts the CLI from source with `bun packages/coding-agent/src/cli.ts`
against a scratch project and an isolated agent directory, launches the
`workflow-heartbeat-evidence` fixture workflow, then waits — it polls the pane
for rendered text rather than sleeping blindly, so a card that never arrives
fails the run instead of producing an empty capture.

## Captures

| File | What it proves |
| --- | --- |
| `01-cli-started.txt` | A real interactive session is up and accepting input. |
| `02-run-dispatched.txt` | The 1-minute-cadence workflow is running in the background. This is the last thing typed. |
| `03-first-heartbeat.txt` | The first `WORKFLOW HEARTBEAT` card lands in the main chat on its own, roughly 60s after the persisted start time. |
| `04-second-heartbeat.txt` | A second card one interval later — recurrence, not a one-shot notice. |
| `harness-shaped-capture.txt` | The same pane with scrollback and wrapped lines joined, as the script's own assertions read it. |

## Observed card

```
╭ WORKFLOW HEARTBEAT ──────────────────────────────────────────────╮
│ ♥ Workflow "workflow-heartbeat-evidence" is still running        │
│ workflow  workflow-heartbeat-evidence                            │
│ run       65354fce-28ea-4287-b51c-b7454f20a122                   │
│ cadence   1-minute                                               │
│ elapsed   1m                                                     │
│ ▸ /workflow status 65354fce-28ea-4287-b51c-b7454f20a122          │
╰──────────────────────────────────────────────────────────────────╯
```

The second card is identical apart from `elapsed 2m`, one cadence boundary later.

`Error: Unknown provider: unknown` after each card is expected and is itself part
of the evidence: the harness runs `--offline` with no configured provider, so the
turn the heartbeat triggers has no model to reach. It confirms the heartbeat was
delivered to the parent chat and did trigger a turn, which is the behavior under
test; the model call is not.

Run: 2026-08-14. Session `hb-e2e-97452`, run id `65354fce-28ea-4287-b51c-b7454f20a122`.
