import { normalizeProviderId } from "@bastani/pi-ai";
import { normalizeModelReference } from "./azure-provider-compat.js";
import { buildFallbackModel, resolveModelReference } from "./model-resolver-patterns.ts";
import type { ResolveCliModelResult } from "./model-resolver-types.ts";
import type { ModelRuntime } from "./model-runtime.js";

/**
 * Resolve a single model from CLI flags.
 *
 * Supports:
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>
 * - Fuzzy matching (same rules as model scoping: exact id, then partial id/name)
 *
 * Note: This does not apply the thinking level by itself, but it may *parse* and
 * return a thinking level from "<pattern>:<thinking>" so the caller can apply it.
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	/** `--api-key` was supplied for the selected provider. */
	inlineApiKey?: boolean;
	modelRuntime: ModelRuntime;
}): ResolveCliModelResult {
	const { inlineApiKey, modelRuntime } = options;
	const cliProvider = options.cliProvider ? normalizeProviderId(options.cliProvider.toLowerCase()) : undefined;
	const cliModel = options.cliModel ? normalizeModelReference(options.cliModel) : undefined;

	if (!cliModel) {
		return { model: undefined, warning: undefined, error: undefined };
	}

	// Use every model, not only authenticated ones, so --api-key can set up a provider.
	const models = [...modelRuntime.getModels()];
	if (models.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	const provider = cliProvider
		? models.find((model) => model.provider.toLowerCase() === cliProvider.toLowerCase())?.provider
		: undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	const result = resolveModelReference(
		{ text: cliModel, provider, thinkingSuffix: "strict", fuzzy: true },
		models,
		// An inline key goes to whichever provider is selected, so stored credentials must not choose it
		inlineApiKey ? () => false : (providerId) => modelRuntime.hasConfiguredAuth(providerId),
	);
	if (result.status === "resolved") {
		return { model: result.model, thinkingLevel: result.thinkingLevel, warning: result.warning, error: undefined };
	}
	if (result.status === "ambiguous") {
		const matches = result.candidates
			.map((model) => `${model.provider}/${model.id}`)
			.sort((a, b) => a.localeCompare(b))
			.join(", ");
		const authHint = inlineApiKey
			? "--api-key does not choose a provider."
			: result.usableCount === 0
				? "No matching provider is authenticated."
				: "More than one matching provider is authenticated.";
		return {
			model: undefined,
			warning: undefined,
			thinkingLevel: undefined,
			error: `Model "${cliModel}" is ambiguous across providers: ${matches}. ${authHint} Use --provider or provider/model.`,
		};
	}

	const { target } = result;
	const fallbackModel = target
		? buildFallbackModel(target.provider, target.modelId, target.providerModels)
		: undefined;
	if (!target || !fallbackModel) {
		return {
			model: undefined,
			thinkingLevel: undefined,
			warning: undefined,
			error: `Model "${cliModel}" not found. Use --list-models to see available models.`,
		};
	}

	// Registered resolution above takes precedence, including model IDs whose final colon
	// segment happens to look like a thinking level. Only the custom fallback splits it.
	const thinkingLevel = target.thinkingLevel;
	return {
		model: thinkingLevel && thinkingLevel !== "off" ? { ...fallbackModel, reasoning: true } : fallbackModel,
		thinkingLevel,
		warning: `Model "${target.modelId}" not found for provider "${target.provider}". Using custom model id.`,
		error: undefined,
	};
}
