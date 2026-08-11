#!/usr/bin/env bash
# Register a workflow with two typed inputs for the direct key=value launch.
set -euo pipefail
ws="$1"
mkdir -p "$ws/.atomic/workflows"
cat >"$ws/.atomic/workflows/typed-input-demo.ts" <<'TS'
import { setTimeout as sleep } from "node:timers/promises";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
	name: "typed-input-demo",
	description: "Inspect a file to a validated numeric depth.",
	inputs: {
		path: Type.String({ description: "File to inspect." }),
		depth: Type.Integer({ description: "Inspection depth.", minimum: 1, maximum: 3 }),
	},
	outputs: { summary: Type.String() },
	run: async (ctx) => {
		await ctx.tool("typed-inspection", { path: ctx.inputs.path, depth: ctx.inputs.depth }, async () => {
			await sleep(30_000);
			return { accepted: true, ...ctx.inputs };
		});
		return { summary: `Inspected ${ctx.inputs.path} at depth ${ctx.inputs.depth}` };
	},
});
TS
