# 5.5 Intercom context handoff
# Two real Atomic sessions share one tmux window. Fresh registers with the lazy
# intercom broker before planner sends a context and snippet attachment.
Hide
Type "tmux -L fw55 kill-server 2>/dev/null; true"
Enter
Type "tmux -L fw55 new-session -d -s fw -x 236 -y 50 -c $HOME/crash-course"
Enter
Type "tmux -L fw55 set -t fw status off"
Enter
Type "tmux -L fw55 set -g extended-keys on"
Enter
Type "tmux -L fw55 set -g extended-keys-format csi-u"
Enter
Type "tmux -L fw55 split-window -h -t fw:0 -c $HOME/crash-course"
Enter
Type "tmux -L fw55 send-keys -t fw:0.0 atomic Enter"
Enter
Type "tmux -L fw55 send-keys -t fw:0.1 atomic Enter"
Enter
Sleep 16s
Type "clear"
Enter
Show
Type "tmux -L fw55 attach -t fw"
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
Type "Hand off project context to fresh over intercom: send one message with a context attachment named project-briefing summarizing what validate and fetchUser do, plus a TypeScript snippet attachment named src-client.ts containing the validate body."
Sleep 1s
Enter
Sleep 90s
