# A.7 Intercom group isolation
# Two real sessions start in different launch-time groups. The default session
# can peek at redteam but its attempted send is rejected by the broker.
Hide
Type "tmux -L fwa7 kill-server 2>/dev/null; true"
Enter
Sleep 1s
Type "tmux -L fwa7 new-session -d -s fw -x 236 -y 50 -c $HOME/crash-course"
Enter
Type "tmux -L fwa7 set -t fw status off"
Enter
Type "tmux -L fwa7 set -g extended-keys on"
Enter
Type "tmux -L fwa7 set -g extended-keys-format csi-u"
Enter
Type "tmux -L fwa7 split-window -h -t fw:0 -c $HOME/crash-course"
Enter
Type "tmux -L fwa7 send-keys -t fw:0.0 atomic Enter"
Enter
Type "tmux -L fwa7 send-keys -t fw:0.1 'ATOMIC_INTERCOM_GROUP=redteam atomic' Enter"
Enter
Type "bash $HOME/.capture-control.sh fwa7 >/dev/null 2>&1 &"
Enter
Sleep 5s
Type "clear"
Enter
Show
Type "tmux -L fwa7 attach -t fw"
Enter
Sleep 260s
