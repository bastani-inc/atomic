function stageName(kind, round) {
	return `${kind}-${round}`;
}

export default (workflow) =>
	workflow({
		name: "helper-names",
		description: "Stage names come from a helper function.",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task(stageName("review", 1), { prompt: "Review the change." });
			await ctx.task(stageName("summary", 2), { prompt: "Summarize the review." });
			return {};
		},
	});
