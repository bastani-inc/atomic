import type { Api, Model } from "@bastani/pi-ai";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import {
	CACHE_PREFIX_CUSTOM_TYPE,
	type CachePrefixFingerprint,
	describeCachePrefixDifference,
	isCachePrefixFingerprint,
	reconstructMessageHashes,
} from "./cache-prefix-fingerprint.ts";
import { getPromptCacheTtlMs } from "./cache-warmer.ts";
import type { SessionEntry } from "./session-manager.ts";

const MISS_TOKEN_THRESHOLD = 20_000;
const MISS_COST_THRESHOLD = 0.1;

export interface CacheMiss {
	missedTokens: number;
	missedCost: number;
	idleMs: number;
	modelChanged: boolean;
	cacheExpired: boolean;
	/**
	 * First differing request segment since the previous request, e.g. "tool list
	 * changed: +mcp". Undefined when no cache-prefix fingerprint is available for
	 * this request (legacy sessions, or a stale/partial view) — callers must not
	 * treat a missing attribution as "prefix unchanged".
	 */
	attribution: string | undefined;
}
export interface CacheWasteTotals {
	missedTokens: number;
	missedCost: number;
	missCount: number;
}
export interface ModelPriceSource {
	getModel(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
	getPromptCacheTtlMs?(provider: string, modelId: string): number | undefined;
}
export function createCacheMissModelSource(runtime: {
	getModel(provider: string, modelId: string): Model<Api> | undefined;
}): ModelPriceSource {
	return {
		getModel: (provider, modelId) => runtime.getModel(provider, modelId),
		getPromptCacheTtlMs: (provider, modelId) => {
			const model = runtime.getModel(provider, modelId);
			return model ? getPromptCacheTtlMs(model, undefined) : undefined;
		},
	};
}
interface PreviousRequest {
	promptTokens: number;
	provider: string;
	model: string;
	timestamp: number;
	reportedCache: boolean;
}

export function describeCacheMissCause(miss: CacheMiss): string {
	const known = miss.modelChanged ? " after model switch" : miss.cacheExpired ? " after cache TTL expiry" : "";
	return miss.attribution === undefined ? known : `${known} (${miss.attribution})`;
}

function detect(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
	attribution: string | undefined,
): CacheMiss | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache))
		return undefined;
	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	if (missedTokens <= 0) return undefined;
	const paidTokens = usage.input + usage.cacheWrite;
	const paidRate = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	const readRate =
		usage.cacheRead > 0
			? usage.cost.cacheRead / usage.cacheRead
			: (models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;
	const missedCost = missedTokens * Math.max(0, paidRate - readRate);
	if (missedTokens < MISS_TOKEN_THRESHOLD && missedCost < MISS_COST_THRESHOLD) return undefined;
	const idleMs = Math.max(0, message.timestamp - prev.timestamp);
	const ttlMs = models.getPromptCacheTtlMs?.(prev.provider, prev.model);
	return {
		missedTokens,
		missedCost,
		idleMs,
		modelChanged: message.provider !== prev.provider || message.model !== prev.model,
		cacheExpired: ttlMs !== undefined && idleMs >= ttlMs,
		attribution,
	};
}

function previous(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0
		? {
				promptTokens,
				provider: message.provider,
				model: message.model,
				timestamp: message.timestamp,
				reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
			}
		: undefined;
}

function scan(entries: SessionEntry[], models: ModelPriceSource) {
	let prev: PreviousRequest | undefined;
	let lastCachePrefix: CachePrefixFingerprint | undefined;
	let lastMessageHashes: readonly string[] = [];
	let pendingAttribution: string | undefined;
	let sawCachePrefixEntry = false;
	let compactedSinceLastCachePrefix = false;
	const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
	const misses = new Map<AssistantMessage, CacheMiss>();
	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			entry.customType === CACHE_PREFIX_CUSTOM_TYPE &&
			isCachePrefixFingerprint(entry.data)
		) {
			const label = describeCachePrefixDifference(lastCachePrefix, lastMessageHashes, entry.data);
			pendingAttribution = compactedSinceLastCachePrefix ? `history compacted (${label})` : label;
			// entry.data's own delta was computed against an empty baseline right after
			// the boundary (see sdk.ts), so this naturally drops lastMessageHashes'
			// pre-boundary content instead of carrying it forward.
			lastMessageHashes = reconstructMessageHashes(entry.data, lastMessageHashes);
			lastCachePrefix = entry.data;
			compactedSinceLastCachePrefix = false;
			sawCachePrefixEntry = true;
			continue;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			prev = undefined;
			compactedSinceLastCachePrefix = true;
			continue;
		}
		if (entry.type === "usage" && entry.kind === "cache_warm") {
			const promptTokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
			if (promptTokens > 0)
				prev = {
					promptTokens,
					provider: entry.provider,
					model: entry.model,
					timestamp: Date.parse(entry.timestamp),
					reportedCache: true,
				};
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const attribution = sawCachePrefixEntry ? pendingAttribution : undefined;
		pendingAttribution = undefined;
		sawCachePrefixEntry = false;
		const miss = detect(prev, entry.message, models, attribution);
		if (miss) {
			totals.missedTokens += miss.missedTokens;
			totals.missedCost += miss.missedCost;
			totals.missCount++;
			misses.set(entry.message, miss);
		}
		prev = previous(entry.message, prev?.reportedCache ?? false) ?? prev;
	}
	return { prev, totals, misses, pendingAttribution, sawCachePrefixEntry };
}

export function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals {
	return scan(entries, models).totals;
}
export function collectCacheMisses(
	entries: SessionEntry[],
	models: ModelPriceSource,
): Map<AssistantMessage, CacheMiss> {
	return scan(entries, models).misses;
}
export function detectCacheMiss(
	entries: SessionEntry[],
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	const scanned = scan(entries, models);
	return detect(scanned.prev, message, models, scanned.sawCachePrefixEntry ? scanned.pendingAttribution : undefined);
}
