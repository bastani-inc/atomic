import { workflow } from "@bastani/workflows";

const options = {
	model: `nested-discovery-fixture/${process.env.NESTED_FALLBACK_CONTROL === "primary" ? "fixture" : "failing"}`,
	fallbackModels: ["nested-discovery-fixture/fixture"],
	group: "reviewers",
};
const grandchild = workflow({
	name: "fallback-grandchild",
	inputs: {},
	outputs: {},
	description: "Repeated nested fallback grandchild.",
	run: async (ctx) => {
		await ctx.stage("reviewer", options).prompt("fixture-hold");
		return {};
	},
});
const child = workflow({
	name: "fallback-child",
	inputs: {},
	outputs: {},
	description: "Repeated nested fallback child.",
	run: async (ctx) => {
		await ctx.stage("child-reviewer", options).prompt("fixture-complete");
		await ctx.workflow(grandchild);
		return {};
	},
});
export default workflow({
	name: "nested-fallback-fixture",
	inputs: {},
	outputs: {},
	description: "Nested fallback ownership regression.",
	run: async (ctx) => {
		await ctx
			.stage("top-reviewer", options)
			.prompt(process.env.NESTED_COLD_TOP_PROBE ? "fixture-top-hold" : "fixture-complete");
		await Promise.all([ctx.workflow(child), ctx.workflow(child)]);
		return {};
	},
});
