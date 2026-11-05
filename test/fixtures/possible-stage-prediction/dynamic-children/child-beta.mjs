export default (workflow) =>
	workflow({
		name: "child-beta",
		description: "Second child.",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("beta-draft", { prompt: "Draft the beta plan." });
			return {};
		},
	});
