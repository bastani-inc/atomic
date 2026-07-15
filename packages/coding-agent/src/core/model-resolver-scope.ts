import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { modelsAreEqual } from "@earendil-works/pi-ai/compat";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.ts";
import { classifyBareCursorModelReference } from "./legacy-cursor-model-ids.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { parseModelPattern } from "./model-resolver-patterns.ts";
import type { ScopedModel } from "./model-resolver-types.ts";

export interface ModelScopeDiagnostic {
  type: "warning" | "error";
  message: string;
}

export interface ResolveModelScopeResult {
  scopedModels: ScopedModel[];
  diagnostics: ModelScopeDiagnostic[];
}

function hasGlobCharacters(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function providerQualifiedCursorId(pattern: string): string | undefined {
  const separator = pattern.indexOf("/");
  if (separator <= 0 || pattern.slice(0, separator).toLowerCase() !== "cursor") return undefined;
  return pattern.slice(separator + 1);
}

function cursorReselectionDiagnostic(reference: string): ModelScopeDiagnostic {
  return {
    type: "error",
    message: `Model "${reference}" not found. Cursor model IDs changed; reselect an exact model with --list-models.`,
  };
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
  const availableModels = await modelRegistry.getAvailable();
  const scopedModels: ScopedModel[] = [];
  const diagnostics: ModelScopeDiagnostic[] = [];
  for (const pattern of patterns) {
    const qualifiedCursorId = providerQualifiedCursorId(pattern);
    if (qualifiedCursorId !== undefined) {
      const current = availableModels.find(
        (model) => model.provider.toLowerCase() === "cursor" && model.id === qualifiedCursorId,
      );
      if (current) {
        if (!scopedModels.some((entry) => modelsAreEqual(entry.model, current))) {
          scopedModels.push({ model: current });
        }
      } else {
        diagnostics.push(cursorReselectionDiagnostic(pattern));
      }
      continue;
    }

    const cursorReference = classifyBareCursorModelReference(pattern, availableModels);
    if (cursorReference === "current-cursor") {
      const current = availableModels.find((model) => model.provider.toLowerCase() === "cursor" && model.id === pattern);
      if (current && !scopedModels.some((entry) => modelsAreEqual(entry.model, current))) {
        scopedModels.push({ model: current });
      }
      continue;
    }
    if (cursorReference === "legacy-cursor") {
      diagnostics.push(cursorReselectionDiagnostic(`cursor/${pattern}`));
      continue;
    }
    if (hasGlobCharacters(pattern)) {
      const { globPattern, thinkingLevel } = parseGlobThinkingLevel(pattern);
      const matchingModels = availableModels.filter((model) => {
        if (model.provider === "cursor") return false;
        const fullId = `${model.provider}/${model.id}`;
        return minimatch(fullId, globPattern, { nocase: true }) || minimatch(model.id, globPattern, { nocase: true });
      });

      if (matchingModels.length === 0) {
        diagnostics.push({ type: "warning", message: `No models match pattern "${pattern}"` });
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
      diagnostics.push({ type: "warning", message: warning });
    }

    if (!model) {
      diagnostics.push({ type: "warning", message: `No models match pattern "${pattern}"` });
      continue;
    }

    if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
      scopedModels.push({ model, thinkingLevel });
    }
  }

  return { scopedModels, diagnostics };
}

export async function resolveModelScope(patterns: string[], modelRegistry: ModelRegistry): Promise<ScopedModel[]> {
  const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, modelRegistry);
  for (const diagnostic of diagnostics) {
    const prefix = diagnostic.type === "error" ? "Error" : "Warning";
    console.warn(chalk.yellow(`${prefix}: ${diagnostic.message}`));
  }
  return scopedModels;
}
