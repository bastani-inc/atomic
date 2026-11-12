import type { Api, Model } from "@bastani/pi-ai";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { getPromptCacheTtlMs } from "./cache-warmer.ts";
import type { SessionEntry } from "./session-manager.ts";

const MISS_TOKEN_THRESHOLD = 20_000;
const MISS_COST_THRESHOLD = 0.1;

export interface CacheMiss {
	missedTokens: number;
	/** Extra cost over a cache hit: missed tokens at the uncached rate minus the cache-read rate. */
	missedCost: number;
	/** Cost of the missed tokens at the uncached rate; undefined when the request has no pricing. */
	rebilledCost?: number;
	/** Provider-reported billed total of the whole request, when the provider supplied one. */
	reportedRequestCost?: number;
	idleMs: number;
	modelChanged: boolean;
	cacheExpired: boolean;
}
export interface CacheWasteTotals {
	missedTokens: number;
	missedCost: number;
	missCount: number;
	/** Misses without pricing; their extra cost is unknown and absent from `missedCost`. */
	unpricedCount: number;
}
export interface ModelPriceSource {
	getModel(provider: string, modelId: string): { cost: { cacheRead: number; input?: number } } | undefined;
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
	if (miss.modelChanged) return " after model switch";
	return miss.cacheExpired ? " after cache TTL expiry" : "";
}

function detect(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
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
	const reportedRequestCost = usage.cost.totalFromProvider && usage.cost.total > 0 ? usage.cost.total : undefined;
	const idleMs = Math.max(0, message.timestamp - prev.timestamp);
	const ttlMs = models.getPromptCacheTtlMs?.(prev.provider, prev.model);
	return {
		missedTokens,
		missedCost,
		...(paidRate > 0 ? { rebilledCost: missedTokens * paidRate } : {}),
		...(reportedRequestCost !== undefined ? { reportedRequestCost } : {}),
		idleMs,
		modelChanged: message.provider !== prev.provider || message.model !== prev.model,
		cacheExpired: ttlMs !== undefined && idleMs >= ttlMs,
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
	const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0, unpricedCount: 0 };
	const misses = new Map<AssistantMessage, CacheMiss>();
	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			prev = undefined;
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
		const miss = detect(prev, entry.message, models);
		if (miss) {
			totals.missedTokens += miss.missedTokens;
			totals.missedCost += miss.missedCost;
			totals.missCount++;
			if (miss.rebilledCost === undefined) totals.unpricedCount++;
			misses.set(entry.message, miss);
		}
		prev = previous(entry.message, prev?.reportedCache ?? false) ?? prev;
	}
	return { prev, totals, misses };
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
	return detect(scan(entries, models).prev, message, models);
}

/** The prompt-cache miss a compaction commit causes on the next request: the cached prefix it rewrites. */
export interface CompactionCacheMiss {
	expectedMissedTokens: number;
	/** Extra cost over a cache hit. */
	expectedMissedCost: number;
	/** Cost of the missed tokens at the uncached rate; undefined when there is no pricing. */
	expectedRebilledCost?: number;
}

/**
 * Estimate the cache miss of committing a compaction boundary: the next request re-bills its prompt
 * (at most the previously cached prompt) at the uncached rate. Undefined when the last request
 * reported no prompt caching.
 */
export function estimateCompactionCacheMiss(
	entries: SessionEntry[],
	promptTokensAfter: number,
	models: ModelPriceSource,
): CompactionCacheMiss | undefined {
	const prev = scan(entries, models).prev;
	if (!prev?.reportedCache) return undefined;
	const expectedMissedTokens = Math.max(0, Math.min(prev.promptTokens, promptTokensAfter));
	if (expectedMissedTokens === 0) return undefined;
	let last: AssistantMessage | undefined;
	for (let index = entries.length - 1; index >= 0 && !last; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "assistant") last = entry.message;
	}
	const usage = last?.usage;
	const model = models.getModel(prev.provider, prev.model);
	const paidTokens = usage ? usage.input + usage.cacheWrite : 0;
	const paidRate =
		usage && paidTokens > 0
			? (usage.cost.input + usage.cost.cacheWrite) / paidTokens
			: (model?.cost.input ?? 0) / 1_000_000;
	const readRate =
		usage && usage.cacheRead > 0 ? usage.cost.cacheRead / usage.cacheRead : (model?.cost.cacheRead ?? 0) / 1_000_000;
	return {
		expectedMissedTokens,
		expectedMissedCost: expectedMissedTokens * Math.max(0, paidRate - readRate),
		...(paidRate > 0 ? { expectedRebilledCost: expectedMissedTokens * paidRate } : {}),
	};
}

/**
 * Format a cache-miss dollar amount. A nonzero amount too small for `decimals` renders as an upper
 * bound (`<$0.001`) rather than a definitive zero.
 */
export function formatCacheCost(amount: number, decimals = 3): string {
	const quantum = 10 ** -decimals;
	return amount > 0 && amount < quantum / 2 ? `<$${quantum.toFixed(decimals)}` : `$${amount.toFixed(decimals)}`;
}

function describeMissCost(rebilledCost: number | undefined, extraCost: number, reportedRequestCost?: number): string {
	if (rebilledCost !== undefined)
		return `${formatCacheCost(rebilledCost)}, ${formatCacheCost(extraCost)} more than a cache hit`;
	return reportedRequestCost !== undefined
		? `provider billed ${formatCacheCost(reportedRequestCost)} for the request`
		: "cost unknown";
}

/** The notice for a detected prompt-cache miss, shared by the live and history renderings. */
export function formatCacheMissNotice(miss: CacheMiss): string {
	return `Prompt cache miss${describeCacheMissCause(miss)}: ${miss.missedTokens.toLocaleString()} tokens re-billed (${describeMissCost(miss.rebilledCost, miss.missedCost, miss.reportedRequestCost)})`;
}

/** The notice for the prompt-cache miss a committed background compaction causes. */
export function formatCompactionCacheMissNotice(miss: CompactionCacheMiss): string {
	return `Prompt cache miss expected after background compaction: ${miss.expectedMissedTokens.toLocaleString()} tokens re-billed (${describeMissCost(miss.expectedRebilledCost, miss.expectedMissedCost)})`;
}

/** The session stats value for cache waste: the total extra cost over cache hits. */
export function formatCacheWaste(totals: CacheWasteTotals): string {
	const misses = `${totals.missCount} ${totals.missCount === 1 ? "miss" : "misses"}`;
	if (totals.unpricedCount === totals.missCount) return `unknown (${misses} without pricing)`;
	const unpriced = totals.unpricedCount > 0 ? `, ${totals.unpricedCount} without pricing` : "";
	return `${formatCacheCost(totals.missedCost, 4)} (${misses}${unpriced})`;
}
