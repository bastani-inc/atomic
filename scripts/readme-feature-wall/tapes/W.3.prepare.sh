#!/usr/bin/env bash
# Register a long-enough run for the list/inputs/status/connect control path.
set -euo pipefail
ws="$1"
mkdir -p "$ws/.atomic/workflows"
cat >"$ws/.atomic/workflows/control-demo.ts" <<'TS'
import { setTimeout as sleep } from "node:timers/promises";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
	name: "control-demo",
	description: "Stay active while the operator inspects and connects to the graph.",
	inputs: { subject: Type.String({ description: "Subject to track." }) },
	outputs: { result: Type.String() },
	run: async (ctx) => {
		await ctx.tool("tracked-work", { subject: ctx.inputs.subject }, async () => {
			await sleep(120_000);
			return ctx.inputs.subject;
		});
		return { result: `Tracked ${ctx.inputs.subject}` };
	},
});
TS
