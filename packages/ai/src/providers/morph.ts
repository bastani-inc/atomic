import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";

export function morphProvider(): Provider {
	return createProvider({
		id: "morph",
		name: "Morph",
		auth: { apiKey: envApiKeyAuth("Morph API key", ["MORPH_API_KEY"]) },
		models: [
			{
				id: "morph-compactor",
				name: "Morph Compactor",
				type: "compactor",
				api: "morph-compact",
				provider: "morph",
				baseUrl: "https://api.morphllm.com/v1",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	});
}
