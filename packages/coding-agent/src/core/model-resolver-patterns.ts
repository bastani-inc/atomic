import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { isValidThinkingLevel } from "../cli/args.ts";
import { hasNormalizedCursorProviderQualifier, isAuthenticatedCursorRouteModel, isExactCursorProvider, parseExactCursorProviderReference } from "./cursor-model-reference.ts";
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
 * Cursor references are matched byte-for-byte first and select the first
 * ordered occurrence. Bare non-Cursor ambiguity is rejected.
 */
export function findExactModelReferenceMatch(
  modelReference: string,
  availableModels: Model<Api>[],
): Model<Api> | undefined {
  // A reserved lowercase `cursor/<bytes>` reference is byte-exact and terminal:
  // it selects only the exact Cursor route (first ordered occurrence) and must
  // never fall through to generic case-insensitive matching that could pick a
  // custom raw id or a case-variant `Cursor` provider row.
  const reservedCursorId = parseExactCursorProviderReference(modelReference);
  if (reservedCursorId !== undefined) {
    return availableModels.find(
      (model) => isAuthenticatedCursorRouteModel(model) && model.id === reservedCursorId,
    );
  }
  const normalizedCursorQualifier = hasNormalizedCursorProviderQualifier(modelReference);
  const exactCursorMatch = availableModels.find(
    (model) => !normalizedCursorQualifier
      && isAuthenticatedCursorRouteModel(model)
      && (modelReference === model.id || modelReference === `cursor/${model.id}`),
  );
  if (exactCursorMatch) return exactCursorMatch;

  const trimmedReference = modelReference.trim();
  if (!trimmedReference) {
    return undefined;
  }

  const normalizedReference = trimmedReference.toLowerCase();
  const canonicalMatches = availableModels.filter(
    (model) => model.provider !== "cursor" && `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
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
          model.provider !== "cursor" &&
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

  const idMatches = availableModels.filter((model) => model.provider !== "cursor" && model.id.toLowerCase() === normalizedReference);
  if (idMatches.length === 1) return idMatches[0];
  if (idMatches.length > 1) return undefined;
  return undefined;
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
  const matches = availableModels.filter(
    (model) => model.provider !== "cursor" && (
      model.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
      model.name?.toLowerCase().includes(modelPattern.toLowerCase())
    ),
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
  if (isExactCursorProvider(provider)) return undefined;
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
  // A reserved lowercase `cursor/<bytes>` reference is byte-exact and terminal:
  // resolve it against exact Cursor rows only and never fall through to generic
  // (or recursive reasoning-suffix) parsing that could select a non-Cursor row.
  const reservedCursorId = parseExactCursorProviderReference(pattern);
  if (reservedCursorId !== undefined) {
    const reservedMatch = availableModels.find(
      (model) => isAuthenticatedCursorRouteModel(model) && model.id === reservedCursorId,
    );
    return { model: reservedMatch, thinkingLevel: undefined, warning: undefined };
  }
  const exactCursorMatch = hasNormalizedCursorProviderQualifier(pattern)
    ? undefined
    : availableModels.find(
      (model) => isAuthenticatedCursorRouteModel(model) && (pattern === model.id || pattern === `cursor/${model.id}`),
    );
  if (exactCursorMatch) {
    return { model: exactCursorMatch, thinkingLevel: undefined, warning: undefined };
  }
  const genericModels = availableModels.filter((model) => model.provider !== "cursor");
  const exactMatch = tryMatchModel(pattern, genericModels);
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
    const result = parseModelPattern(prefix, genericModels, options);
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

  const result = parseModelPattern(prefix, genericModels, options);
  if (result.model) {
    return {
      model: result.model,
      thinkingLevel: undefined,
      warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
    };
  }
  return result;
}
