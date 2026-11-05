import makeAlpha from "./child-alpha.mjs";
import makeBeta from "./child-beta.mjs";

export default (workflow) => {
	const children = { alpha: makeAlpha(workflow), beta: makeBeta(workflow) };
	return workflow({
		name: "dynamic-children",
		description: "Runs the child selected by its input.",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const kind = ctx.inputs.kind ?? "alpha";
			await ctx.workflow(children[kind]);
			return {};
		},
	});
};
