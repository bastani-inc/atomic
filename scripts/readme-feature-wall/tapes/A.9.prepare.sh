#!/usr/bin/env bash
# Seed a real parent workflow that composes two imported builtins.
set -euo pipefail
ws="$1"
mkdir -p "$ws/.atomic/workflows"
cat >"$ws/.atomic/workflows/research-and-verify.ts" <<'TS'
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
import { adversarialVerification, fanOutAndSynthesize } from "@bastani/workflows/builtin";

export default workflow({
	name: "research-and-verify",
	description: "Map repository slices, synthesize evidence, and verify the report.",
	inputs: { topic: Type.String() },
	outputs: { report_path: Type.String(), approved: Type.Boolean() },
	run: async (ctx) => {
		const research = await ctx.workflow(fanOutAndSynthesize, {
			inputs: {
				prompt: `Partition repository research for: ${ctx.inputs.topic}. Save cited findings per slice.`,
				max_branches: 2,
			},
			stageName: "repository research",
		});
		if (research.exited) return ctx.exit({ status: research.status, reason: research.exitReason });
		const verification = await ctx.workflow(adversarialVerification, {
			inputs: { task: `Verify the cited report at ${research.outputs.synthesis_path}` },
			stageName: "verify research report",
		});
		if (verification.exited) return ctx.exit({ status: verification.status, reason: verification.exitReason });
		return { report_path: research.outputs.synthesis_path, approved: verification.outputs.approved };
	},
});
TS
