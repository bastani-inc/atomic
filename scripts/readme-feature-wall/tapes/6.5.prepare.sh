#!/usr/bin/env bash
set -euo pipefail
ws="$1"
home="$2"
: "$ws"

cat >"$home/.capture-control.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
sock="$1"
target="fw:0.0"

pane() { tmux -L "$sock" capture-pane -p -t "$target" -S -300; }
wait_for() {
	local pattern="$1" timeout="${2:-120}" elapsed=0
	until pane | grep -Eq "$pattern"; do
		sleep 1
		elapsed=$((elapsed + 1))
		[ "$elapsed" -lt "$timeout" ] || return 1
	done
}
type_line() {
	tmux -L "$sock" send-keys -t "$target" -l -- "$1"
	sleep 1
	tmux -L "$sock" send-keys -t "$target" Enter
}

wait_for "Engineering matters." 40
type_line "Run the fan-out-and-synthesize workflow with the workflow tool to answer: how does demo-app/server.js handle user input?"
wait_for "read demo-app/server.js|handles input|SQL" 150 || true
sleep 6

# Kill Atomic itself, mid-run, scoped to this pane's children.
pane_pid="$(tmux -L "$sock" display-message -p -t "$target" '#{pane_pid}')"
pkill -9 -P "$pane_pid" || true
sleep 5

tmux -L "$sock" send-keys -t "$target" -l -- "atomic"
tmux -L "$sock" send-keys -t "$target" Enter
wait_for "Engineering matters." 60
sleep 2

type_line "/resume"
wait_for "Workflow runs" 60 || true
sleep 3
# Widen the picker from the current folder to every retained run, which is
# where the checkpoint counts are listed.
tmux -L "$sock" send-keys -t "$target" Tab
sleep 20
SH
chmod +x "$home/.capture-control.sh"
