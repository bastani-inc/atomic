const AREAS = ["api", "ui", "docs"];

export default (workflow) =>
	workflow({
		name: "data-driven-loop",
		description: "One stage per area, from the inputs or a default list.",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const areas = ctx.inputs.areas ?? AREAS;
			for (const area of areas) {
				await ctx.task(area, { prompt: `Review the ${area} area.` });
			}
			return {};
		},
	});
