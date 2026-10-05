import { resolveAzureBaseUrl, resolveDeploymentName } from "../api/azure-openai-config.ts";
import { azureOpenAIResponsesApi } from "../api/azure-openai-responses.lazy.ts";
import { lazyStream } from "../api/lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Api, Model, ProviderStreams, StreamOptions } from "../types.ts";
import { AZURE_MODELS } from "./azure.models.ts";

function resolveAzureModel(model: Model<Api>, options: StreamOptions | undefined): Model<Api> {
	return { ...model, baseUrl: resolveAzureBaseUrl(model, options) };
}

function withDeploymentName<T extends StreamOptions>(model: Model<Api>, options: T | undefined): T | undefined {
	const deploymentName = resolveDeploymentName(model, options);
	if (deploymentName === model.id) return options;
	return {
		...options,
		onPayload: async (payload, payloadModel) => {
			const params = { ...(payload as object), model: deploymentName };
			return (await options?.onPayload?.(params, payloadModel)) ?? params;
		},
	} as T;
}

function azureStreams(streams: ProviderStreams): ProviderStreams {
	return {
		stream: (model, context, options) =>
			lazyStream(model, async () =>
				streams.stream(resolveAzureModel(model, options), context, withDeploymentName(model, options)),
			),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () =>
				streams.streamSimple(resolveAzureModel(model, options), context, withDeploymentName(model, options)),
			),
	};
}

export function azureProvider(): Provider<"azure-openai-responses" | "openai-completions"> {
	return createProvider({
		id: "azure",
		name: "Azure",
		auth: { apiKey: envApiKeyAuth("Azure OpenAI API key", ["AZURE_OPENAI_API_KEY"]) },
		models: Object.values(AZURE_MODELS),
		api: {
			"azure-openai-responses": azureOpenAIResponsesApi(),
			"openai-completions": azureStreams(openAICompletionsApi()),
		},
	});
}
