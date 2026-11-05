export default (workflow) =>
	workflow({
		name: "child-alpha",
		description: "First child.",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("alpha-draft", { prompt: "Draft the alpha plan." });
			return {};
		},
	});
