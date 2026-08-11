# 5.4 Escalating to a human supervisor
# Two real Atomic sessions share one tmux window: the delegate on the right,
# the human supervisor on the left. A hidden controller waits for actual pane
# text before sending each key, so the ask and the answer are driven by the
# live state on screen rather than by guessed timing.
Hide
Type "tmux -L fw54 kill-server 2>/dev/null; true"
Enter
Type "tmux -L fw54 new-session -d -s fw -x 236 -y 50 -c $HOME/crash-course"
Enter
Type "tmux -L fw54 set -t fw status off"
Enter
Type "tmux -L fw54 set -g extended-keys on"
Enter
Type "tmux -L fw54 set -g extended-keys-format csi-u"
Enter
Type "tmux -L fw54 split-window -h -t fw:0 -c $HOME/crash-course"
Enter
Type "tmux -L fw54 send-keys -t fw:0.0 atomic Enter"
Enter
Type "tmux -L fw54 send-keys -t fw:0.1 atomic Enter"
Enter
Type "bash $HOME/.capture-control.sh fw54 >/dev/null 2>&1 &"
Enter
Sleep 6s
Type "clear"
Enter
Show
Type "tmux -L fw54 attach -t fw"
Enter
Sleep 260s
