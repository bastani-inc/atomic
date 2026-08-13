# Intercom session-list width-aware live evidence

This evidence was captured on 2026-08-13 from the clean checkout at commit
`5f239dd5c8e67cf745659354d06b7b1b9e041c26` (`fix(intercom): make full session IDs width-aware`)
after building the local package. The captures came from a throwaway broker and
throwaway Atomic sessions, not the developer's live broker.

## Isolation and startup

The throwaway agent directory was
`/tmp/atomic-intercom-width-e2e.wxQAZM/agent`. Both real Atomic sessions used the
same `ATOMIC_CODING_AGENT_DIR`; the planner and worker ran in separate full-width
windows of the same tmux session. The exact startup commands were:

```sh
npm run build --workspace=@bastani/atomic
DIR=/tmp/atomic-intercom-width-e2e.wxQAZM
SESSION=atomic-intercom-width-e2e

tmux new-session -d -s "$SESSION" -n planner -x 80 -y 40 \
  -c /Users/tonystark/Documents/projects/atomic-intercom-width-aware \
  "ATOMIC_CODING_AGENT_DIR='$DIR/agent' ATOMIC_OFFLINE=1 node packages/coding-agent/dist/cli.js --no-context-files --no-themes --name planner"
tmux new-window -d -t "$SESSION" -n worker \
  -c /Users/tonystark/Documents/projects/atomic-intercom-width-aware \
  "ATOMIC_CODING_AGENT_DIR='$DIR/agent' ATOMIC_OFFLINE=1 node packages/coding-agent/dist/cli.js --no-context-files --no-themes --name worker"
```

Each window was trusted by sending Enter to its trust prompt, then the sessions
were named explicitly:

```sh
for window in planner worker; do
  tmux send-keys -t "$SESSION:$window" Enter
done
sleep 8
for window in planner worker; do
  tmux send-keys -t "$SESSION:$window" "/name $window" Enter
done
sleep 2
tmux send-keys -t "$SESSION:worker" "/intercom" Enter
```

After the planner registered, the worker overlay was closed and reopened so its
presence snapshot included the planner:

```sh
tmux send-keys -t "$SESSION:worker" C-c
sleep 1
tmux send-keys -t "$SESSION:planner" "/intercom" Enter
sleep 3
tmux send-keys -t "$SESSION:planner" C-c
sleep 1
tmux send-keys -t "$SESSION:worker" "/intercom" Enter
sleep 3
```

The two real session UUIDs observed in the overlay were:

- worker: `c910cfd2-7798-4b3e-bed2-b3d1082bdd18`
- planner: `ab3514fa-360b-42b2-a1a1-827740c259fa`

The worker window was resized and captured at every required width with these
exact commands:

```sh
EVIDENCE=test/evidence/intercom-session-list-width
mkdir -p "$EVIDENCE"
for width in 40 42 62 63 80; do
  tmux resize-window -t "$SESSION:worker" -x "$width" -y 40
  sleep 1
  tmux capture-pane -p -t "$SESSION:worker" -S -80 > "$EVIDENCE/tmux-overlay-w${width}.txt"
done
```

## Observed thresholds

The files `tmux-overlay-w40.txt`, `tmux-overlay-w42.txt`,
`tmux-overlay-w62.txt`, `tmux-overlay-w63.txt`, and `tmux-overlay-w80.txt`
contain the complete pane captures. Relevant overlay rows are quoted below.

- **40 columns** (`availableWidth = 34`): names and cwd rows remain readable;
  each UUID is on its own dim row and is visibly ellipsized:

  ```text
  │  worker [self]                     │
  │  c910cfd2-7798-4b3e-bed2-b3d1082bd…│
  │  /Users/tonystar…com-width-aware • │
  │→ planner [same cwd]                │
  │  ab3514fa-360b-42b2-a1a1-827740c25…│
  │  /Users/tonystar…com-width-aware • │
  ```

- **42 columns** (`availableWidth = 36`): both complete 36-character UUIDs
  appear on their own rows without an ellipsis; names, tags, and cwd remain
  readable:

  ```text
  │  worker [self]                       │
  │  c910cfd2-7798-4b3e-bed2-b3d1082bdd18│
  │→ planner [same cwd]                  │
  │  ab3514fa-360b-42b2-a1a1-827740c259fa│
  ```

- **62 columns** (`availableWidth = 56`): the selected planner title still
  wraps, while its complete UUID remains on a separate row:

  ```text
  │→ planner [same cwd]                                      │
  │  ab3514fa-360b-42b2-a1a1-827740c259fa                    │
  ```

- **63 columns** (`availableWidth = 57`): the planner name, complete UUID, and
  `[same cwd]` tag fit on one title row:

  ```text
  │→ planner (ab3514fa-360b-42b2-a1a1-827740c259fa) [same cwd]│
  ```

- **80 columns**: the full worker and planner title rows fit without wrapping:

  ```text
  │  worker (c910cfd2-7798-4b3e-bed2-b3d1082bdd18) [self]                      │
  │→ planner (ab3514fa-360b-42b2-a1a1-827740c259fa) [same cwd]                 │
  ```

All five derived thresholds held exactly. There was no observed divergence.
At the 40-column minimum the full IDs are intentionally not fully visible, but
the overflow is explicit (`…`) and the complete IDs are available at 42 columns
and wider; no fixed 8-character ID is rendered.

## Cleanup

Cleanup was completed after all captures were written:

```sh
tmux kill-session -t atomic-intercom-width-e2e
rm -rf /tmp/atomic-intercom-width-e2e.wxQAZM
```
