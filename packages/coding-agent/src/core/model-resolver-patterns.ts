import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { isValidThinkingLevel } from "../cli/args.ts";
import { findUniqueModelAlias, hasModelAlias } from "./model-id-aliases.ts";
import { defaultModelPerProvider } from "./model-resolver-defaults.ts";
import type { ParsedModelResult } from "./model-resolver-types.ts";

/**
 * Helper to check if a model ID looks like an alias (no date suffix)
 * Dates are typically in format: -20241022 or -20250929
 */
function isAlias(id: string): boolean {
  if (id.endsWith("-latest")) return true;

  const datePattern = /-\d{8}$/;
  return !datePattern.test(id);
}

/**
 * Find an exact model reference match.
 * Supports either a bare model id or a canonical provider/modelId reference.
 * When matching by bare id, ambiguous matches across providers are rejected.
 */
export function findExactModelReferenceMatch(
  modelReference: string,
  availableModels: Model<Api>[],
): Model<Api> | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) {
    return undefined;
  }

  const normalizedReference = trimmedReference.toLowerCase();
  const canonicalMatches = availableModels.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length === 1) {
    return canonicalMatches[0];
  }
  if (canonicalMatches.length > 1) {
    return undefined;
  }

  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.substring(0, slashIndex).trim();
    const modelId = trimmedReference.substring(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter(
        (model) =>
          model.provider.toLowerCase() === provider.toLowerCase() &&
          model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) {
        return providerMatches[0];
      }
      if (providerMatches.length > 1) {
        return undefined;
      }
    }
  }

  const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
  if (idMatches.length === 1) return idMatches[0];
  if (idMatches.length > 1) return undefined;
  if (slashIndex !== -1) {
    const provider = trimmedReference.substring(0, slashIndex).trim();
    const modelId = trimmedReference.substring(slashIndex + 1).trim();
    if (provider && modelId) return findUniqueModelAlias(availableModels, modelId, provider);
  }
  return findUniqueModelAlias(availableModels, trimmedReference);
}

/**
 * Try to match a pattern to a model from the available models list.
 * Returns the matched model or undefined if no match found.
 */
function tryMatchModel(modelPattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
  if (exactMatch) {
    return exactMatch;
  }
  const slashIndex = modelPattern.indexOf("/");
  if (slashIndex !== -1) {
    const provider = modelPattern.substring(0, slashIndex).trim();
    const modelId = modelPattern.substring(slashIndex + 1).trim();
    if (provider && modelId && hasModelAlias(availableModels, modelId, provider)) return undefined;
  } else if (hasModelAlias(availableModels, modelPattern)) {
    return undefined;
  }

  const matches = availableModels.filter(
    (m) =>
      m.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
      m.name?.toLowerCase().includes(modelPattern.toLowerCase()),
  );

  if (matches.length === 0) {
    return undefined;
  }

  const aliases = matches.filter((m) => isAlias(m.id));
  const datedVersions = matches.filter((m) => !isAlias(m.id));

  if (aliases.length > 0) {
    aliases.sort((a, b) => b.id.localeCompare(a.id));
    return aliases[0];
  }

  datedVersions.sort((a, b) => b.id.localeCompare(a.id));
  return datedVersions[0];
}

export function buildFallbackModel(
  provider: string,
  modelId: string,
  availableModels: Model<Api>[],
): Model<Api> | undefined {
  const providerModels = availableModels.filter((m) => m.provider === provider);
  if (providerModels.length === 0) return undefined;

  const defaultId = defaultModelPerProvider[provider];
  const baseModel = defaultId
    ? (providerModels.find((m) => m.id === defaultId) ?? providerModels[0])
    : providerModels[0];
  const fallbackContextWindow = baseModel.contextWindow;

  return {
    ...baseModel,
    id: modelId,
    name: modelId,
    contextWindow: fallbackContextWindow,
    defaultContextWindow: fallbackContextWindow,
    contextWindowOptions: undefined,
  };
}

/**
 * Parse a pattern to extract model and thinking level.
 * Handles models with colons in their IDs (e.g., OpenRouter's :exacto suffix).
 *
 * Algorithm:
 * 1. Try to match full pattern as a model
 * 2. If found, return it with "off" thinking level
 * 3. If not found and has colons, split on last colon:
 *    - If suffix is valid thinking level, use it and recurse on prefix
 *    - If suffix is invalid, warn and recurse on prefix with "off"
 *
 * @internal Exported for testing
 */
export function parseModelPattern(
  pattern: string,
  availableModels: Model<Api>[],
  options?: { allowInvalidThinkingLevelFallback?: boolean },
): ParsedModelResult {
  const exactMatch = tryMatchModel(pattern, availableModels);
  if (exactMatch) {
    return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
  }

  const lastColonIndex = pattern.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return { model: undefined, thinkingLevel: undefined, warning: undefined };
  }

  const prefix = pattern.substring(0, lastColonIndex);
  const suffix = pattern.substring(lastColonIndex + 1);

  if (isValidThinkingLevel(suffix)) {
    const result = parseModelPattern(prefix, availableModels, options);
    if (result.model) {
      return {
        model: result.model,
        thinkingLevel: result.warning ? undefined : (suffix as ThinkingLevel),
        warning: result.warning,
      };
    }
    return result;
  }

  const allowFallback = options?.allowInvalidThinkingLevelFallback ?? true;
  if (!allowFallback) {
    return { model: undefined, thinkingLevel: undefined, warning: undefined };
  }

  const result = parseModelPattern(prefix, availableModels, options);
  if (result.model) {
    return {
      model: result.model,
      thinkingLevel: undefined,
      warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
    };
  }
  return result;
}
