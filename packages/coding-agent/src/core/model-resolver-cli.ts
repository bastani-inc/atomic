import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { buildFallbackModel, parseModelPattern } from "./model-resolver-patterns.ts";
import type { ResolveCliModelResult } from "./model-resolver-types.ts";
import type { ModelRegistry } from "./model-registry.ts";

function buildProviderMap(availableModels: Model<Api>[]): Map<string, string> {
  const providerMap = new Map<string, string>();
  for (const model of availableModels) {
    providerMap.set(model.provider.toLowerCase(), model.provider);
  }
  return providerMap;
}

function findRawExactModel(cliModel: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const lower = cliModel.toLowerCase();
  return availableModels.find(
    (m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
  );
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

  const providerMap = buildProviderMap(availableModels);
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
    const exact = findRawExactModel(cliModel, availableModels);
    if (exact) {
      return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
    }
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
    const exact = findRawExactModel(cliModel, availableModels);
    if (exact) {
      return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
    }

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
    const fallbackModel = buildFallbackModel(provider, pattern, availableModels);
    if (fallbackModel) {
      const fallbackWarning = warning
        ? `${warning} Model "${pattern}" not found for provider "${provider}". Using custom model id.`
        : `Model "${pattern}" not found for provider "${provider}". Using custom model id.`;
      return {
        model: fallbackModel,
        thinkingLevel: undefined,
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
