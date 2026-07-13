#!/bin/sh
# Literal tmux invocations executed against the scenario isolated full-screen TUI.
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t a:0.0 -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/multiple-resumable-roots/markers" label=final-multi-A --no-picker'
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t a:0.0 Enter
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t a:0.0 C-c
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t b:0.0 -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/multiple-resumable-roots/markers" label=final-multi-B --no-picker'
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t b:0.0 Enter
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t b:0.0 C-c
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t chooser:0.0 -l -- '/workflow resume'
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t chooser:0.0 Enter
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t chooser:0.0 Enter
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t chooser:0.0 -l -- 'final-multi-B-answer'
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t chooser:0.0 Enter
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t chooser:0.0 -l -- '/workflow resume'
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t chooser:0.0 Enter
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t chooser:0.0 Enter
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t chooser:0.0 -l -- 'final-multi-A-answer'
tmux -S '/tmp/atomic-final-multi-50122.sock' send-keys -t chooser:0.0 Enter
