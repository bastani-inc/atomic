# literal tmux harness command log
# scenario=stale-picker-row-revalidation
# socket=/tmp/atomic-final-stale-pick-9694.sock
tmux -S /tmp/atomic-final-stale-pick-9694.sock new-session -d -s creator -- /tmp/atomic-final-matrix-20260713c/after/stale-picker-row-revalidation/launch.sh
tmux -S /tmp/atomic-final-stale-pick-9694.sock send-keys -t creator:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=prompt\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/stale-picker-row-revalidation/markers\"\ label=final-stale\ --no-picker; tmux -S /tmp/atomic-final-stale-pick-9694.sock send-keys -t creator:0.0 Enter
tmux -S /tmp/atomic-final-stale-pick-9694.sock new-session -d -s selector -- /tmp/atomic-final-matrix-20260713c/after/stale-picker-row-revalidation/launch.sh
tmux -S /tmp/atomic-final-stale-pick-9694.sock send-keys -t selector:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-stale-pick-9694.sock send-keys -t selector:0.0 Enter
tmux -S /tmp/atomic-final-stale-pick-9694.sock new-session -d -s helper -- /tmp/atomic-final-matrix-20260713c/after/stale-picker-row-revalidation/launch.sh
tmux -S /tmp/atomic-final-stale-pick-9694.sock send-keys -t helper:0.0 -l -- /workflow\ resume\ 86d67711-66a0-4ee8-a117-b72dbf8b2988; tmux -S /tmp/atomic-final-stale-pick-9694.sock send-keys -t helper:0.0 Enter
tmux -S /tmp/atomic-final-stale-pick-9694.sock send-keys -t helper:0.0 Enter
tmux -S /tmp/atomic-final-stale-pick-9694.sock send-keys -t helper:0.0 final-stale-answer Enter
tmux -S /tmp/atomic-final-stale-pick-9694.sock send-keys -t selector:0.0 Enter
tmux -S /tmp/atomic-final-stale-pick-9694.sock kill-server; rm -f /tmp/atomic-final-stale-pick-9694.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/stale-picker-row-revalidation/agent
