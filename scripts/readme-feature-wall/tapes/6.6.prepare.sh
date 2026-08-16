#!/usr/bin/env bash
# Seed the compact project-local workflow used by the 6.6 capture.
#
# The crash-course lesson builds the same shape in a longer form: audit,
# human confirm, repair, and independent verification. This capture keeps the
# audit and verification deterministic so the graph reaches the repair loop in
# a practical recording window. The repair itself is a real fresh-context agent
# task against the planted defects in demo-app/server.js.
set -euo pipefail
ws="$1"
mkdir -p "$ws/.atomic/workflows"
cat >"$ws/.atomic/workflows/security-review-demo.ts" <<'TS'
import { readFile } from "node:fs/promises";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

const target = "demo-app/server.js";

async function blockers(): Promise<string[]> {
	const source = await readFile(target, "utf8");
	const open: string[] = [];
	if (/sk-live-[A-Za-z0-9]+/.test(source)) open.push("P1 hardcoded API key at demo-app/server.js:4");
	if (/req\.query\.name\s*\+/.test(source) || /\+\s*req\.query\.name/.test(source)) {
		open.push("P1 SQL injection at demo-app/server.js:8");
	}
	return open;
}

export default workflow({
	name: "security-review-demo",
	description: "Audit the planted defects, confirm, repair once, then prove the result.",
	outputs: {
		approved: Type.Boolean(),
		iterations: Type.Number(),
	},
	run: async (ctx) => {
		const audit = await ctx.tool("audit", { target }, blockers);
		if (audit.length === 0) return { approved: true, iterations: 0 };

		const proceed = await ctx.ui.confirm(`Audit found ${audit.length} P1 blockers. Run repair iteration 1?`);
		if (!proceed) {
			return ctx.exit({
				status: "blocked",
				reason: "Repair declined.",
				outputs: { approved: false, iterations: 0 },
			});
		}

		await ctx.task("repair-1", {
			prompt: [
				"Fix only these planted security findings in demo-app/server.js:",
				...audit.map((item) => `- ${item}`),
				"Move the key to process.env.API_KEY and replace SQL string concatenation with a parameterized query representation.",
				"Keep the patch small. Do not change any unrelated file.",
			].join("\n"),
			context: "fresh",
		});

		const remaining = await ctx.tool("verify-2", { target }, blockers);
		return { approved: remaining.length === 0, iterations: 1 };
	},
});
TS

# Screen-driven tmux controller. It sends the next key only after the real UI
# renders the state that makes that key legal; no fixed sleeps stand in for
# workflow completion and no output is synthesized.
home="$2"
cat >"$home/.capture-control.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
sock="$1"
target="fw:0.0"

pane() { tmux -L "$sock" capture-pane -p -t "$target" -S -200; }
wait_for() {
	local pattern="$1" timeout="${2:-180}" elapsed=0
	until pane | grep -Fq "$pattern"; do
		sleep 1
		elapsed=$((elapsed + 1))
		[ "$elapsed" -lt "$timeout" ] || return 1
	done
}
send() { tmux -L "$sock" send-keys -t "$target" "$@"; }

wait_for "Engineering matters." 30
send "/workflow reload" Enter
wait_for "Reloaded workflow resources" 30
send "/workflow security-review-demo" Enter
wait_for "started in background" 30
send "/workflow connect" Enter
wait_for "Connect to workflow run" 30
send Enter
wait_for "awaiting input" 30
# The graph node is selected. Open its live input form.
send Enter
wait_for "Audit found 2 P1 blockers" 30
# The controller is now inside the form. Use its documented yes shortcut, then
# submit; earlier y attempts failed only because they were sent from graph view.
send y
sleep 1
send Enter
# The form leaves us in stage chat. Return to the graph, wait for the real
# repair and proof nodes, then pan down so both are visible in the capture.
sleep 2
send C-x
wait_for "repair-1" 180 || true
wait_for "verify-2" 180 || true
send Down Down Down Down Down
SH
chmod +x "$home/.capture-control.sh"
