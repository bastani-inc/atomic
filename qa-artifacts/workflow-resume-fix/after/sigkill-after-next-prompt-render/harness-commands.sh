# literal tmux harness command log
# scenario=sigkill-after-next-prompt-render
# socket=/tmp/atomic-final-sigkill-af-11277.sock
tmux -S /tmp/atomic-final-sigkill-af-11277.sock new-session -d -s seed -- /tmp/atomic-final-matrix-20260713c/after/sigkill-after-next-prompt-render/launch.sh
tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t seed:0.0 -l -- Reply\ with\ exactly\ QA_HOST_READY.; tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t seed:0.0 Enter
tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t seed:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=double-prompt\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/sigkill-after-next-prompt-render/markers\"\ label=final-sigkill\ --no-picker; tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t seed:0.0 Enter
tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t seed:0.0 -l -- /workflow\ connect\ 0812ec39-8590-4e03-b99e-26d799ea141a; tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t seed:0.0 Enter
tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t seed:0.0 Enter
tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t seed:0.0 final-sigkill-first Enter
tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t seed:0.0 Enter
kill -KILL 11528 # synchronized after unique second prompt
tmux -S /tmp/atomic-final-sigkill-af-11277.sock new-session -d -s recovered -- /tmp/atomic-final-matrix-20260713c/after/sigkill-after-next-prompt-render/launch.sh --session 019f5b35-106c-7518-a401-5ed7fc9b22f5
tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t recovered:0.0 -l -- /workflow\ resume; tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t recovered:0.0 Enter
tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t recovered:0.0 Enter
tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t recovered:0.0 Enter
tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t recovered:0.0 Enter
tmux -S /tmp/atomic-final-sigkill-af-11277.sock send-keys -t recovered:0.0 final-sigkill-second Enter
tmux -S /tmp/atomic-final-sigkill-af-11277.sock kill-server; rm -f /tmp/atomic-final-sigkill-af-11277.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/sigkill-after-next-prompt-render/agent
