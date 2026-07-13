#!/bin/sh
# Literal tmux invocations executed against the scenario isolated full-screen TUI.
tmux -S '/tmp/atomic-final-active-50122.sock' send-keys -t owner:0.0 -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/active-duplicate-resume-refused/markers" label=final-active --no-picker'
tmux -S '/tmp/atomic-final-active-50122.sock' send-keys -t owner:0.0 Enter
tmux -S '/tmp/atomic-final-active-50122.sock' send-keys -t contender:0.0 -l -- '/workflow resume'
tmux -S '/tmp/atomic-final-active-50122.sock' send-keys -t contender:0.0 Enter
tmux -S '/tmp/atomic-final-active-50122.sock' send-keys -t contender:0.0 Escape
tmux -S '/tmp/atomic-final-active-50122.sock' send-keys -t contender:0.0 -l -- '/workflow resume da49da3a-3ae9-4550-9bdc-69225513cf80'
tmux -S '/tmp/atomic-final-active-50122.sock' send-keys -t contender:0.0 Enter
tmux -S '/tmp/atomic-final-active-50122.sock' send-keys -t owner:0.0 -l -- 'final-active-answer'
tmux -S '/tmp/atomic-final-active-50122.sock' send-keys -t owner:0.0 Enter
