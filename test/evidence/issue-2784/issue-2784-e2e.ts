import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
	name: "issue-2784-e2e",
	description: "Live acceptance fixture for pending-stage Intercom discovery, delivery, and isolated-group ask/reply.",
	inputs: {},
	outputs: {
		result: Type.String(),
	},
	run: async (ctx) => {
		const running = ctx.stage("running-isolated", {
			tools: ["bash", "intercom"],
			group: "alpha",
		});
		const future = ctx.stage("future-isolated", {
			tools: ["bash", "intercom"],
			group: "beta",
		});

		await running.prompt(
			[
				"ISSUE-2784 LIVE E2E RUNNING STAGE.",
				"Stay alive for at least 150 seconds: immediately call bash with `sleep 150`.",
				"After the sleep, inspect every Intercom message injected into your context.",
				"For each normal message, quote its unique token verbatim in your answer.",
				"For any Intercom ask, call intercom reply with the pending ask's exact message id and answer `ASK-REPLY-PROOF-2784-OK`.",
				"Then call intercom list and state whether any stage in the beta sibling subgroup is visible.",
			].join("\n"),
		);

		await future.prompt(
			[
				"ISSUE-2784 LIVE E2E FUTURE STAGE.",
				"Before doing anything else, inspect the messages already present in your FIRST TURN context.",
				"Quote the complete PENDING-PROOF-2784 token you received before initialization.",
				"Then call intercom list and state whether the alpha sibling subgroup's running-isolated stage is visible.",
				"Return a concise receipt.",
			].join("\n"),
		);

		return { result: "issue-2784 live E2E fixture complete" };
	},
});
