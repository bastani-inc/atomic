#!/bin/sh
# Literal tmux invocations executed against the scenario isolated full-screen TUI.
tmux -S '/tmp/atomic-final-resume-picker-then-50122.sock' send-keys -t tui:0.0 -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/resume-picker-then-workflow-resume/markers" label=final-picker --no-picker'
tmux -S '/tmp/atomic-final-resume-picker-then-50122.sock' send-keys -t tui:0.0 Enter
tmux -S '/tmp/atomic-final-resume-picker-then-50122.sock' send-keys -t tui:0.0 C-c
tmux -S '/tmp/atomic-final-resume-picker-then-50122.sock' send-keys -t chooser:0.0 -l -- '/workflow resume'
tmux -S '/tmp/atomic-final-resume-picker-then-50122.sock' send-keys -t chooser:0.0 Enter
tmux -S '/tmp/atomic-final-resume-picker-then-50122.sock' send-keys -t chooser:0.0 Enter
tmux -S '/tmp/atomic-final-resume-picker-then-50122.sock' send-keys -t chooser:0.0 -l -- 'final-picker-answer'
tmux -S '/tmp/atomic-final-resume-picker-then-50122.sock' send-keys -t chooser:0.0 Enter
