#!/bin/sh
# Literal tmux invocations executed against the scenario isolated full-screen TUI.
tmux -S '/tmp/atomic-6-sigkill-after-next-prompt-render.sock' send-keys -t owner -l -- '/workflow workflow-resume-e2e-fixture mode=double-prompt marker_root="/Users/tonystark/Documents/projects/atomic-fix-workflow-resume-e2e/qa-artifacts/workflow-resume-fix/final/sigkill-after-next-prompt-render/markers" label=final-sigkill --no-picker'
tmux -S '/tmp/atomic-6-sigkill-after-next-prompt-render.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-6-sigkill-after-next-prompt-render.sock' send-keys -t owner -l -- '/workflow connect 3a8dfbc5-519b-4d9e-9ea3-98ffd572925e'
tmux -S '/tmp/atomic-6-sigkill-after-next-prompt-render.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-6-sigkill-after-next-prompt-render.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-6-sigkill-after-next-prompt-render.sock' send-keys -t owner -l -- 'final-sigkill-first'
tmux -S '/tmp/atomic-6-sigkill-after-next-prompt-render.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-6-sigkill-after-next-prompt-render.sock' send-keys -t owner Enter
tmux -S '/tmp/atomic-6-sigkill-after-next-prompt-render.sock' send-keys -t recovered -l -- '/workflow resume 3a8dfbc5-519b-4d9e-9ea3-98ffd572925e'
tmux -S '/tmp/atomic-6-sigkill-after-next-prompt-render.sock' send-keys -t recovered Enter
tmux -S '/tmp/atomic-6-sigkill-after-next-prompt-render.sock' send-keys -t recovered Enter
tmux -S '/tmp/atomic-6-sigkill-after-next-prompt-render.sock' send-keys -t recovered -l -- 'final-sigkill-second'
tmux -S '/tmp/atomic-6-sigkill-after-next-prompt-render.sock' send-keys -t recovered Enter
