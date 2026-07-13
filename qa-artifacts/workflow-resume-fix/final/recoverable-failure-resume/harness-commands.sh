#!/bin/sh
# Literal tmux invocations executed against the scenario isolated full-screen TUI.
tmux -S '/tmp/atomic-final-recover-50122.sock' send-keys -t tui:0.0 -l -- '/workflow workflow-resume-e2e-fixture mode=fail-once marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/recoverable-failure-resume/markers" label=final-recoverable --no-picker'
tmux -S '/tmp/atomic-final-recover-50122.sock' send-keys -t tui:0.0 Enter
tmux -S '/tmp/atomic-final-recover-50122.sock' send-keys -t tui:0.0 -l -- '/workflow resume'
tmux -S '/tmp/atomic-final-recover-50122.sock' send-keys -t tui:0.0 Enter
tmux -S '/tmp/atomic-final-recover-50122.sock' send-keys -t tui:0.0 Enter
