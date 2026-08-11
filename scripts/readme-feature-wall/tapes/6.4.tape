# 6.4 Human-in-the-loop gates
# VHS films a tmux-attached real Atomic run while the controller waits for the
# live awaiting-input node and opens its ctx.ui.select form.
Hide
Type "tmux -L fw64 kill-server 2>/dev/null; true"
Enter
Type "tmux -L fw64 new-session -d -s fw -x 236 -y 50 -c $HOME/crash-course"
Enter
Type "tmux -L fw64 set -t fw status off"
Enter
Type "tmux -L fw64 set -g extended-keys on"
Enter
Type "tmux -L fw64 send-keys -t fw:0.0 atomic Enter"
Enter
Type "bash $HOME/.capture-control.sh fw64 >/dev/null 2>&1 &"
Enter
Sleep 4s
Type "clear"
Enter
Show
Type "tmux -L fw64 attach -t fw"
Enter
Sleep 60s
