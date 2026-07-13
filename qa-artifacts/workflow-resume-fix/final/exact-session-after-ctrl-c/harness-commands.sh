#!/bin/sh
# Literal tmux invocations executed against the scenario isolated full-screen TUI.
tmux -S '/tmp/atomic-6-exact-session-after-ctrl-c.sock' send-keys -t owner -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/exact-session-after-ctrl-c/markers" label=final-exact --no-picker'
tmux -S '/tmp/atomic-6-exact-session-after-ctrl-c.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-6-exact-session-after-ctrl-c.sock' send-keys -t owner -l -- '/workflow connect baca5804-b92d-4dac-90b8-758c291ed1e5'
tmux -S '/tmp/atomic-6-exact-session-after-ctrl-c.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-6-exact-session-after-ctrl-c.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-6-exact-session-after-ctrl-c.sock' send-keys -t recovered -l -- '/workflow resume baca5804-b92d-4dac-90b8-758c291ed1e5'
tmux -S '/tmp/atomic-6-exact-session-after-ctrl-c.sock' send-keys -t recovered Enter
tmux -S '/tmp/atomic-6-exact-session-after-ctrl-c.sock' send-keys -t recovered Enter
tmux -S '/tmp/atomic-6-exact-session-after-ctrl-c.sock' send-keys -t recovered -l -- 'final-exact-answer'
tmux -S '/tmp/atomic-6-exact-session-after-ctrl-c.sock' send-keys -t recovered Enter
