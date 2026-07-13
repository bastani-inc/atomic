# literal tmux harness command log
# scenario=completed-run-exclusion
# socket=/tmp/atomic-final-completed--7563.sock
tmux -S /tmp/atomic-final-completed--7563.sock new-session -d -s first -- /tmp/atomic-final-matrix-20260713c/after/completed-run-exclusion/launch.sh
tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t first:0.0 -l -- Reply\ with\ exactly\ QA_HOST_READY.; tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t first:0.0 Enter
tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t first:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=completed\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/completed-run-exclusion/markers\"\ label=final-completed\ --no-picker; tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t first:0.0 Enter
tmux -S /tmp/atomic-final-completed--7563.sock new-session -d -s second -- /tmp/atomic-final-matrix-20260713c/after/completed-run-exclusion/launch.sh
tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t second:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t second:0.0 Escape
tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t second:0.0 -l -- /workflow\ resume\ 33a6e020-c02f-4f48-b3f4-b97f33bd71f3; tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t second:0.0 Escape
tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t second:0.0 -l -- /workflow\ resume\ 33a6e020-c02f-4f48-b3f4-b97f33bd71f3; tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t second:0.0 -l -- Reply\ with\ exactly\ STILL_INTERACTIVE.; tmux -S /tmp/atomic-final-completed--7563.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-completed--7563.sock kill-server; rm -f /tmp/atomic-final-completed--7563.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/completed-run-exclusion/agent
