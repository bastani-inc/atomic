import { makeLint, makeTypecheck } from "./steps.mjs";

export default (workflow) =>
	workflow({
		name: "imported-factory",
		description: "Parallel steps come from factories in another module.",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.parallel([makeLint(), makeTypecheck()]);
			return {};
		},
	});
