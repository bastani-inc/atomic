# literal tmux harness command log
# scenario=exact-session-after-ctrl-c
# socket=/tmp/atomic-final-exact-sess-2565.sock
tmux -S /tmp/atomic-final-exact-sess-2565.sock new-session -d -s first -- /tmp/atomic-final-matrix-20260713c/after/exact-session-after-ctrl-c/launch.sh
tmux -S /tmp/atomic-final-exact-sess-2565.sock send-keys -t first:0.0 -l -- Reply\ with\ exactly\ QA_HOST_READY.; tmux -S /tmp/atomic-final-exact-sess-2565.sock send-keys -t first:0.0 Enter
tmux -S /tmp/atomic-final-exact-sess-2565.sock send-keys -t first:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=prompt\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/exact-session-after-ctrl-c/markers\"\ label=final-exact\ --no-picker; tmux -S /tmp/atomic-final-exact-sess-2565.sock send-keys -t first:0.0 Enter
tmux -S /tmp/atomic-final-exact-sess-2565.sock new-session -d -s reopened -- /tmp/atomic-final-matrix-20260713c/after/exact-session-after-ctrl-c/launch.sh --session 019f5b2c-e7d5-7bd1-8e44-ef708eeebb47
tmux -S /tmp/atomic-final-exact-sess-2565.sock send-keys -t reopened:0.0 -l -- /workflow\ resume\ 80b2446b-a2aa-40d1-82d9-7303bac2e631; tmux -S /tmp/atomic-final-exact-sess-2565.sock send-keys -t reopened:0.0 Enter
tmux -S /tmp/atomic-final-exact-sess-2565.sock send-keys -t reopened:0.0 Enter
tmux -S /tmp/atomic-final-exact-sess-2565.sock send-keys -t reopened:0.0 final-exact-answer Enter
tmux -S /tmp/atomic-final-exact-sess-2565.sock kill-server; rm -f /tmp/atomic-final-exact-sess-2565.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/exact-session-after-ctrl-c/agent
