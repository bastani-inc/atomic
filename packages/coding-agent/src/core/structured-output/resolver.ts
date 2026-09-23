import {
	type ClassifierApi,
	type ClassifierModel,
	type DecisionModel,
	getDecisionModels,
	isModelType,
} from "@bastani/pi-ai";
import { builtinModels } from "@bastani/pi-ai/providers/all";
import type { RouterModelSelectionOptions, StructuredOutputModel } from "./types.js";

const JEV_CAPABILITIES = Object.freeze({
	structuredDecisions: true,
	choice: true,
	maxChoiceOptions: 255,
	chat: false,
	toolCalling: false,
	jsonSchemaGeneration: false,
} as const);

/** A structured-decision route, resolved against the unified classifier registry for direct Jev. */
export interface JevStructuredOutputProvider {
	readonly id: string;
	readonly name: string;
	readonly model: string;
	readonly fullId: string;
	readonly wireModel: string;
	readonly endpoint: string;
	readonly apiKeyEnv: string;
	readonly capabilities: typeof JEV_CAPABILITIES;
	/** Largest request the provider accepts, in tokens, when models.dev publishes it. */
	readonly contextWindow?: number;
	/** USD per million tokens when models.dev publishes it. */
	readonly cost?: DecisionModel["cost"];
}

/** Direct Jev uses the built-in TypeSafe classifier; gateways retain their own wire transports. */
export const JEV_STRUCTURED_OUTPUT_PROVIDER = Object.freeze({
	id: "typesafe",
	name: "TypeSafe",
	model: "jev-latest",
	fullId: "typesafe/jev-latest",
	wireModel: "jev-latest",
	endpoint: "https://api.typesafe.ai/v1/systemone",
	apiKeyEnv: "TYPESAFE_API_KEY",
	capabilities: JEV_CAPABILITIES,
} as const) satisfies JevStructuredOutputProvider;

const OPENROUTER_JEV_STRUCTURED_OUTPUT_PROVIDER = Object.freeze({
	...JEV_STRUCTURED_OUTPUT_PROVIDER,
	id: "openrouter",
	name: "OpenRouter",
	model: "~typesafe/jev-latest",
	fullId: "openrouter/~typesafe/jev-latest",
	wireModel: "~typesafe/jev-latest",
	endpoint: "https://openrouter.ai/api/alpha/decisions",
	apiKeyEnv: "OPENROUTER_API_KEY",
} as const) satisfies JevStructuredOutputProvider;

/**
 * Gateways that resell Jev on a TypeSafe-compatible `systemone` endpoint with plain bearer
 * auth. models.dev supplies which Jev models each one lists (`type: "decision"`), their
 * limits, and prices; the endpoint and credential come from the provider's own docs and
 * from the matching Atomic chat provider so `/login` and saved keys are shared.
 *
 * Not registered: Cloudflare AI Gateway (Workers AI `ai/run` envelope with account and
 * gateway IDs, a different wire shape), NanoGPT (no published `systemone` route), and
 * Vivgrid (its docs list `jev-latest` where models.dev lists `jev`; no Atomic provider).
 */
const JEV_GATEWAY_TRANSPORTS = Object.freeze([
	{
		id: "vercel-ai-gateway",
		name: "Vercel AI Gateway",
		modelsDevProvider: "vercel",
		endpoint: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
		apiKeyEnv: "AI_GATEWAY_API_KEY",
	},
	{
		id: "opencode",
		name: "OpenCode Zen",
		modelsDevProvider: "opencode",
		endpoint: "https://opencode.ai/zen/v1/systemone",
		apiKeyEnv: "OPENCODE_API_KEY",
	},
] as const);

function gatewayProviders(): readonly JevStructuredOutputProvider[] {
	const decisionModels = getDecisionModels();
	return JEV_GATEWAY_TRANSPORTS.flatMap((transport) =>
		decisionModels
			.filter((model) => model.provider === transport.modelsDevProvider)
			.map((model) =>
				Object.freeze({
					id: transport.id,
					name: transport.name,
					model: model.id,
					fullId: `${transport.id}/${model.id}`,
					wireModel: model.id,
					endpoint: transport.endpoint,
					apiKeyEnv: transport.apiKeyEnv,
					capabilities: JEV_CAPABILITIES,
					contextWindow: model.contextWindow,
					cost: model.cost,
				}),
			),
	);
}

/** Dedicated provider catalog; these registrations must not enter the chat model picker. */
export function getStructuredOutputProviders(): readonly JevStructuredOutputProvider[] {
	return [JEV_STRUCTURED_OUTPUT_PROVIDER, OPENROUTER_JEV_STRUCTURED_OUTPUT_PROVIDER, ...gatewayProviders()];
}

/** Minimal SDK adapters use the same built-in classifier catalog as full runtimes. */
export function directJevClassifier(
	registry?: Pick<RouterModelSelectionOptions["modelRegistry"], "getClassifierModel">,
): ClassifierModel<ClassifierApi> | undefined {
	return registry?.getClassifierModel
		? registry.getClassifierModel("typesafe", "jev-latest")
		: builtinModels().getModelOfType("classifier", "typesafe", "jev-latest");
}

export function isStructuredOutputProviderModel(provider: string, modelId: string): boolean {
	return (
		(provider === "typesafe-ai" && modelId === "jev-latest") ||
		getStructuredOutputProviders().some((candidate) => candidate.id === provider && candidate.model === modelId)
	);
}

export function resolveRouterModel(options: RouterModelSelectionOptions): StructuredOutputModel {
	const explicit = options.settings.getRouterModel();
	if (typeof explicit !== "string" || explicit.trim() !== explicit || explicit === "auto") {
		throw new Error("Invalid routerModel: use an exact provider/model ID or an empty string, not auto.");
	}
	const provider = getStructuredOutputProviders().find(
		(candidate) => candidate.fullId === (explicit === "typesafe-ai/jev-latest" ? "typesafe/jev-latest" : explicit),
	);
	if (provider) {
		if (provider.id === "typesafe" && !directJevClassifier(options.modelRegistry)) {
			throw new Error("Invalid routerModel: TypeSafe Jev classifier is not available.");
		}
		return { kind: "jev", fullId: provider.fullId };
	}
	if (
		!explicit &&
		directJevClassifier(options.modelRegistry) &&
		(options.modelRegistry.getProviderAuthStatus?.(JEV_STRUCTURED_OUTPUT_PROVIDER.id).configured ||
			Boolean(process.env.TYPESAFE_API_KEY?.trim()))
	) {
		return { kind: "jev", fullId: JEV_STRUCTURED_OUTPUT_PROVIDER.fullId };
	}
	const model = explicit
		? options.modelRegistry.getAll().find((candidate) => `${candidate.provider}/${candidate.id}` === explicit)
		: options.currentModel;
	if (!model || model.id === "auto" || !isModelType(model, "chat")) {
		throw new Error(
			explicit
				? "Invalid routerModel: the exact model is not in the current chat catalog. Check settings.json."
				: "Router inference needs a selected chat model, configured Jev credentials, or an explicit routerModel.",
		);
	}
	return { kind: "chat", fullId: `${model.provider}/${model.id}`, model };
}
