#!/bin/sh
# Literal tmux invocations executed against the scenario isolated full-screen TUI.
tmux -S '/tmp/atomic-6-stale-picker-row-revalidation.sock' send-keys -t seed -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/stale-picker-row-revalidation/markers" label=final-stale --no-picker'
tmux -S '/tmp/atomic-6-stale-picker-row-revalidation.sock' send-keys -t seed Enter
tmux -S '/tmp/atomic-6-stale-picker-row-revalidation.sock' send-keys -t chooser -l -- '/workflow resume'
tmux -S '/tmp/atomic-6-stale-picker-row-revalidation.sock' send-keys -t chooser Enter
tmux -S '/tmp/atomic-6-stale-picker-row-revalidation.sock' send-keys -t helper -l -- '/workflow resume 2d862807-363c-4d5b-be69-c6a8523c8d6c'
tmux -S '/tmp/atomic-6-stale-picker-row-revalidation.sock' send-keys -t helper Enter
tmux -S '/tmp/atomic-6-stale-picker-row-revalidation.sock' send-keys -t helper Enter
tmux -S '/tmp/atomic-6-stale-picker-row-revalidation.sock' send-keys -t helper -l -- 'final-stale-answer'
tmux -S '/tmp/atomic-6-stale-picker-row-revalidation.sock' send-keys -t helper Enter
tmux -S '/tmp/atomic-6-stale-picker-row-revalidation.sock' send-keys -t chooser Enter
