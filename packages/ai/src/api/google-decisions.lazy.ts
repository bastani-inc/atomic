import type { ProviderClassifier } from "../types.ts";

export const googleDecisionsApi = (): ProviderClassifier => ({
	classify: async (model, context, options) =>
		(await import("./google-decisions.ts")).classify(model, context, options),
});
