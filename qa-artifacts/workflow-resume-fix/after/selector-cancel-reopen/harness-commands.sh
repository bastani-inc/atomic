# literal tmux harness command log
# scenario=selector-cancel-reopen
# socket=/tmp/atomic-final-selector-c-10683.sock
tmux -S /tmp/atomic-final-selector-c-10683.sock new-session -d -s seed -- /tmp/atomic-final-matrix-20260713c/after/selector-cancel-reopen/launch.sh
tmux -S /tmp/atomic-final-selector-c-10683.sock send-keys -t seed:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=prompt\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/selector-cancel-reopen/markers\"\ label=final-cancel\ --no-picker; tmux -S /tmp/atomic-final-selector-c-10683.sock send-keys -t seed:0.0 Enter
tmux -S /tmp/atomic-final-selector-c-10683.sock new-session -d -s selector -- /tmp/atomic-final-matrix-20260713c/after/selector-cancel-reopen/launch.sh
tmux -S /tmp/atomic-final-selector-c-10683.sock send-keys -t selector:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-selector-c-10683.sock send-keys -t selector:0.0 Enter
tmux -S /tmp/atomic-final-selector-c-10683.sock send-keys -t selector:0.0 Escape
tmux -S /tmp/atomic-final-selector-c-10683.sock send-keys -t selector:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-selector-c-10683.sock send-keys -t selector:0.0 Enter
tmux -S /tmp/atomic-final-selector-c-10683.sock send-keys -t selector:0.0 Enter
tmux -S /tmp/atomic-final-selector-c-10683.sock send-keys -t selector:0.0 Enter
tmux -S /tmp/atomic-final-selector-c-10683.sock send-keys -t selector:0.0 final-cancel-answer Enter
tmux -S /tmp/atomic-final-selector-c-10683.sock kill-server; rm -f /tmp/atomic-final-selector-c-10683.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/selector-cancel-reopen/agent
