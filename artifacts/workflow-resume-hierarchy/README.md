# Workflow resume hierarchy/timer tmux evidence

All `.txt` files in this directory are direct `tmux capture-pane -p` output from the worktree-built Atomic CLI. The runs used project-local workflows loaded with `/workflow reload`; fresh processes were then launched from the repository root, where those definitions were not in startup discovery, to verify persisted invocation-directory rediscovery.

## Nested child + parallel fan-out (`cbaf0e31`)

- `nested-before-quit.txt`: expanded root → child → parallel graph before the first quit; both branches show `14s`.
- `nested-after-resume.txt`: same hierarchy in a fresh process; both branches continue at `34s`.
- `nested-after-second-resume.txt`: same hierarchy after a second quit/process restart; both branches continue at `1m 17s`.
- `nested-main-before-quit.txt` / `nested-main-after-resume.txt`: dashboard total continues from `42s` to `1m 4s`.
- `nested-completed-live.txt`: completed nested/parallel topology with branch durations retained.
- `nested-completed-fresh-inspection.txt`: completed hierarchy reopened from DBOS in another fresh process.

## Single stage (`342bb0fa`)

- `single-before-quit.txt`: single running node at `25s`.
- `single-after-resume.txt`: same node in a fresh process at `50s`.
- `single-main-before-quit.txt` / `single-main-after-resume.txt`: dashboard total continues from `34s` to `57s`.

## Resume picker

- `resume-picker-no-prompts.txt`: paused nested workflow row shows status and checkpoints with no `N prompts` segment.
- `completed-picker.txt`: completed nested workflow row likewise has no pending-prompt count.
