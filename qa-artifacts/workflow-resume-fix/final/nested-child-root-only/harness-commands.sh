#!/bin/sh
# Literal tmux invocations executed against the scenario isolated full-screen TUI.
tmux -S '/tmp/atomic-final-nested-50122.sock' send-keys -t tui:0.0 -l -- '/workflow workflow-resume-e2e-fixture mode=nested marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/nested-child-root-only/markers" label=final-nested --no-picker'
tmux -S '/tmp/atomic-final-nested-50122.sock' send-keys -t tui:0.0 Enter
tmux -S '/tmp/atomic-final-nested-50122.sock' send-keys -t tui:0.0 C-c
tmux -S '/tmp/atomic-final-nested-50122.sock' send-keys -t chooser:0.0 -l -- '/workflow resume'
tmux -S '/tmp/atomic-final-nested-50122.sock' send-keys -t chooser:0.0 Enter
tmux -S '/tmp/atomic-final-nested-50122.sock' send-keys -t chooser:0.0 Enter
tmux -S '/tmp/atomic-final-nested-50122.sock' send-keys -t chooser:0.0 -l -- 'final-nested-answer'
tmux -S '/tmp/atomic-final-nested-50122.sock' send-keys -t chooser:0.0 Enter
