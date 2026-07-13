#!/bin/sh
# Literal tmux invocations executed against the scenario isolated full-screen TUI.
tmux -S '/tmp/atomic-6-selector-cancel-reopen.sock' send-keys -t seed -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/selector-cancel-reopen/markers" label=final-cancel --no-picker'
tmux -S '/tmp/atomic-6-selector-cancel-reopen.sock' send-keys -t seed Enter
tmux -S '/tmp/atomic-6-selector-cancel-reopen.sock' send-keys -t tui -l -- '/workflow resume'
tmux -S '/tmp/atomic-6-selector-cancel-reopen.sock' send-keys -t tui Enter
tmux -S '/tmp/atomic-6-selector-cancel-reopen.sock' send-keys -t tui Escape
tmux -S '/tmp/atomic-6-selector-cancel-reopen.sock' send-keys -t tui -l -- '/workflow resume'
tmux -S '/tmp/atomic-6-selector-cancel-reopen.sock' send-keys -t tui Enter
tmux -S '/tmp/atomic-6-selector-cancel-reopen.sock' send-keys -t tui Enter
tmux -S '/tmp/atomic-6-selector-cancel-reopen.sock' send-keys -t tui Enter
tmux -S '/tmp/atomic-6-selector-cancel-reopen.sock' send-keys -t tui -l -- 'final-cancel-answer'
tmux -S '/tmp/atomic-6-selector-cancel-reopen.sock' send-keys -t tui Enter
