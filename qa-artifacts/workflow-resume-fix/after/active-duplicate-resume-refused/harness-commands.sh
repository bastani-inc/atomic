# literal tmux harness command log
# scenario=active-duplicate-resume-refused
# socket=/tmp/atomic-final-active-dup-9295.sock
tmux -S /tmp/atomic-final-active-dup-9295.sock new-session -d -s active -- /tmp/atomic-final-matrix-20260713c/after/active-duplicate-resume-refused/launch.sh
tmux -S /tmp/atomic-final-active-dup-9295.sock send-keys -t active:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=prompt\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/active-duplicate-resume-refused/markers\"\ label=final-active\ --no-picker; tmux -S /tmp/atomic-final-active-dup-9295.sock send-keys -t active:0.0 Enter
tmux -S /tmp/atomic-final-active-dup-9295.sock new-session -d -s contender -- /tmp/atomic-final-matrix-20260713c/after/active-duplicate-resume-refused/launch.sh
tmux -S /tmp/atomic-final-active-dup-9295.sock send-keys -t contender:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-active-dup-9295.sock send-keys -t contender:0.0 Enter
tmux -S /tmp/atomic-final-active-dup-9295.sock send-keys -t contender:0.0 Escape
tmux -S /tmp/atomic-final-active-dup-9295.sock send-keys -t contender:0.0 -l -- /workflow\ resume\ f75bc366-9dab-470c-979b-738af3a9ad9b; tmux -S /tmp/atomic-final-active-dup-9295.sock send-keys -t contender:0.0 Enter
tmux -S /tmp/atomic-final-active-dup-9295.sock send-keys -t active:0.0 -l -- /workflow\ connect\ f75bc366-9dab-470c-979b-738af3a9ad9b; tmux -S /tmp/atomic-final-active-dup-9295.sock send-keys -t active:0.0 Enter
tmux -S /tmp/atomic-final-active-dup-9295.sock send-keys -t active:0.0 Enter
tmux -S /tmp/atomic-final-active-dup-9295.sock send-keys -t active:0.0 final-active-answer Enter
tmux -S /tmp/atomic-final-active-dup-9295.sock kill-server; rm -f /tmp/atomic-final-active-dup-9295.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/active-duplicate-resume-refused/agent
