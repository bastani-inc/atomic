import { type Api, type Model, modelsAreEqual } from "@bastani/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.ts";
import { normalizeModelReference } from "./azure-provider-compat.js";
import { type ModelReferenceResult, resolveModelReference } from "./model-resolver-patterns.ts";
import type { ScopedModel } from "./model-resolver-types.ts";
import type { ModelRuntime } from "./model-runtime.js";

export interface ModelScopeDiagnostic {
	type: "warning";
	code: "no-match" | "invalid-thinking-level" | "ambiguous";
	message: string;
	pattern: string;
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

function resolveExactReference(text: string, models: readonly Model<Api>[]): ModelReferenceResult {
	return resolveModelReference({ text, thinkingSuffix: "none", fuzzy: false }, models, () => true);
}

/**
 * Resolve scope patterns (`--models`, `enabledModels`) to models with optional thinking levels.
 *
 * A complete literal reference is tried first, then glob patterns, then fuzzy matching with an
 * optional `:<thinking>` suffix. Every model in `models` is usable, so credentials cannot choose
 * between providers offering the same id. All of them are added, with a warning so the user can pick
 * one with `provider/id`.
 */
export function resolveModelScopeFromModels(
	patterns: string[],
	models: readonly Model<Api>[],
): ResolveModelScopeResult {
	const scopedModels: ScopedModel[] = [];
	const diagnostics: ModelScopeDiagnostic[] = [];
	const add = (model: Model<Api>, thinkingLevel: ThinkingLevel | undefined) => {
		if (!scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) {
			scopedModels.push({ model, thinkingLevel });
		}
	};
	const noMatch = (pattern: string) =>
		diagnostics.push({ type: "warning", code: "no-match", message: `No models match pattern "${pattern}"`, pattern });
	const ambiguous = (pattern: string, candidates: readonly Model<Api>[]) => {
		const providers = [...new Set(candidates.map((model) => model.provider))].sort((a, b) => a.localeCompare(b));
		diagnostics.push({
			type: "warning",
			code: "ambiguous",
			message: `Pattern "${pattern}" matches several providers: ${providers.join(", ")}. Use provider/id to choose one.`,
			pattern,
		});
	};
	const addResult = (
		pattern: string,
		result: ModelReferenceResult,
		thinkingLevel: ThinkingLevel | undefined,
	): boolean => {
		if (result.status === "not-found") return false;
		if (result.status === "ambiguous") ambiguous(pattern, result.candidates);
		const matches = result.status === "resolved" ? [result.model] : result.candidates;
		for (const model of matches) add(model, thinkingLevel);
		return true;
	};

	for (const rawPattern of patterns) {
		const pattern = normalizeModelReference(rawPattern);
		if (addResult(pattern, resolveExactReference(pattern, models), undefined)) continue;

		if (hasGlobCharacters(pattern)) {
			const { globPattern, thinkingLevel } = parseGlobThinkingLevel(pattern);
			// Ids such as `bracketed-model[1m]` are not globs
			if (addResult(pattern, resolveExactReference(globPattern, models), thinkingLevel)) continue;

			// Match against "provider/modelId" format OR just model ID
			// This allows "*sonnet*" to match without requiring "anthropic/*sonnet*"
			const matches = models.filter(
				(model) =>
					minimatch(`${model.provider}/${model.id}`, globPattern, { nocase: true }) ||
					minimatch(model.id, globPattern, { nocase: true }),
			);
			if (matches.length === 0) noMatch(pattern);
			for (const model of matches) add(model, thinkingLevel);
			continue;
		}

		const result = resolveModelReference(
			{ text: pattern, thinkingSuffix: "lenient", fuzzy: true },
			models,
			() => true,
		);
		if (result.status === "not-found") {
			noMatch(pattern);
			continue;
		}
		if (result.warning) {
			diagnostics.push({ type: "warning", code: "invalid-thinking-level", message: result.warning, pattern });
		}
		addResult(pattern, result, result.thinkingLevel);
	}

	return { scopedModels, diagnostics };
}

export async function resolveModelScopeWithDiagnostics(
	patterns: string[],
	modelRuntime: ModelRuntime,
): Promise<ResolveModelScopeResult> {
	return resolveModelScopeFromModels(patterns, modelRuntime.getAvailableSnapshot());
}

export async function resolveModelScope(patterns: string[], modelRuntime: ModelRuntime): Promise<ScopedModel[]> {
	const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, modelRuntime);
	for (const diagnostic of diagnostics) {
		console.warn(chalk.yellow(`Warning: ${diagnostic.message}`));
	}
	return scopedModels;
}
