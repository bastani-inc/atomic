#!/bin/sh
# Literal tmux invocations executed against the scenario isolated full-screen TUI.
tmux -S '/tmp/atomic-final-repeat-50122.sock' send-keys -t tui:0.0 -l -- '/workflow workflow-resume-e2e-fixture mode=double-prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/repeated-resume-across-two-prompts/markers" label=final-repeated --no-picker'
tmux -S '/tmp/atomic-final-repeat-50122.sock' send-keys -t tui:0.0 Enter
tmux -S '/tmp/atomic-final-repeat-50122.sock' send-keys -t tui:0.0 C-c
tmux -S '/tmp/atomic-final-repeat-50122.sock' send-keys -t r1:0.0 -l -- '/workflow resume'
tmux -S '/tmp/atomic-final-repeat-50122.sock' send-keys -t r1:0.0 Enter
tmux -S '/tmp/atomic-final-repeat-50122.sock' send-keys -t r1:0.0 Enter
tmux -S '/tmp/atomic-final-repeat-50122.sock' send-keys -t r1:0.0 -l -- 'final-repeated-first'
tmux -S '/tmp/atomic-final-repeat-50122.sock' send-keys -t r1:0.0 Enter
tmux -S '/tmp/atomic-final-repeat-50122.sock' send-keys -t r1:0.0 C-c
tmux -S '/tmp/atomic-final-repeat-50122.sock' send-keys -t r2:0.0 -l -- '/workflow resume 545a217b-5d02-431f-88b5-0748c0aa622b'
tmux -S '/tmp/atomic-final-repeat-50122.sock' send-keys -t r2:0.0 Enter
tmux -S '/tmp/atomic-final-repeat-50122.sock' send-keys -t r2:0.0 -l -- 'final-repeated-second'
tmux -S '/tmp/atomic-final-repeat-50122.sock' send-keys -t r2:0.0 Enter
