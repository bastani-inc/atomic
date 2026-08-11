# 6.6 Security review with a repair loop
# VHS films one real tmux-attached Atomic session. The hidden controller waits
# for actual pane text before sending each key, so the human gate is driven by
# observed live state rather than guessed timing.
Hide
Type "tmux -L fw66 kill-server 2>/dev/null; true"
Enter
Type "tmux -L fw66 new-session -d -s fw -x 236 -y 50 -c $HOME/crash-course"
Enter
Type "tmux -L fw66 set -t fw status off"
Enter
Type "tmux -L fw66 set -g extended-keys on"
Enter
Type "tmux -L fw66 send-keys -t fw:0.0 atomic Enter"
Enter
Type "bash $HOME/.capture-control.sh fw66 >/dev/null 2>&1 &"
Enter
Sleep 4s
Type "clear"
Enter
Show
Type "tmux -L fw66 attach -t fw"
Enter
Sleep 90s
