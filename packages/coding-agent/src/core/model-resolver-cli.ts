import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { isValidThinkingLevel } from "../cli/args.ts";
import { buildFallbackModel, parseModelPattern } from "./model-resolver-patterns.ts";
import type { ResolveCliModelResult } from "./model-resolver-types.ts";
import type { ModelRuntime } from "./model-runtime.ts";

function buildProviderMap(availableModels: Model<Api>[]): Map<string, string> {
	const providerMap = new Map<string, string>();
	for (const model of availableModels) {
		providerMap.set(model.provider.toLowerCase(), model.provider);
	}
	return providerMap;
}

function resolveRawExactModel(
	cliModel: string,
	availableModels: Model<Api>[],
	modelRuntime: ModelRuntime,
): ResolveCliModelResult | undefined {
	const lower = cliModel.toLowerCase();
	const exactModels = new Map<string, Model<Api>>();
	for (const model of availableModels) {
		if (model.id.toLowerCase() !== lower && `${model.provider}/${model.id}`.toLowerCase() !== lower) continue;
		const fullId = `${model.provider.toLowerCase()}/${model.id.toLowerCase()}`;
		if (!exactModels.has(fullId)) exactModels.set(fullId, model);
	}
	const exactMatches = [...exactModels.values()];
	if (exactMatches.length === 0) return undefined;
	if (exactMatches.length === 1) {
		return { model: exactMatches[0], warning: undefined, thinkingLevel: undefined, error: undefined };
	}

	const authenticatedExactMatches = exactMatches.filter((model) => modelRuntime.hasConfiguredAuth(model.provider));
	if (authenticatedExactMatches.length === 1) {
		return {
			model: authenticatedExactMatches[0],
			warning: undefined,
			thinkingLevel: undefined,
			error: undefined,
		};
	}

	const matches = exactMatches
		.map((model) => `${model.provider}/${model.id}`)
		.sort((a, b) => a.localeCompare(b))
		.join(", ");
	const authHint =
		authenticatedExactMatches.length === 0
			? "No matching provider is authenticated."
			: "More than one matching provider is authenticated.";
	return {
		model: undefined,
		warning: undefined,
		thinkingLevel: undefined,
		error: `Model "${cliModel}" is ambiguous across providers: ${matches}. ${authHint} Use --provider or provider/model.`,
	};
}

function splitCustomModelThinkingSuffix(pattern: string): {
	modelId: string;
	thinkingLevel: ResolveCliModelResult["thinkingLevel"];
} {
	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex <= 0) return { modelId: pattern, thinkingLevel: undefined };

	const suffix = pattern.substring(lastColonIndex + 1);
	if (!isValidThinkingLevel(suffix)) return { modelId: pattern, thinkingLevel: undefined };

	return {
		modelId: pattern.substring(0, lastColonIndex),
		thinkingLevel: suffix,
	};
}

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
	modelRuntime: ModelRuntime;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, modelRuntime } = options;

	if (!cliModel) {
		return { model: undefined, warning: undefined, error: undefined };
	}

	const availableModels = [...modelRuntime.getModels()];
	if (availableModels.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	const providerMap = buildProviderMap(availableModels);

	// A registered raw ID may itself look like "provider/model:thinking" (for example,
	// a gateway-owned ID). Preserve that exact ID before provider inference consumes the suffix.
	const rawPattern = splitCustomModelThinkingSuffix(cliModel);
	if (!cliProvider && rawPattern.thinkingLevel !== undefined) {
		const exact = resolveRawExactModel(cliModel, availableModels, modelRuntime);
		if (exact) return exact;
	}

	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	let pattern = cliModel;
	let inferredProvider = false;

	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		if (slashIndex !== -1) {
			const maybeProvider = cliModel.substring(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = cliModel.substring(slashIndex + 1);
				inferredProvider = true;
			}
		}
	}

	if (!provider) {
		const exact = resolveRawExactModel(cliModel, availableModels, modelRuntime);
		if (exact) return exact;
	}

	if (cliProvider && provider) {
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
			pattern = cliModel.substring(prefix.length);
		}
	}

	const candidates = provider ? availableModels.filter((m) => m.provider === provider) : availableModels;
	const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
		allowInvalidThinkingLevelFallback: false,
	});

	if (model) {
		return { model, thinkingLevel, warning, error: undefined };
	}

	if (inferredProvider) {
		const exact = resolveRawExactModel(cliModel, availableModels, modelRuntime);
		if (exact) return exact;

		const fallback = parseModelPattern(cliModel, availableModels, {
			allowInvalidThinkingLevelFallback: false,
		});
		if (fallback.model) {
			return {
				model: fallback.model,
				thinkingLevel: fallback.thinkingLevel,
				warning: fallback.warning,
				error: undefined,
			};
		}
	}

	if (provider) {
		// Registered resolution above takes precedence, including model IDs whose final colon
		// segment happens to look like a thinking level. Only custom fallback splits it.
		const customPattern = splitCustomModelThinkingSuffix(pattern);
		const fallbackModel = buildFallbackModel(provider, customPattern.modelId, availableModels);
		if (fallbackModel) {
			const customModel =
				customPattern.thinkingLevel && customPattern.thinkingLevel !== "off"
					? { ...fallbackModel, reasoning: true }
					: fallbackModel;
			const fallbackWarning = warning
				? `${warning} Model "${customPattern.modelId}" not found for provider "${provider}". Using custom model id.`
				: `Model "${customPattern.modelId}" not found for provider "${provider}". Using custom model id.`;
			return {
				model: customModel,
				thinkingLevel: customPattern.thinkingLevel,
				warning: fallbackWarning,
				error: undefined,
			};
		}
	}

	const display = provider ? `${provider}/${pattern}` : cliModel;
	return {
		model: undefined,
		thinkingLevel: undefined,
		warning,
		error: `Model "${display}" not found. Use --list-models to see available models.`,
	};
}
