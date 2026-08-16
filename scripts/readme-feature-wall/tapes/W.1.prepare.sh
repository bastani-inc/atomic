#!/usr/bin/env bash
# Register the small workflow used to prove a plain-English installed-workflow launch.
set -euo pipefail
ws="$1"
mkdir -p "$ws/.atomic/workflows"
cat >"$ws/.atomic/workflows/plain-english-demo.ts" <<'TS'
import { setTimeout as sleep } from "node:timers/promises";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
	name: "plain-english-demo",
	description: "Demonstrate launching a registered workflow from ordinary chat.",
	inputs: { topic: Type.String({ description: "Topic to inspect." }) },
	outputs: { result: Type.String() },
	run: async (ctx) => {
		await ctx.tool("inspect-topic", { topic: ctx.inputs.topic }, async () => {
			await sleep(30_000);
			return `Inspected ${ctx.inputs.topic}`;
		});
		return { result: `Inspection complete for ${ctx.inputs.topic}` };
	},
});
TS
