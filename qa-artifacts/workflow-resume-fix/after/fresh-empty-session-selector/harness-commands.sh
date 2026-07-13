# literal tmux harness command log
# scenario=fresh-empty-session-selector
# socket=/tmp/atomic-final-fresh-empt-4290.sock
tmux -S /tmp/atomic-final-fresh-empt-4290.sock new-session -d -s first -- /tmp/atomic-final-matrix-20260713c/after/fresh-empty-session-selector/launch.sh
tmux -S /tmp/atomic-final-fresh-empt-4290.sock send-keys -t first:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=prompt\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/fresh-empty-session-selector/markers\"\ label=final-fresh\ --no-picker; tmux -S /tmp/atomic-final-fresh-empt-4290.sock send-keys -t first:0.0 Enter
tmux -S /tmp/atomic-final-fresh-empt-4290.sock new-session -d -s second -- /tmp/atomic-final-matrix-20260713c/after/fresh-empty-session-selector/launch.sh
tmux -S /tmp/atomic-final-fresh-empt-4290.sock send-keys -t second:0.0 -l -- /session; tmux -S /tmp/atomic-final-fresh-empt-4290.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-fresh-empt-4290.sock send-keys -t second:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-fresh-empt-4290.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-fresh-empt-4290.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-fresh-empt-4290.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-fresh-empt-4290.sock send-keys -t second:0.0 final-fresh-answer Enter
tmux -S /tmp/atomic-final-fresh-empt-4290.sock kill-server; rm -f /tmp/atomic-final-fresh-empt-4290.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/fresh-empty-session-selector/agent
