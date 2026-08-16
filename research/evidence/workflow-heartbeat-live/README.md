# Full-feature terminal evidence — live provider, 1-minute cadence (#1975)

All three slices together, against a **real authenticated provider**, driven
through tmux.

The two per-slice helpers run `--offline` against an empty agent directory, so
each delivered heartbeat is followed by `Unknown provider: unknown`. That proves
delivery, recurrence, and cleanup. It cannot prove the thing the issue is
actually for: the main chat reading a heartbeat, inspecting the run against its
original goal, and deciding to continue, steer, or stop it. This scenario does.

## Reproduce

```sh
tmux new-session -d -s hb-live -x 200 -y 50
tmux set-option -t hb-live history-limit 200000
bash scripts/e2e/workflow-heartbeat-live-evidence.sh hb-live /tmp/hb-live
```

The helper copies `auth.json` (plus model selection) from the real agent
directory into a scratch agent directory, so the run reaches the provider while
sessions, history, and caches stay isolated from the operator's own state. The
fixture workflow is authored at `heartbeatIntervalMinutes: 1`, parks for 200
seconds, and completes on its own between boundary 3 and boundary 4.

## Result

| | |
|---|---|
| Run | `7d50804a-a470-4ff8-9f18-e69c7332b9f5` |
| Cadence | 1 minute |
| Provider | `github-copilot/claude-opus-5` (live) |
| Heartbeats delivered | 3 |
| Gaps between boundaries | 60000 ms, 60000 ms |
| Heartbeats after terminal, +3 min | 0 |

## Captures

| File | What it proves |
| --- | --- |
| `01-cli-started-live-provider.txt` | A real authenticated session, not `--offline`. |
| `02-run-dispatched.txt` | The 1-minute run is in the background. Last thing typed. |
| `03-first-heartbeat-card.txt` | The first card arrives unprompted, one minute after start. |
| `04-parent-turn-on-heartbeat.txt` | The main chat takes a real model turn, calls the `workflow` tool, and reports goal alignment. |
| `05-run-completed.txt` | The run reaches a terminal state on its own. |
| `06-quiet-3min-after-terminal.txt` | Three further boundaries pass with nothing delivered. |
| `heartbeat-records.txt` | The durable per-heartbeat records from the session JSONL. |
| `summary.txt` | Machine-readable result of the run. |

## The parent turn

The card the scheduler delivered:

```
╭ WORKFLOW HEARTBEAT ──────────────────────────────────────────────╮
│ ♥ Workflow "workflow-heartbeat-live-evidence" is still running   │
│ workflow  workflow-heartbeat-live-evidence                       │
│ run       7d50804a-a470-4ff8-9f18-e69c7332b9f5                   │
│ cadence   1-minute                                               │
│ elapsed   1m                                                     │
│ ▸ /workflow status 7d50804a-a470-4ff8-9f18-e69c7332b9f5          │
╰──────────────────────────────────────────────────────────────────╯
```

What the main chat then did, with nothing typed: inspected the run through the
`workflow` tool and judged it against its goal.

```
 On goal, no action needed. Letting it continue.
 State at 1m: still on park-tool (node 1, running since start), 0 model stages,
 0 completed nodes. Nothing stalled or errored — a long-running tool node is
 expected to sit like this.
 Next: nothing from you. I'll report again at the next heartbeat.
```

That is acceptance criterion "the main chat can respond by continuing, steering,
or stopping and replacing the workflow", exercised end to end. This run took the
continue branch because the workflow was in fact on goal.

## Why recurrence is not asserted from the pane here

A live parent turn is not instant, and an outstanding heartbeat holds its slot
until its card is consumed. A boundary that falls while the parent is still
working the previous card is **skipped rather than stacked** — by design. The
first attempt at this scenario failed on a two-cards-in-200s assertion for
exactly that reason; the assertion was wrong, not the feature.

The durable records show the cadence held regardless: three boundaries, 60000 ms
apart, anchored to the persisted start time. Deterministic recurrence proof lives
in the injected-clock unit tests and the offline slice 2 captures.

## Why heartbeat accounting reads the JSONL

The TUI renders on the alternate screen, so a card that scrolls past the viewport
is gone from tmux's buffer entirely. Counting cards by scraping the pane over
time silently reports zero once the transcript grows. The session JSONL is the
durable record of what was delivered to the parent, so the counts come from
there; the pane captures remain the visual proof of what the operator saw.

Run: 2026-08-14. Session `hb-live-36098`.
