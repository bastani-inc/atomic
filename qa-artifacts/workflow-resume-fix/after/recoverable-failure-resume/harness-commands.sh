# literal tmux harness command log
# scenario=recoverable-failure-resume
# socket=/tmp/atomic-final-recoverabl-6798.sock
tmux -S /tmp/atomic-final-recoverabl-6798.sock new-session -d -s first -- /tmp/atomic-final-matrix-20260713c/after/recoverable-failure-resume/launch.sh
tmux -S /tmp/atomic-final-recoverabl-6798.sock send-keys -t first:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=fail-once\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/recoverable-failure-resume/markers\"\ label=final-recoverable\ --no-picker; tmux -S /tmp/atomic-final-recoverabl-6798.sock send-keys -t first:0.0 Enter
tmux -S /tmp/atomic-final-recoverabl-6798.sock new-session -d -s second -- /tmp/atomic-final-matrix-20260713c/after/recoverable-failure-resume/launch.sh
tmux -S /tmp/atomic-final-recoverabl-6798.sock send-keys -t second:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-recoverabl-6798.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-recoverabl-6798.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-recoverabl-6798.sock kill-server; rm -f /tmp/atomic-final-recoverabl-6798.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/recoverable-failure-resume/agent
