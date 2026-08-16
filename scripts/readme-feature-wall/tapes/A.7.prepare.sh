#!/usr/bin/env bash
# Screen-driven two-session proof of Intercom group isolation.
set -euo pipefail
ws="$1"
home="$2"
: "$ws"
cat >"$home/.capture-control.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
sock="$1"
default="fw:0.0"
red="fw:0.1"
pane() { tmux -L "$sock" capture-pane -p -t "$1" -S -220; }
wait_for() {
	local target="$1" pattern="$2" timeout="${3:-120}" elapsed=0
	until pane "$target" | grep -Eq "$pattern"; do sleep 1; elapsed=$((elapsed+1)); [ "$elapsed" -lt "$timeout" ] || return 1; done
}
type_line() {
	tmux -L "$sock" send-keys -t "$1" -l -- "$2"
	sleep 1
	tmux -L "$sock" send-keys -t "$1" Enter
}
wait_for "$default" "Engineering matters." 40
wait_for "$red" "Engineering matters." 40
type_line "$default" "/name planner"
type_line "$red" "/name redworker"
sleep 3
type_line "$red" "Check intercom status, then list sessions in your group."
wait_for "$red" "Connected: Yes|Intercom is connected" 90
sleep 3
type_line "$default" "Check intercom status, then list sessions in your group."
wait_for "$default" "Connected: Yes|Intercom is connected" 90
sleep 3
type_line "$default" 'List intercom sessions in group "redteam", then try to send redworker a message saying hi and report the isolation error.'
wait_for "$default" "different intercom group|different group|unreachable|rejected" 150 || true
sleep 10
SH
chmod +x "$home/.capture-control.sh"
