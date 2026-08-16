#!/usr/bin/env bash
# Seed a compact real ctx.ui.select gate and its screen-driven controller.
set -euo pipefail
ws="$1"
home="$2"
mkdir -p "$ws/.atomic/workflows"
cat >"$ws/.atomic/workflows/release-gate-demo.ts" <<'TS'
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
	name: "release-gate-demo",
	description: "Pause a release decision at a human-selected risk gate.",
	outputs: {
		risk: Type.String(),
	},
	run: async (ctx) => {
		const risk = await ctx.ui.select("How risky does this change set look?", ["low", "medium", "high"]);
		return { risk };
	},
});
TS
cat >"$home/.capture-control.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
sock="$1"
target="fw:0.0"
pane() { tmux -L "$sock" capture-pane -p -t "$target" -S -120; }
wait_for() {
	local pattern="$1" timeout="${2:-60}" elapsed=0
	until pane | grep -Fq "$pattern"; do sleep 1; elapsed=$((elapsed+1)); [ "$elapsed" -lt "$timeout" ] || return 1; done
}
send() { tmux -L "$sock" send-keys -t "$target" "$@"; }
wait_for "Engineering matters." 30
send "/workflow reload" Enter
wait_for "Reloaded workflow resources" 30
send "/workflow release-gate-demo" Enter
wait_for "started in background" 30
send "/workflow connect" Enter
wait_for "Connect to workflow run" 30
send Enter
wait_for "awaiting input" 30
send Enter
wait_for "How risky does this change set look?" 30
# Exercise the real selector without submitting it: move through all three
# choices while the workflow remains paused for human input.
for key in Down Down Up Up Down Down Up Up Down Down Up Up Down Down Up Up Down Down Up Up Down Down Up Up Down Down Up Up Down Down Up Up; do
	send "$key"
	sleep 0.5
done
SH
chmod +x "$home/.capture-control.sh"
