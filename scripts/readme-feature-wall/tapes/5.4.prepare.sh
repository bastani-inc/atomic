#!/usr/bin/env bash
# Screen-driven controller for the 5.4 capture.
#
# What this records is a delegate that refuses to decide alone: it stops, asks
# the human supervising the run, and blocks until that human answers.
#
# It is captured as two real sessions rather than as a subagent because the
# subagent supervisor bridge does not register in this environment: three takes
# with `contact_supervisor` produced a child reporting the capability was
# unavailable, which is the opposite of the row's claim. The intercom ask is
# the same escalation shape and it is real, so it is what gets filmed.
set -euo pipefail
ws="$1"
home="$2"
: "$ws"

cat >"$home/.capture-control.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
sock="$1"
planner="fw:0.0"
worker="fw:0.1"

pane() { tmux -L "$sock" capture-pane -p -t "$1" -S -200; }
wait_for() {
	local target="$1" pattern="$2" timeout="${3:-120}" elapsed=0
	until pane "$target" | grep -Eq "$pattern"; do
		sleep 1
		elapsed=$((elapsed + 1))
		[ "$elapsed" -lt "$timeout" ] || return 1
	done
}
type_line() {
	tmux -L "$sock" send-keys -t "$1" -l -- "$2"
	sleep 1
	tmux -L "$sock" send-keys -t "$1" Enter
}

wait_for "$planner" "Engineering matters." 40
wait_for "$worker" "Engineering matters." 40

type_line "$planner" "/name supervisor"
sleep 3
type_line "$worker" "/name worker"
sleep 3

# Intercom connects lazily and is tool-driven, so the worker registers first.
type_line "$worker" "Check intercom status and list the sessions in your group."
wait_for "$worker" "Connected: Yes|Intercom is connected" 90
sleep 2

type_line "$planner" "Check intercom status."
wait_for "$planner" "Connected: Yes|Intercom is connected" 90
sleep 2

type_line "$worker" 'Harden validate() in src-client.ts. You may not choose between returning false and throwing on a null email yourself: that is a product decision. Use intercom ask to put that exact question to the session named supervisor, and wait for the answer before you edit anything.'

# The escalation lands in the supervisor pane and the worker blocks on it.
wait_for "$planner" "null email|validate\\(\\)|throw" 200 || true
sleep 4
type_line "$planner" 'Reply: "Return false. Do not throw."'
wait_for "$worker" "Return false" 180 || true
sleep 8
SH
chmod +x "$home/.capture-control.sh"
