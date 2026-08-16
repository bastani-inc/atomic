# 6.5 Durability and resume
# VHS films one real Atomic session inside tmux while a hidden controller kills
# the process mid-run and restarts it, so the kill and the recovery are driven
# by observed pane state rather than by a fixed sleep.
Hide
Type "tmux -L fw65 kill-server 2>/dev/null; true"
Enter
Type "tmux -L fw65 new-session -d -s fw -x 236 -y 50 -c $HOME/crash-course"
Enter
Type "tmux -L fw65 set -t fw status off"
Enter
Type "tmux -L fw65 set -g extended-keys on"
Enter
Type "tmux -L fw65 set -g extended-keys-format csi-u"
Enter
Type "tmux -L fw65 send-keys -t fw:0.0 atomic Enter"
Enter
Type "bash $HOME/.capture-control.sh fw65 >/dev/null 2>&1 &"
Enter
Sleep 4s
Type "clear"
Enter
Show
Type "tmux -L fw65 attach -t fw"
Enter
Sleep 200s
