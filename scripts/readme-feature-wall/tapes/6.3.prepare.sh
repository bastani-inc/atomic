#!/usr/bin/env bash
# Seed the exact custom workflow from crash-course lesson 6.3.
set -euo pipefail
ws="$1"
mkdir -p "$ws/.atomic/workflows"
cat >"$ws/.atomic/workflows/explain-file.ts" <<'TS'
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
	name: "explain-file",
	description: "Explain a file with tracked workflow stages.",
	inputs: {
		path: Type.String({ description: "File path to explain." }),
	},
	outputs: {
		explanation: Type.String({
			description: "Explanation of the file's purpose, risks, and key symbols.",
		}),
	},
	run: async (ctx) => {
		const explanation = await ctx.task("explain", {
			prompt: `Read ${String(ctx.inputs.path)} and explain purpose, risks, and key symbols.`,
			context: "fresh",
		});
		return { explanation: explanation.text };
	},
});
TS
