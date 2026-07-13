# literal tmux harness command log
# scenario=nested-child-root-only
# socket=/tmp/atomic-final-nested-chi-8905.sock
tmux -S /tmp/atomic-final-nested-chi-8905.sock new-session -d -s first -- /tmp/atomic-final-matrix-20260713c/after/nested-child-root-only/launch.sh
tmux -S /tmp/atomic-final-nested-chi-8905.sock send-keys -t first:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=nested\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/nested-child-root-only/markers\"\ label=final-nested\ --no-picker; tmux -S /tmp/atomic-final-nested-chi-8905.sock send-keys -t first:0.0 Enter
tmux -S /tmp/atomic-final-nested-chi-8905.sock new-session -d -s second -- /tmp/atomic-final-matrix-20260713c/after/nested-child-root-only/launch.sh
tmux -S /tmp/atomic-final-nested-chi-8905.sock send-keys -t second:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-nested-chi-8905.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-nested-chi-8905.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-nested-chi-8905.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-nested-chi-8905.sock send-keys -t second:0.0 final-nested-answer Enter
tmux -S /tmp/atomic-final-nested-chi-8905.sock kill-server; rm -f /tmp/atomic-final-nested-chi-8905.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/nested-child-root-only/agent
