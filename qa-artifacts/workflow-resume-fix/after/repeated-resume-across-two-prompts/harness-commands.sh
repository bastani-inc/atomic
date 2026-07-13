# literal tmux harness command log
# scenario=repeated-resume-across-two-prompts
# socket=/tmp/atomic-final-repeated-r-4686.sock
tmux -S /tmp/atomic-final-repeated-r-4686.sock new-session -d -s first -- /tmp/atomic-final-matrix-20260713c/after/repeated-resume-across-two-prompts/launch.sh
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t first:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=double-prompt\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/repeated-resume-across-two-prompts/markers\"\ label=final-repeated\ --no-picker; tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t first:0.0 Enter
tmux -S /tmp/atomic-final-repeated-r-4686.sock new-session -d -s second -- /tmp/atomic-final-matrix-20260713c/after/repeated-resume-across-two-prompts/launch.sh
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t second:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t second:0.0 final-repeated-first Enter
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t second:0.0 C-d
tmux -S /tmp/atomic-final-repeated-r-4686.sock new-session -d -s third -- /tmp/atomic-final-matrix-20260713c/after/repeated-resume-across-two-prompts/launch.sh
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t third:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t third:0.0 Enter
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t third:0.0 Enter
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t third:0.0 Enter
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t third:0.0 final-repeated-second Enter
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t third:0.0 C-d
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t third:0.0 -l -- /workflow\ resume\ 95d57d9e-6a32-4ece-b3dc-69186eedb5d7; tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t third:0.0 Enter
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t third:0.0 C-d
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t third:0.0 C-d
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t third:0.0 -l -- /workflow\ resume\ 42e; tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t third:0.0 Enter
tmux -S /tmp/atomic-final-repeated-r-4686.sock new-session -d -s fourth -- /tmp/atomic-final-matrix-20260713c/after/repeated-resume-across-two-prompts/launch.sh
tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t fourth:0.0 -l -- /workflow\ resume\ 95d57d9e-6a32-4ece-b3dc-69186eedb5d7; tmux -S /tmp/atomic-final-repeated-r-4686.sock send-keys -t fourth:0.0 Enter
tmux -S /tmp/atomic-final-repeated-r-4686.sock kill-server; rm -f /tmp/atomic-final-repeated-r-4686.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/repeated-resume-across-two-prompts/agent
