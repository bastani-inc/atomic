import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { modelsAreEqual } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { parseModelPattern } from "./model-resolver-patterns.ts";
import type { ScopedModel } from "./model-resolver-types.ts";

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
export async function resolveModelScope(patterns: string[], modelRegistry: ModelRegistry): Promise<ScopedModel[]> {
  const availableModels = await modelRegistry.getAvailable();
  const scopedModels: ScopedModel[] = [];

  for (const pattern of patterns) {
    if (hasGlobCharacters(pattern)) {
      const { globPattern, thinkingLevel } = parseGlobThinkingLevel(pattern);
      const matchingModels = availableModels.filter((m) => {
        const fullId = `${m.provider}/${m.id}`;
        return minimatch(fullId, globPattern, { nocase: true }) || minimatch(m.id, globPattern, { nocase: true });
      });

      if (matchingModels.length === 0) {
        console.warn(chalk.yellow(`Warning: No models match pattern "${pattern}"`));
        continue;
      }

      for (const model of matchingModels) {
        if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
          scopedModels.push({ model, thinkingLevel });
        }
      }
      continue;
    }

    const { model, thinkingLevel, warning } = parseModelPattern(pattern, availableModels);

    if (warning) {
      console.warn(chalk.yellow(`Warning: ${warning}`));
    }

    if (!model) {
      console.warn(chalk.yellow(`Warning: No models match pattern "${pattern}"`));
      continue;
    }

    if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
      scopedModels.push({ model, thinkingLevel });
    }
  }

  return scopedModels;
}
