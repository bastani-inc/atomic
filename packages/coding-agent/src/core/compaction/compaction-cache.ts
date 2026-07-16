import type { Api, Model, Usage } from "@earendil-works/pi-ai/compat";
import type { CompactionCacheTelemetry } from "./compaction-types.js";

/**
 * Provider-specific prompt-cache shaping for the compaction request. The
 * compaction call reuses the exact active-request prefix (tools + system +
 * messages) and appends the compaction instruction after the cache breakpoint.
 * This module adds an OPTIONAL explicit breakpoint at the final old-conversation
 * block so the cached prefix is marked precisely, and normalizes cache-read/
 * write telemetry from the provider response.
 *
 * Wire formats (verified against provider docs):
 * - Anthropic: `cache_control: { type: "ephemeral" }` on a content block; max 4
 *   breakpoints per request; 20-block lookback.
 * - OpenAI GPT-5.6+: `prompt_cache_breakpoint: { mode: "explicit" }` on a
 *   cacheable content block; stable `prompt_cache_key` enables reliable matching.
 *   Older OpenAI models reject the field and use automatic caching only.
 */

/** Responses API cacheable content-block types (marker rejected elsewhere). */
const OPENAI_RESPONSES_CACHEABLE_BLOCKS = new Set(["input_text", "input_image", "input_file"]);
/** Chat Completions cacheable content-block types. */
const OPENAI_COMPLETIONS_CACHEABLE_BLOCKS = new Set(["text", "image_url", "input_audio", "file", "refusal"]);
const MAX_ANTHROPIC_BREAKPOINTS = 4;

type PayloadHook = (payload: unknown, model: Model<Api>) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize the provider-reported usage into gated cache telemetry. */
export function normalizeCompactionCacheTelemetry(
	model: Pick<Model<Api>, "provider" | "id">,
	usage: Pick<Usage, "cacheRead" | "cacheWrite"> | undefined,
): CompactionCacheTelemetry {
	const cacheReadTokens = Math.max(0, Math.trunc(usage?.cacheRead ?? 0));
	const cacheWriteTokens = Math.max(0, Math.trunc(usage?.cacheWrite ?? 0));
	return {
		cacheReadTokens,
		cacheWriteTokens,
		// Never claim a hit without nonzero provider-reported cache-read usage.
		cacheHit: cacheReadTokens > 0,
		provider: model.provider,
		model: model.id,
	};
}

export function isAnthropicCacheApi(api: Api): boolean {
	return api === "anthropic-messages";
}

export function isOpenAIResponsesCacheApi(api: Api): boolean {
	return api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses";
}

export function isOpenAICompletionsCacheApi(api: Api): boolean {
	return api === "openai-completions";
}

/** True for OpenAI GPT-5.6+ model families that accept explicit cache breakpoints. */
export function supportsOpenAIExplicitCacheBreakpoint(model: Pick<Model<Api>, "api" | "id">): boolean {
	if (!(isOpenAIResponsesCacheApi(model.api) || isOpenAICompletionsCacheApi(model.api))) return false;
	const match = /gpt-(\d+)(?:\.(\d+))?/i.exec(model.id);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = match[2] ? Number(match[2]) : 0;
	return major > 5 || (major === 5 && minor >= 6);
}

function lastArrayBlock(content: unknown): Record<string, unknown> | undefined {
	if (!Array.isArray(content) || content.length === 0) return undefined;
	const block = content[content.length - 1];
	return isRecord(block) ? block : undefined;
}

/** Count existing Anthropic cache breakpoints across system, tools, and messages. */
function countAnthropicBreakpoints(payload: Record<string, unknown>): number {
	let count = 0;
	const scan = (blocks: unknown): void => {
		if (!Array.isArray(blocks)) return;
		for (const block of blocks) if (isRecord(block) && block.cache_control) count++;
	};
	scan(payload.system);
	if (Array.isArray(payload.tools)) for (const tool of payload.tools) if (isRecord(tool) && tool.cache_control) count++;
	if (Array.isArray(payload.messages)) for (const message of payload.messages) if (isRecord(message)) scan(message.content);
	return count;
}

/**
 * Mark an explicit `cache_control` breakpoint on the final old-conversation
 * block (the last block of the message immediately preceding the appended
 * instruction), respecting the 4-breakpoint limit.
 */
function markAnthropicOldBlockBreakpoint(payload: Record<string, unknown>): void {
	const messages = payload.messages;
	if (!Array.isArray(messages) || messages.length < 2) return;
	const oldLast = messages[messages.length - 2];
	if (!isRecord(oldLast)) return;
	const block = lastArrayBlock(oldLast.content);
	if (!block || block.cache_control) return;
	if (countAnthropicBreakpoints(payload) >= MAX_ANTHROPIC_BREAKPOINTS) return;
	block.cache_control = { type: "ephemeral" };
}

/**
 * Mark an explicit `prompt_cache_breakpoint` on the final old-conversation block
 * of an OpenAI Responses/Completions payload. Only cacheable block types are
 * marked; anything else is left untouched (a marker on a non-cacheable block is
 * a 400).
 */
function markOpenAIOldBlockBreakpoint(payload: Record<string, unknown>, cacheable: ReadonlySet<string>, key: "input" | "messages"): void {
	const items = payload[key];
	if (!Array.isArray(items) || items.length < 2) return;
	const oldLast = items[items.length - 2];
	if (!isRecord(oldLast)) return;
	const block = lastArrayBlock(oldLast.content);
	if (!block || typeof block.type !== "string" || !cacheable.has(block.type)) return;
	if (block.prompt_cache_breakpoint) return;
	block.prompt_cache_breakpoint = { mode: "explicit" };
}

/**
 * Build the `onPayload` hook that adds an explicit cache breakpoint for the
 * compaction request. Returns `undefined` for custom/unsupported providers and
 * older OpenAI models, preserving their existing automatic-caching behavior.
 */
export function createCompactionCachePayloadHook(model: Model<Api>): PayloadHook | undefined {
	if (isAnthropicCacheApi(model.api)) {
		return (payload) => {
			if (isRecord(payload)) markAnthropicOldBlockBreakpoint(payload);
			return payload;
		};
	}
	if (supportsOpenAIExplicitCacheBreakpoint(model)) {
		const responses = isOpenAIResponsesCacheApi(model.api);
		const cacheable = responses ? OPENAI_RESPONSES_CACHEABLE_BLOCKS : OPENAI_COMPLETIONS_CACHEABLE_BLOCKS;
		const key: "input" | "messages" = responses ? "input" : "messages";
		return (payload) => {
			if (isRecord(payload)) markOpenAIOldBlockBreakpoint(payload, cacheable, key);
			return payload;
		};
	}
	return undefined;
}
