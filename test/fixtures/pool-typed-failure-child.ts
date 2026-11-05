import { StageRehydrationError, workflow } from "@bastani/atomic/workflows";

/** The fields of the error the child fails with, so a test can compare what reaches the root (#4309). */
export const REHYDRATION_FIELDS = {
	runId: "pooled-child-run",
	stageId: "waiting-stage",
	stageName: "review",
	sessionId: "session-1",
} as const;

/** A pooled child that fails with a StageRehydrationError wrapping the store's failure (#4309). */
export const child = workflow({
	name: "pool-typed-failure-child",
	description: "Fails on a local worker with a typed stage-wait error",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("rehydrate", {}, async () => {
			throw new StageRehydrationError(REHYDRATION_FIELDS, { cause: new Error("session store unreachable") });
		});
		return {};
	},
});
