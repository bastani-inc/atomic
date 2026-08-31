import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
	name: "intercom-restrictive-e2e",
	description: "Verify mandatory Intercom in a maximally restricted workflow model stage.",
	inputs: {},
	outputs: { result: Type.String() },
	run: async (ctx) => {
		const stage = await ctx.task("restricted-status", {
			prompt:
				"Call the ordinary intercom tool with action status. Then respond with exactly WORKFLOW_INTERCOM_OK and include the connected group reported by the tool.",
			noTools: "all",
			tools: ["read"],
			excludedTools: ["intercom", "bash", "workflow", "subagent"],
		});
		return { result: stage.text };
	},
});
