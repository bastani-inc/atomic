# literal tmux harness command log
# scenario=resume-picker-then-workflow-resume
# socket=/tmp/atomic-final-resume-pic-3049.sock
tmux -S /tmp/atomic-final-resume-pic-3049.sock new-session -d -s first -- /tmp/atomic-final-matrix-20260713c/after/resume-picker-then-workflow-resume/launch.sh
tmux -S /tmp/atomic-final-resume-pic-3049.sock send-keys -t first:0.0 -l -- Reply\ with\ exactly\ QA_HOST_READY.; tmux -S /tmp/atomic-final-resume-pic-3049.sock send-keys -t first:0.0 Enter
tmux -S /tmp/atomic-final-resume-pic-3049.sock send-keys -t first:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=prompt\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/resume-picker-then-workflow-resume/markers\"\ label=final-picker\ --no-picker; tmux -S /tmp/atomic-final-resume-pic-3049.sock send-keys -t first:0.0 Enter
tmux -S /tmp/atomic-final-resume-pic-3049.sock new-session -d -s second -- /tmp/atomic-final-matrix-20260713c/after/resume-picker-then-workflow-resume/launch.sh --resume
tmux -S /tmp/atomic-final-resume-pic-3049.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-resume-pic-3049.sock send-keys -t second:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-resume-pic-3049.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-resume-pic-3049.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-resume-pic-3049.sock send-keys -t second:0.0 Enter
tmux -S /tmp/atomic-final-resume-pic-3049.sock send-keys -t second:0.0 final-picker-answer Enter
tmux -S /tmp/atomic-final-resume-pic-3049.sock kill-server; rm -f /tmp/atomic-final-resume-pic-3049.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/resume-picker-then-workflow-resume/agent
