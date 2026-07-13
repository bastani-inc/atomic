# literal tmux harness command log
# scenario=rapid-resume-command-burst
# socket=/tmp/atomic-final-rapid-resu-13698.sock
tmux -S /tmp/atomic-final-rapid-resu-13698.sock new-session -d -s seed -- /tmp/atomic-final-matrix-20260713c/after/rapid-resume-command-burst/launch.sh
tmux -S /tmp/atomic-final-rapid-resu-13698.sock send-keys -t seed:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=double-prompt\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/rapid-resume-command-burst/markers\"\ label=final-rapid\ --no-picker; tmux -S /tmp/atomic-final-rapid-resu-13698.sock send-keys -t seed:0.0 Enter
tmux -S /tmp/atomic-final-rapid-resu-13698.sock send-keys -t seed:0.0 -l -- /workflow\ connect\ b3e90e6e-51d1-4a00-8de3-b79f1e180446; tmux -S /tmp/atomic-final-rapid-resu-13698.sock send-keys -t seed:0.0 Enter
tmux -S /tmp/atomic-final-rapid-resu-13698.sock send-keys -t seed:0.0 Enter
tmux -S /tmp/atomic-final-rapid-resu-13698.sock send-keys -t seed:0.0 final-rapid-first Enter
tmux -S /tmp/atomic-final-rapid-resu-13698.sock send-keys -t seed:0.0 C-d
tmux -S /tmp/atomic-final-rapid-resu-13698.sock new-session -d -s burst -- /tmp/atomic-final-matrix-20260713c/after/rapid-resume-command-burst/launch.sh
tmux -S /tmp/atomic-final-rapid-resu-13698.sock send-keys -t burst:0.0 /workflow\ resume\ b3e90e6e-51d1-4a00-8de3-b79f1e180446 Enter /workflow\ resume\ b3e90e6e-51d1-4a00-8de3-b79f1e180446 Enter # SINGLE IPC BURST
tmux -S /tmp/atomic-final-rapid-resu-13698.sock send-keys -t burst:0.0 C-d
tmux -S /tmp/atomic-final-rapid-resu-13698.sock send-keys -t burst:0.0 -l -- /workflow\ connect\ b3e90e6e-51d1-4a00-8de3-b79f1e180446; tmux -S /tmp/atomic-final-rapid-resu-13698.sock send-keys -t burst:0.0 Enter
tmux -S /tmp/atomic-final-rapid-resu-13698.sock send-keys -t burst:0.0 Enter
tmux -S /tmp/atomic-final-rapid-resu-13698.sock send-keys -t burst:0.0 final-rapid-second Enter
tmux -S /tmp/atomic-final-rapid-resu-13698.sock kill-server; rm -f /tmp/atomic-final-rapid-resu-13698.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/rapid-resume-command-burst/agent
