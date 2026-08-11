# 5.3 Planner-worker intercom coordination
# Two real Atomic sessions in one tmux window, on a per-lesson tmux socket so
# parallel captures cannot collide. The hidden preamble only starts the two
# sessions; every intercom interaction below is filmed.
Hide
Type "tmux -L fw53 kill-server 2>/dev/null; true"
Enter
Sleep 1s
Type "tmux -L fw53 new-session -d -s fw -x 236 -y 50 -c $HOME/crash-course"
Enter
Type "tmux -L fw53 set -t fw status off"
Enter
Type "tmux -L fw53 set -g extended-keys on"
Enter
Type "tmux -L fw53 set -g extended-keys-format csi-u"
Enter
Type "tmux -L fw53 split-window -h -t fw:0 -c $HOME/crash-course"
Enter
Type "tmux -L fw53 send-keys -t fw:0.0 atomic Enter"
Enter
Type "tmux -L fw53 send-keys -t fw:0.1 atomic Enter"
Enter
Sleep 16s
Type "clear"
Enter
Sleep 1s
Show
Type "tmux -L fw53 attach -t fw"
Enter
Sleep 3s
Set TypingSpeed 40ms
Type "/name planner"
Enter
Sleep 3s
Ctrl+B
Type "o"
Sleep 1.5s
Type "/name worker"
Enter
Sleep 3s
# The worker must reach the broker before the planner can find it: intercom
# connections are lazy and tool-driven.
Set TypingSpeed 28ms
Type "Check intercom status and then wait for messages."
Sleep 1s
Enter
Sleep 22s
Ctrl+B
Type "o"
Sleep 1.5s
Type "Check intercom status, list the active intercom sessions, then send the worker session a task: summarize what src-client.ts does in two sentences."
Sleep 1s
Enter
Sleep 75s
