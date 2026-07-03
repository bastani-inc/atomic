import type { CopilotModelContext } from "./copilot-model-catalog.ts";

/**
 * Static CAPI-derived limit snapshot for bundled GitHub Copilot models.
 *
 * CAPI is the source of truth for what GitHub actually enforces, and the live
 * `/models` catalog (or its disk cache) is always authoritative when
 * available — this table is consulted **only when the active catalog has no
 * entry for the model** (cold start without cache, catalog fetch failure,
 * network-restricted environments such as eval containers or CI). Without it,
 * the bundled pi-ai metadata wins, and several bundled entries disagree with
 * CAPI (snapshotted 2026-07-02): the gpt-5.x family claims a 400k window vs
 * CAPI's enforced 272k default tier, claude-opus-4.6/claude-sonnet-4.6 claim
 * the branded 1M window as their base tier vs CAPI's 200k default, and
 * claude-opus-4.6/4.7 ship a 32k output cap vs CAPI's real 64k.
 *
 * Why this matters (issue #1608): auto-compaction thresholds and overflow
 * recovery are driven by `model.contextWindow`, and request output caps by
 * `model.maxTokens`. With an overstated window a session never compacts,
 * sails past the server-side cap, and CAPI starts intercepting requests with
 * canned zero-usage refusals ("I'm sorry, but I cannot assist with that
 * request.") reported as `stopReason: "length"`. Understated output caps
 * instead truncate long responses below the real limit.
 *
 * Entries mirror the shape `resolveCopilotModelContext` derives from CAPI
 * `capabilities.limits` / `billing.token_prices`, including the long-context
 * tier where CAPI advertises one (`contextWindowOptions` with the branded
 * window plus the hard `maxInputTokens` prompt cap, e.g. 922k input + 128k
 * output for gpt-5.5's 1.05M tier). This keeps a returning user's persisted
 * long-context selection valid on a cold start without a catalog; actual long
 * tier use is still gated server-side by entitlement, with the existing
 * friendly-error handling on rejection. The snapshot covers every bundled
 * model present in the CAPI catalog — also the currently-agreeing ones — so
 * upstream metadata drift cannot silently reintroduce the failure. Bundled
 * models absent from the CAPI catalog (retired or not-yet-listed ids) are
 * intentionally omitted — there is no CAPI ground truth to snapshot for them.
 */

export type StaticCopilotModelFallback = Pick<
	CopilotModelContext,
	"contextWindow" | "contextWindowOptions" | "maxInputTokens" | "maxTokens"
>;

/** CAPI 1.05M long-context tier shared by the tiered OpenAI gpt-5.x models. */
const OPENAI_LONG_TIER: StaticCopilotModelFallback = {
	contextWindow: 272_000,
	contextWindowOptions: [272_000, 1_050_000],
	maxInputTokens: 922_000,
	maxTokens: 128_000,
};

/** CAPI 1M long-context tier shared by tiered Anthropic/Google models. */
const BRANDED_1M_TIER: StaticCopilotModelFallback = {
	contextWindow: 200_000,
	contextWindowOptions: [200_000, 1_000_000],
	maxInputTokens: 936_000,
	maxTokens: 64_000,
};

const STATIC_COPILOT_MODEL_FALLBACKS: ReadonlyMap<string, StaticCopilotModelFallback> = new Map<string, StaticCopilotModelFallback>([
	// OpenAI: bundled metadata claims a 400k base window; CAPI's default tier is
	// 272k, with a 1.05M long tier (922k input cap) on gpt-5.5/gpt-5.4.
	["gpt-5.5", OPENAI_LONG_TIER],
	["gpt-5.4", OPENAI_LONG_TIER],
	["gpt-5.4-mini", { contextWindow: 272_000, maxTokens: 128_000 }],
	["gpt-5.3-codex", { contextWindow: 272_000, maxTokens: 128_000 }],
	// Bundled metadata claims 264k; CAPI enforces 128k.
	["gpt-5-mini", { contextWindow: 128_000, maxTokens: 64_000 }],
	["gpt-4.1", { contextWindow: 128_000, maxTokens: 16_384 }],
	// Anthropic: CAPI's default tier is 200k with a 1M long tier (936k input
	// cap). Bundled claude-opus-4.6/claude-sonnet-4.6 wrongly claim the branded
	// 1M window as the base tier, and bundled opus-4.6/4.7 output caps are half
	// of CAPI's real 64k.
	["claude-opus-4.6", BRANDED_1M_TIER],
	["claude-opus-4.7", BRANDED_1M_TIER],
	["claude-opus-4.8", BRANDED_1M_TIER],
	["claude-sonnet-4.6", BRANDED_1M_TIER],
	// Bundled metadata claims 200k; CAPI enforces smaller default windows, with
	// no long tier.
	["claude-haiku-4.5", { contextWindow: 136_000, maxTokens: 64_000 }],
	["claude-sonnet-4.5", { contextWindow: 168_000, maxTokens: 32_000 }],
	// Google: the pro/3.5 models share the branded 1M tier structure.
	["gemini-3.1-pro-preview", BRANDED_1M_TIER],
	["gemini-3.5-flash", BRANDED_1M_TIER],
	["gemini-2.5-pro", { contextWindow: 128_000, maxTokens: 64_000 }],
	["gemini-3-flash-preview", { contextWindow: 128_000, maxTokens: 64_000 }],
]);

/**
 * Look up the static CAPI-derived limits for a bundled Copilot model. Returns
 * undefined for models with no CAPI catalog presence to snapshot.
 */
export function getStaticCopilotModelFallback(modelId: string): StaticCopilotModelFallback | undefined {
	return STATIC_COPILOT_MODEL_FALLBACKS.get(modelId);
}
