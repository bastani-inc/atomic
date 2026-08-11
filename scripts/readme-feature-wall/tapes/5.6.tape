# 5.6 A handoff command of your own
# Two real Atomic sessions share one tmux window. Fresh registers first; planner
# reloads and invokes the project-local /handoff template seeded off camera.
Hide
Type "tmux -L fw56 kill-server 2>/dev/null; true"
Enter
Type "tmux -L fw56 new-session -d -s fw -x 236 -y 50 -c $HOME/crash-course"
Enter
Type "tmux -L fw56 set -t fw status off"
Enter
Type "tmux -L fw56 set -g extended-keys on"
Enter
Type "tmux -L fw56 set -g extended-keys-format csi-u"
Enter
Type "tmux -L fw56 split-window -h -t fw:0 -c $HOME/crash-course"
Enter
Type "tmux -L fw56 send-keys -t fw:0.0 atomic Enter"
Enter
Type "tmux -L fw56 send-keys -t fw:0.1 atomic Enter"
Enter
Sleep 16s
Type "clear"
Enter
Show
Type "tmux -L fw56 attach -t fw"
Enter
Sleep 3s
Set TypingSpeed 40ms
Type "/name planner"
Enter
Sleep 3s
Ctrl+B
Type "o"
Sleep 1s
Type "/name fresh"
Enter
Sleep 3s
Set TypingSpeed 28ms
Type "Start an intercom session: check intercom status and list the active intercom sessions."
Sleep 1s
Enter
Sleep 22s
Ctrl+B
Type "o"
Sleep 1s
Type "/reload"
Enter
Sleep 6s
Set TypingSpeed 36ms
Type "/handoff fresh take over the null-email fix in src-client.ts and get it type-checking"
Sleep 1s
Enter
Sleep 100s
