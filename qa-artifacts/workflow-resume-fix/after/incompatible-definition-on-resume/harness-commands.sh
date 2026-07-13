# literal tmux harness command log
# scenario=incompatible-definition-on-resume
# socket=/tmp/atomic-final-incompatib-12851.sock
tmux -S /tmp/atomic-final-incompatib-12851.sock new-session -d -s seed -- /tmp/atomic-final-matrix-20260713c/after/incompatible-definition-on-resume/launch.sh
tmux -S /tmp/atomic-final-incompatib-12851.sock send-keys -t seed:0.0 -l -- Reply\ with\ exactly\ QA_HOST_READY.; tmux -S /tmp/atomic-final-incompatib-12851.sock send-keys -t seed:0.0 Enter
tmux -S /tmp/atomic-final-incompatib-12851.sock send-keys -t seed:0.0 -l -- /workflow\ workflow-resume-e2e-fixture\ mode=double-prompt\ marker_root=\"/tmp/atomic-final-matrix-20260713c/after/incompatible-definition-on-resume/markers\"\ label=final-incompatible\ --no-picker; tmux -S /tmp/atomic-final-incompatib-12851.sock send-keys -t seed:0.0 Enter
tmux -S /tmp/atomic-final-incompatib-12851.sock send-keys -t seed:0.0 -l -- /workflow\ connect\ fdf49378-cf06-41c8-92f5-1cc5891203b0; tmux -S /tmp/atomic-final-incompatib-12851.sock send-keys -t seed:0.0 Enter
tmux -S /tmp/atomic-final-incompatib-12851.sock send-keys -t seed:0.0 Enter
tmux -S /tmp/atomic-final-incompatib-12851.sock send-keys -t seed:0.0 final-incompatible-first Enter
tmux -S /tmp/atomic-final-incompatib-12851.sock send-keys -t seed:0.0 C-d
tmux -S /tmp/atomic-final-incompatib-12851.sock new-session -d -s recovered -- /tmp/atomic-final-matrix-20260713c/after/incompatible-definition-on-resume/launch.sh --session 019f5b37-0885-7411-ab9c-f7152155b190
tmux -S /tmp/atomic-final-incompatib-12851.sock send-keys -t recovered:0.0 -l -- /workflow\ resume\ fdf49378-cf06-41c8-92f5-1cc5891203b0; tmux -S /tmp/atomic-final-incompatib-12851.sock send-keys -t recovered:0.0 Enter
tmux -S /tmp/atomic-final-incompatib-12851.sock send-keys -t recovered:0.0 -l -- /workflow\ resume\ fdf49378-cf06-41c8-92f5-1cc5891203b0; tmux -S /tmp/atomic-final-incompatib-12851.sock send-keys -t recovered:0.0 Enter
tmux -S /tmp/atomic-final-incompatib-12851.sock kill-server; rm -f /tmp/atomic-final-incompatib-12851.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/incompatible-definition-on-resume/agent
tmux -S /tmp/atomic-final-incompat-proof-13328.sock new-session -d -s proof -- /tmp/atomic-final-matrix-20260713c/after/incompatible-definition-on-resume/launch.sh --session 019f5b37-0885-7411-ab9c-f7152155b190
tmux -S /tmp/atomic-final-incompat-proof-13328.sock send-keys -t proof:0.0 -l -- /workflow\ resume\ fdf49378-cf06-41c8-92f5-1cc5891203b0; tmux -S /tmp/atomic-final-incompat-proof-13328.sock send-keys -t proof:0.0 Enter
tmux -S /tmp/atomic-final-incompat-proof-13328.sock send-keys -t proof:0.0 -l -- /workflow\ resume\ fdf49378-cf06-41c8-92f5-1cc5891203b0; tmux -S /tmp/atomic-final-incompat-proof-13328.sock send-keys -t proof:0.0 Enter
tmux -S /tmp/atomic-final-incompat-proof-13328.sock kill-server; rm -f /tmp/atomic-final-incompat-proof-13328.sock; rm -rf /tmp/atomic-final-matrix-20260713c/after/incompatible-definition-on-resume/agent
