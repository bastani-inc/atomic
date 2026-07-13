# literal tmux harness command log
# scenario=multiple-resumable-roots
# socket=/tmp/atomic-final-multiple-r-14153.sock
tmux -S /tmp/atomic-final-multiple-r-14153.sock new-session -d -s rootA -- /tmp/atomic-final-matrix-20260713c/after/multiple-resumable-roots/launch.sh
tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t rootA:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=prompt\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/multiple-resumable-roots/markers\"\ label=final-multi-A\ --no-picker; tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t rootA:0.0 Enter
tmux -S /tmp/atomic-final-multiple-r-14153.sock new-session -d -s rootB -- /tmp/atomic-final-matrix-20260713c/after/multiple-resumable-roots/launch.sh
tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t rootB:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=prompt\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/multiple-resumable-roots/markers\"\ label=final-multi-B\ --no-picker; tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t rootB:0.0 Enter
tmux -S /tmp/atomic-final-multiple-r-14153.sock new-session -d -s selector1 -- /tmp/atomic-final-matrix-20260713c/after/multiple-resumable-roots/launch.sh
tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t selector1:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t selector1:0.0 Enter
tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t selector1:0.0 C-p
tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t selector1:0.0 Enter
tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t selector1:0.0 Enter
tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t selector1:0.0 final-multi-first-answer Enter
tmux -S /tmp/atomic-final-multiple-r-14153.sock new-session -d -s selector2 -- /tmp/atomic-final-matrix-20260713c/after/multiple-resumable-roots/launch.sh
tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t selector2:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t selector2:0.0 Enter
tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t selector2:0.0 C-p
tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t selector2:0.0 Enter
tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t selector2:0.0 Enter
tmux -S /tmp/atomic-final-multiple-r-14153.sock send-keys -t selector2:0.0 final-multi-second-answer Enter
tmux -S /tmp/atomic-final-multiple-r-14153.sock kill-server; rm -f /tmp/atomic-final-multiple-r-14153.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/multiple-resumable-roots/agent
