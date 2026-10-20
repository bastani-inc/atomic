/**
 * Project workflow fixture for the issue #3783 process-level storage scenario.
 *
 * `test/integration/process-storage-rpc-cli.test.ts` copies this file into a scratch project's
 * `.atomic/workflows/`, so it must stay self-contained. It is tool-only, so a real RPC child runs it
 * to completion without a model, and each run leaves a durable record in the selected journal.
 */
import { workflow } from "@bastani/atomic/workflows";

export default workflow({
	name: "issue-3783-storage",
	description: "Tool-only run that records one durable checkpoint (issue #3783).",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("record", {}, async () => "recorded");
		return {};
	},
});
