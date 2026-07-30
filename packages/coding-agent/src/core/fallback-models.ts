/**
 * Shared resolution of `settings.fallbackModels` entries.
 *
 * These helpers were module-private to `agent-session-retry.ts`. They are
 * extracted (not copied) so compaction planner borrowing resolves candidates
 * with exactly the same semantics as main-chat model fallback, without reusing
 * `_trySwitchToFallbackModel`, which is main-chat turn machinery.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";

const THINKING_SUFFIXES = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];
const THINKING_SUFFIX_SET: ReadonlySet<string> = new Set(THINKING_SUFFIXES);

/** Minimal runtime surface needed to resolve a configured fallback entry. */
export interface FallbackModelLookup {
	getAvailableSnapshot(): readonly Model<Api>[];
	getModel(provider: string, modelId: string): Model<Api> | undefined;
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
	const suffix = trimmed.slice(index + 1);
	if (!THINKING_SUFFIX_SET.has(suffix)) return { modelId: trimmed };
	return { modelId: trimmed.slice(0, index), thinkingLevel: suffix as ThinkingLevel };
}

/**
 * Resolve one configured fallback entry against the model registry.
 *
 * Unqualified ids search the available (authenticated) models and prefer the
 * current/default provider when ambiguous; qualified ids require configured
 * auth. Unusable candidates resolve to `undefined`.
 */
export function resolveFallbackModel(
	value: string,
	lookup: FallbackModelLookup,
	preferredProvider: string | undefined,
): FallbackModelCandidate | undefined {
	const parsed = splitFallbackModel(value);
	if (!parsed.modelId.includes("/")) {
		const available = lookup.getAvailableSnapshot().filter((model) => model.id === parsed.modelId);
		const model =
			available.find((candidate) => candidate.provider === preferredProvider) ??
			(available.length === 1 ? available[0] : undefined);
		return model ? { model, thinkingLevel: parsed.thinkingLevel } : undefined;
	}
	const slash = parsed.modelId.indexOf("/");
	const provider = parsed.modelId.slice(0, slash);
	const modelId = parsed.modelId.slice(slash + 1);
	const model = lookup.getModel(provider, modelId);
	if (!model || !lookup.hasConfiguredAuth(model.provider)) return undefined;
	return { model, thinkingLevel: parsed.thinkingLevel };
}

/** Stable `provider/model:level` identity for one attempted fallback candidate. */
export function fallbackKey(model: Model<Api>, thinkingLevel: ThinkingLevel | undefined): string {
	return `${model.provider}/${model.id}:${thinkingLevel ?? ""}`;
}
