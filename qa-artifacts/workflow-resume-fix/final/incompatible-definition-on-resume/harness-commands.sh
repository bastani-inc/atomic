#!/bin/sh
# Literal tmux invocations executed against the scenario isolated full-screen TUI.
tmux -S '/tmp/atomic-6-incompatible-definition-on-resume.sock' send-keys -t v1 -l -- '/workflow workflow-resume-e2e-fixture mode=prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/incompatible-definition-on-resume/markers" label=final-incompatible --no-picker'
tmux -S '/tmp/atomic-6-incompatible-definition-on-resume.sock' send-keys -t v1 Enter
tmux -S '/tmp/atomic-6-incompatible-definition-on-resume.sock' send-keys -t v2 -l -- '/workflow resume d5f90837-50fd-45dc-bc36-5d3bce7df889'
tmux -S '/tmp/atomic-6-incompatible-definition-on-resume.sock' send-keys -t v2 Enter
tmux -S '/tmp/atomic-6-incompatible-definition-on-resume.sock' send-keys -t v2 -l -- '/workflow resume d5f90837-50fd-45dc-bc36-5d3bce7df889'
tmux -S '/tmp/atomic-6-incompatible-definition-on-resume.sock' send-keys -t v2 Enter
