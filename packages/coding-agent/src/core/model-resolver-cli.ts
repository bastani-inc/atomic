import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { isValidThinkingLevel } from "../cli/args.ts";
import { buildFallbackModel, parseModelPattern } from "./model-resolver-patterns.ts";
import {
  hasNormalizedCursorProviderQualifier,
  isAuthenticatedCursorRouteModel,
  isExactCursorProvider,
  parseExactCursorProviderReference,
  resolveProviderIdentity,
} from "./cursor-model-reference.ts";
import { classifyBareCursorModelReference } from "./legacy-cursor-model-ids.ts";
import type { ResolveCliModelResult } from "./model-resolver-types.ts";
import type { ModelRegistry } from "./model-registry.ts";

function availableProviderIdentities(availableModels: readonly Model<Api>[]): string[] {
  return availableModels.map((model) => model.provider);
}

function findRawExactModel(cliModel: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  // A reserved lowercase `cursor/<bytes>` reference is byte-exact and terminal:
  // match only exact Cursor rows and never case-fold onto a non-Cursor row.
  const reservedCursorId = parseExactCursorProviderReference(cliModel);
  if (reservedCursorId !== undefined) {
    return availableModels.find((model) => isAuthenticatedCursorRouteModel(model) && model.id === reservedCursorId);
  }
  const normalizedCursorQualifier = hasNormalizedCursorProviderQualifier(cliModel);
  const lower = cliModel.toLowerCase();
  return availableModels.find((model) => model.provider === "cursor"
    ? isAuthenticatedCursorRouteModel(model) && !normalizedCursorQualifier && (cliModel === model.id || cliModel === `cursor/${model.id}`)
    : model.id.toLowerCase() === lower || `${model.provider}/${model.id}`.toLowerCase() === lower);
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
  modelRegistry: Pick<ModelRegistry, "getAll">;
}): ResolveCliModelResult {
  const { cliProvider, cliModel, modelRegistry } = options;

  if (cliModel === undefined) {
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
  const classifyBareCursor = cliProvider === undefined || isExactCursorProvider(cliProvider);
  if (classifyBareCursor) {
    const kind = classifyBareCursorModelReference(cliModel, availableModels);
    if (kind === "current-cursor") {
      const current = availableModels.find((model) => isAuthenticatedCursorRouteModel(model) && model.id === cliModel);
      if (current) return { model: current, warning: undefined, thinkingLevel: undefined, error: undefined };
    }
  }

  const providers = availableProviderIdentities(availableModels);

  // A registered raw ID may itself look like "provider/model:thinking" (for example,
  // a gateway-owned ID). Preserve that exact ID before provider inference consumes the suffix.
  const rawPattern = splitCustomModelThinkingSuffix(cliModel);
  if (!cliProvider && rawPattern.thinkingLevel !== undefined) {
    const exact = findRawExactModel(cliModel, availableModels);
    if (exact) {
      return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
    }
  }

  let provider = cliProvider
    ? isExactCursorProvider(cliProvider) ? cliProvider : resolveProviderIdentity(cliProvider, providers)
    : undefined;
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
    const reservedCursorId = parseExactCursorProviderReference(cliModel);
    if (reservedCursorId !== undefined) {
      provider = "cursor";
      pattern = reservedCursorId;
      inferredProvider = true;
    } else {
      const slashIndex = cliModel.indexOf("/");
      if (slashIndex !== -1) {
        const maybeProvider = cliModel.substring(0, slashIndex);
        const canonical = resolveProviderIdentity(maybeProvider, providers);
        if (canonical) {
          provider = canonical;
          pattern = cliModel.substring(slashIndex + 1);
          inferredProvider = true;
        }
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
    const hasProviderPrefix = provider === "cursor"
      ? cliModel.startsWith(prefix)
      : cliModel.toLowerCase().startsWith(prefix.toLowerCase());
    if (hasProviderPrefix) pattern = cliModel.substring(prefix.length);
  }

  if (isExactCursorProvider(provider)) {
    const exact = availableModels.find((model) => isAuthenticatedCursorRouteModel(model) && model.id === pattern);
    if (exact) return { model: exact, thinkingLevel: undefined, warning: undefined, error: undefined };
    return {
      model: undefined,
      thinkingLevel: undefined,
      warning: undefined,
      error: `Model "${provider}/${pattern}" not found. Use --list-models to see available models.`,
    };
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

  // Cursor's authenticated catalog requires exact routing metadata; an arbitrary
  // fallback ID would be selectable but could never produce a valid request.
  if (provider && provider !== "cursor") {
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
