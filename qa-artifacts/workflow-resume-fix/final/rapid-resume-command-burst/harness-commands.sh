#!/bin/sh
# Literal tmux invocations executed against the scenario isolated full-screen TUI.
tmux -S '/tmp/atomic-6-rapid-resume-command-burst.sock' send-keys -t seed -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/rapid-resume-command-burst/markers" label=final-rapid --no-picker'
tmux -S '/tmp/atomic-6-rapid-resume-command-burst.sock' send-keys -t seed Enter
tmux -S '/tmp/atomic-6-rapid-resume-command-burst.sock' send-keys -t first -l -- '/workflow resume cc5a2fe3-a4e8-4ace-84aa-4bcc411700ed'
tmux -S '/tmp/atomic-6-rapid-resume-command-burst.sock' send-keys -t first Enter
tmux -S '/tmp/atomic-6-rapid-resume-command-burst.sock' send-keys -t second -l -- '/workflow resume cc5a2fe3-a4e8-4ace-84aa-4bcc411700ed'
tmux -S '/tmp/atomic-6-rapid-resume-command-burst.sock' send-keys -t second Enter
tmux -S '/tmp/atomic-6-rapid-resume-command-burst.sock' send-keys -t first Enter
tmux -S '/tmp/atomic-6-rapid-resume-command-burst.sock' send-keys -t first -l -- 'final-rapid-answer'
tmux -S '/tmp/atomic-6-rapid-resume-command-burst.sock' send-keys -t first Enter
