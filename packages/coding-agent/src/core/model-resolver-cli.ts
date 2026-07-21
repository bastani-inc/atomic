import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { isValidThinkingLevel } from "../cli/args.ts";
import { buildFallbackModel, parseModelPattern } from "./model-resolver-patterns.ts";
import type { ResolveCliModelResult } from "./model-resolver-types.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { isOfflineModeEnabled } from "./package-manager-env.ts";

function buildProviderMap(availableModels: Model<Api>[]): Map<string, string> {
  const providerMap = new Map<string, string>();
  for (const model of availableModels) {
    providerMap.set(model.provider.toLowerCase(), model.provider);
  }
  return providerMap;
}

function resolveProviderName(
  input: string, availableModels: Model<Api>[], providerMap: ReadonlyMap<string, string>, modelRegistry: ModelRegistry,
): string | undefined {
  if (modelRegistry.requiresExactSelectionPersistence?.(input) === true) return input;
  return availableModels.find((model) => model.provider === input)?.provider ?? providerMap.get(input.toLowerCase());
}

function findRawExactModel(cliModel: string, availableModels: Model<Api>[], modelRegistry: ModelRegistry): Model<Api> | undefined {
  const lower = cliModel.toLowerCase();
  return availableModels.find((model) => modelRegistry.requiresExactSelectionPersistence?.(model.provider) !== true &&
    (model.id.toLowerCase() === lower || `${model.provider}/${model.id}`.toLowerCase() === lower));
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

export async function prepareExplicitProvider(provider: string, modelRegistry: ModelRegistry): Promise<void> {
	if (!modelRegistry.requiresProviderPreparation(provider)) return;
	await modelRegistry.prepareRequiredProviders({
		allowNetwork: !isOfflineModeEnabled(), explicit: true, providers: new Set([provider]),
	});
}

export async function prepareExplicitCliModel(options: {
	readonly cliProvider?: string;
	readonly cliModel?: string;
	readonly modelRegistry: ModelRegistry;
}): Promise<void> {
	const slash = options.cliModel?.indexOf("/") ?? -1;
	const provider = options.cliProvider ?? (slash > 0 ? options.cliModel?.slice(0, slash) : undefined);
	if (provider) await prepareExplicitProvider(provider, options.modelRegistry);
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
  modelRegistry: ModelRegistry;
}): ResolveCliModelResult {
  const { cliProvider, cliModel, modelRegistry } = options;

  if (!cliModel) {
    return { model: undefined, warning: undefined, error: undefined };
  }

  const availableModels = modelRegistry.getAll();
  if (availableModels.length === 0) {
    return {
      model: undefined,
      warning: undefined,
      error: "No models available. Check your installation or add models to models.json.",
    };
  }

  if (!cliProvider) {
    const exact = availableModels.filter((model) => model.id === cliModel || `${model.provider}/${model.id}` === cliModel);
    const exactProviderOwned = exact.filter((model) => modelRegistry.requiresExactSelectionPersistence?.(model.provider) === true);
    if (exactProviderOwned.length > 0 && exact.length === 1) {
      return { model: exact[0], warning: undefined, thinkingLevel: undefined, error: undefined };
    }
    if (exactProviderOwned.length > 0 && exact.length > 1) {
      return {
        model: undefined,
        warning: undefined,
        thinkingLevel: undefined,
        error: `Model ${JSON.stringify(cliModel)} matches ${exact.length} exact model identities; specify the provider and an unambiguous occurrence.`,
      };
    }
  }

  const providerMap = buildProviderMap(availableModels);

  // A registered raw ID may itself look like "provider/model:thinking" (for example,
  // a gateway-owned ID). Preserve that exact ID before provider inference consumes the suffix.
  const rawPattern = splitCustomModelThinkingSuffix(cliModel);
  if (!cliProvider && rawPattern.thinkingLevel !== undefined) {
    const exact = findRawExactModel(cliModel, availableModels, modelRegistry);
    if (exact) {
      return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
    }
  }

  let provider = cliProvider ? resolveProviderName(cliProvider, availableModels, providerMap, modelRegistry) : undefined;
  if (cliProvider && provider && modelRegistry.requiresExactSelectionPersistence?.(provider) === true && cliProvider !== provider) {
    return { model: undefined, warning: undefined, error: `Unknown exact provider "${cliProvider}". Use --list-models to see available providers/models.` };
  }
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
      const candidate = resolveProviderName(maybeProvider, availableModels, providerMap, modelRegistry);
      const canonical = candidate && modelRegistry.requiresExactSelectionPersistence?.(candidate) === true && maybeProvider !== candidate
        ? undefined
        : candidate;
      if (canonical) {
        provider = canonical;
        pattern = cliModel.substring(slashIndex + 1);
        inferredProvider = true;
      }
    }
  }

  if (!provider) {
    const exact = findRawExactModel(cliModel, availableModels, modelRegistry);
    if (exact) {
      return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
    }
  }

  if (cliProvider && provider) {
    const prefix = `${provider}/`;
    const startsWithPrefix = modelRegistry.requiresExactSelectionPersistence?.(provider) === true
      ? cliModel.startsWith(prefix)
      : cliModel.toLowerCase().startsWith(prefix.toLowerCase());
    if (startsWithPrefix) pattern = cliModel.substring(prefix.length);
  }

  const candidates = provider
    ? availableModels.filter((model) => model.provider === provider)
    : availableModels.filter((model) => modelRegistry.requiresExactSelectionPersistence?.(model.provider) !== true);
	if (provider && modelRegistry.requiresExactSelectionPersistence?.(provider) === true) {
		try {
			const model = modelRegistry.resolveExactModel(provider, pattern);
			return { model, thinkingLevel: undefined, warning: undefined, error: undefined };
		} catch (error) {
			return {
				model: undefined,
				thinkingLevel: undefined,
				warning: undefined,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
  const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
    allowInvalidThinkingLevelFallback: false,
  });

  if (model) {
    return { model, thinkingLevel, warning, error: undefined };
  }

  if (inferredProvider) {
    const exact = findRawExactModel(cliModel, availableModels, modelRegistry);
    if (exact) {
      return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
    }

    const fallback = parseModelPattern(cliModel, availableModels.filter((model) => modelRegistry.requiresExactSelectionPersistence?.(model.provider) !== true), {
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
