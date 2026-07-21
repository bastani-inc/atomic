import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getPersistedProviderSelection, providerModelsAreExactlyEqual } from "./provider-model-reference.ts";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { parseModelPattern } from "./model-resolver-patterns.ts";
import { prepareExplicitProvider } from "./model-resolver-cli.ts";
import type { ScopedModel } from "./model-resolver-types.ts";

export interface ModelScopeDiagnostic {
  type: "warning";
  message: string;
}

export interface ResolveModelScopeResult {
  scopedModels: ScopedModel[];
  diagnostics: ModelScopeDiagnostic[];
}

function hasGlobCharacters(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function parseGlobThinkingLevel(pattern: string): { globPattern: string; thinkingLevel?: ThinkingLevel } {
  const colonIdx = pattern.lastIndexOf(":");
  if (colonIdx === -1) {
    return { globPattern: pattern };
  }

  const suffix = pattern.substring(colonIdx + 1);
  if (!isValidThinkingLevel(suffix)) {
    return { globPattern: pattern };
  }

  return { globPattern: pattern.substring(0, colonIdx), thinkingLevel: suffix };
}

/**
 * Resolve model patterns to actual Model objects with optional thinking levels
 * Format: "pattern:level" where :level is optional
 * For each pattern, finds all matching models and picks the best version:
 * 1. Prefer alias (e.g., claude-sonnet-4-5) over dated versions (claude-sonnet-4-5-20250929)
 * 2. If no alias, pick the latest dated version
 *
 * Supports models with colons in their IDs (e.g., OpenRouter's model:exacto).
 * The algorithm tries to match the full pattern first, then progressively
 * strips colon-suffixes to find a match.
 */
export async function resolveModelScopeWithDiagnostics(
  patterns: string[],
  modelRegistry: ModelRegistry,
): Promise<ResolveModelScopeResult> {
  const explicitProviders = new Set(patterns.flatMap((pattern) => {
    const scopedPattern = parseGlobThinkingLevel(pattern).globPattern;
    const slash = scopedPattern.indexOf("/");
    return slash > 0 ? [scopedPattern.slice(0, slash)] : [];
  }));
  for (const provider of explicitProviders) await prepareExplicitProvider(provider, modelRegistry);
  const availableModels = await modelRegistry.getAvailable();
  const scopedModels: ScopedModel[] = [];
  const diagnostics: ModelScopeDiagnostic[] = [];
  for (const pattern of patterns) {
    if (hasGlobCharacters(pattern)) {
      const { globPattern, thinkingLevel } = parseGlobThinkingLevel(pattern);
      const slash = globPattern.indexOf("/");
      const qualifiedProvider = slash > 0 ? globPattern.slice(0, slash) : undefined;
      const exactPatternProvider = qualifiedProvider && modelRegistry.requiresExactSelectionPersistence?.(qualifiedProvider) === true
        ? qualifiedProvider
        : undefined;
      const matchingModels = availableModels.filter((model) => {
        const fullId = `${model.provider}/${model.id}`;
        const exactIdentity = modelRegistry.requiresExactSelectionPersistence?.(model.provider) === true;
        if (exactIdentity && getPersistedProviderSelection(model) === undefined) return false;
        if (exactPatternProvider !== undefined && model.provider !== exactPatternProvider) return false;
        const nocase = exactPatternProvider === undefined && !exactIdentity;
        return minimatch(fullId, globPattern, { nocase }) || minimatch(model.id, globPattern, { nocase });
      });

      if (matchingModels.length === 0) {
        diagnostics.push({ type: "warning", message: `No models match pattern "${pattern}"` });
        continue;
      }

      for (const model of matchingModels) {
		if (!scopedModels.find((sm) => providerModelsAreExactlyEqual(sm.model, model))) {
          scopedModels.push({ model, thinkingLevel });
        }
      }
      continue;
    }

		const exactBare = availableModels.filter((model) => model.id === pattern);
		const exactProviderOwned = exactBare.filter((model) => modelRegistry.requiresExactSelectionPersistence?.(model.provider) === true);
		if (exactProviderOwned.length > 0 && exactBare.length === 1) {
			scopedModels.push({ model: exactBare[0] });
			continue;
		}
		if (exactProviderOwned.length > 0 && exactBare.length > 1) {
			diagnostics.push({ type: "warning", message: `Model ${JSON.stringify(pattern)} matches ${exactBare.length} exact model identities; specify the provider and an unambiguous occurrence.` });
			continue;
		}
		const slashIndex = pattern.indexOf("/");
		if (slashIndex > 0) {
			const provider = pattern.slice(0, slashIndex);
			const modelId = pattern.slice(slashIndex + 1);
			if (modelRegistry.requiresExactSelectionPersistence?.(provider) === true) {
				try {
					const model = modelRegistry.resolveExactModel(provider, modelId);
					scopedModels.push({ model });
				} catch (error) {
					diagnostics.push({ type: "warning", message: error instanceof Error ? error.message : String(error) });
				}
				continue;
			}
		}

    const ordinaryModels = availableModels.filter((model) => modelRegistry.requiresExactSelectionPersistence?.(model.provider) !== true);
    const { model, thinkingLevel, warning } = parseModelPattern(pattern, ordinaryModels);

    if (warning) {
      diagnostics.push({ type: "warning", message: warning });
    }

    if (!model) {
      diagnostics.push({ type: "warning", message: `No models match pattern "${pattern}"` });
      continue;
    }

	if (!scopedModels.find((sm) => providerModelsAreExactlyEqual(sm.model, model))) {
      scopedModels.push({ model, thinkingLevel });
    }
  }

  return { scopedModels, diagnostics };
}

export async function resolveModelScope(patterns: string[], modelRegistry: ModelRegistry): Promise<ScopedModel[]> {
  const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, modelRegistry);
  for (const diagnostic of diagnostics) {
    console.warn(chalk.yellow(`Warning: ${diagnostic.message}`));
  }
  return scopedModels;
}
