/**
 * Shared resolution of `settings.fallbackModels` entries.
 *
 * These helpers were module-private to `agent-session-retry.ts`. They are
 * extracted (not copied) so every caller resolves candidates with exactly the
 * same semantics as main-chat model fallback, without reusing
 * `_trySwitchToFallbackModel`, which is main-chat turn machinery.
 */

import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import type { Api, Model } from "@bastani/atomic-ai/compat";
import { resolveModelReference } from "./model-resolver-patterns.ts";
import { isValidThinkingLevel } from "./thinking-levels.ts";

/** Minimal runtime surface needed to resolve a configured fallback entry. */
export interface FallbackModelLookup {
	getModels(): readonly Model<Api>[];
	hasConfiguredAuth(provider: string): boolean;
}

/** A configured fallback entry resolved to a concrete model. */
export interface FallbackModelCandidate {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

/** Split a `provider/model[:thinkingLevel]` entry into its model id and optional level. */
export function splitFallbackModel(value: string): { modelId: string; thinkingLevel?: ThinkingLevel } {
	const trimmed = value.trim();
	const index = trimmed.lastIndexOf(":");
	if (index < 0) return { modelId: trimmed };
	const suffix = trimmed.slice(index + 1).toLowerCase();
	if (!isValidThinkingLevel(suffix)) return { modelId: trimmed };
	return { modelId: trimmed.slice(0, index), thinkingLevel: suffix };
}

/**
 * Resolve one configured fallback entry against the model registry, with the same rules as `--model`: any letter case,
 * an optional `:<thinking>` suffix, bare ids, and ids that contain `/` or `:` themselves (OpenRouter's
 * `qwen/qwen3-coder:exacto`). A bare id that several authenticated providers serve prefers the current/default
 * provider. A candidate whose provider has no configured auth is unusable and resolves to `undefined`.
 */
export function resolveFallbackModel(
	value: string,
	lookup: FallbackModelLookup,
	preferredProvider: string | undefined,
): FallbackModelCandidate | undefined {
	const candidate = resolveFallbackEntry(value, lookup, preferredProvider);
	return candidate && lookup.hasConfiguredAuth(candidate.model.provider) ? candidate : undefined;
}

export function resolveFallbackModelWithoutCredentials(
	value: string,
	lookup: FallbackModelLookup,
	preferredProvider: string | undefined,
): FallbackModelCandidate | undefined {
	const candidate = resolveFallbackEntry(value, lookup, preferredProvider);
	return candidate && !lookup.hasConfiguredAuth(candidate.model.provider) ? candidate : undefined;
}

function resolveFallbackEntry(
	value: string,
	lookup: FallbackModelLookup,
	preferredProvider: string | undefined,
): FallbackModelCandidate | undefined {
	const usable = (provider: string) => lookup.hasConfiguredAuth(provider);
	const result = resolveModelReference(
		{ text: value, thinkingSuffix: "strict", fuzzy: true },
		lookup.getModels(),
		usable,
	);
	if (result.status === "not-found") return undefined;
	const model =
		result.status === "resolved"
			? result.model
			: result.candidates.find((candidate) => candidate.provider === preferredProvider);
	return model ? { model, thinkingLevel: result.thinkingLevel } : undefined;
}

/** Stable `provider/model:level` identity for one attempted fallback candidate. */
export function fallbackKey(model: Model<Api>, thinkingLevel: ThinkingLevel | undefined): string {
	return `${model.provider}/${model.id}:${thinkingLevel ?? ""}`;
}
