import type { Api, Model } from "@bastani/atomic-ai";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
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
	/** Tool definitions changed after the previous request, as an update that redefines a tool does. */
	toolsChanged: boolean;
	/** A subagent's leading prompt was sent again in full after the previous request. */
	promptRestarted: boolean;
	/** The request used another thinking level than the previous one on the same model. */
	thinkingLevelChanged: boolean;
	/** The request had to send a smaller thinking budget than the previous one, or none, to fit the model's context window. */
	contextNearLimit: boolean;
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
export interface PreviousRequest {
	promptTokens: number;
	provider: string;
	model: string;
	timestamp: number;
	reportedCache: boolean;
	thinkingLevel?: string;
	/** Thinking budget the request sent, for a model that thinks within a fixed budget. */
	thinkingBudgetTokens?: number;
	/** A later system message changed the tool definitions. */
	toolsChanged?: boolean;
	/** A later system message sent a subagent's leading prompt again in full. */
	promptRestarted?: boolean;
}

export function describeCacheMissCause(miss: CacheMiss): string {
	if (miss.modelChanged) return " after model switch";
	if (miss.cacheExpired) return " after cache TTL expiry";
	if (miss.promptRestarted) return " after the subagent's prompt was sent again in full";
	if (miss.thinkingLevelChanged) return " after thinking level change";
	if (miss.toolsChanged) return " after tool definitions changed";
	return miss.contextNearLimit ? " with the context near the model's limit" : "";
}

function requestThinkingLevel(message: AssistantMessage): string | undefined {
	return (message as AssistantMessage & { thinkingLevel?: string }).thinkingLevel;
}

export function cacheMissAfter(
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
	const modelChanged = message.provider !== prev.provider || message.model !== prev.model;
	return {
		missedTokens,
		missedCost,
		...(paidRate > 0 ? { rebilledCost: missedTokens * paidRate } : {}),
		...(reportedRequestCost !== undefined ? { reportedRequestCost } : {}),
		idleMs,
		modelChanged,
		cacheExpired: ttlMs !== undefined && idleMs >= ttlMs,
		toolsChanged: prev.toolsChanged === true,
		promptRestarted: prev.promptRestarted === true,
		thinkingLevelChanged:
			!modelChanged &&
			prev.thinkingLevel !== undefined &&
			requestThinkingLevel(message) !== undefined &&
			requestThinkingLevel(message) !== prev.thinkingLevel,
		// A lower budget, or none at all when not even the smallest one fit, on the same thinking level.
		contextNearLimit:
			!modelChanged &&
			prev.thinkingBudgetTokens !== undefined &&
			(message.thinkingBudgetTokens ?? 0) < prev.thinkingBudgetTokens &&
			requestThinkingLevel(message) === prev.thinkingLevel,
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
				...(requestThinkingLevel(message) === undefined ? {} : { thinkingLevel: requestThinkingLevel(message) }),
				...(message.thinkingBudgetTokens === undefined
					? {}
					: { thinkingBudgetTokens: message.thinkingBudgetTokens }),
			}
		: undefined;
}

/** Advance the predecessor used by the next reply, without inspecting message bodies or looking up model prices. */
export function advanceCacheHistory(
	prev: PreviousRequest | undefined,
	entry: SessionEntry,
): PreviousRequest | undefined {
	if (entry.type === "compaction" || entry.type === "branch_summary") return undefined;
	if (entry.type === "usage" && entry.kind === "cache_warm") {
		const promptTokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
		if (promptTokens > 0)
			return {
				promptTokens,
				provider: entry.provider,
				model: entry.model,
				timestamp: Date.parse(entry.timestamp),
				reportedCache: true,
			};
	} else if (entry.type === "message" && entry.message.role === "assistant") {
		return previous(entry.message, prev?.reportedCache ?? false) ?? prev;
	} else if (prev && entry.type === "message" && entry.message.role === "system") {
		const message = entry.message;
		const toolsChanged = (message.toolsAdded?.length ?? 0) > 0 || (message.toolsRemoved?.length ?? 0) > 0;
		const promptRestarted =
			(message as { transformedPrompt?: { head?: unknown } }).transformedPrompt?.head !== undefined;
		if ((toolsChanged && !prev.toolsChanged) || (promptRestarted && !prev.promptRestarted))
			return {
				...prev,
				...(toolsChanged ? { toolsChanged: true } : {}),
				...(promptRestarted ? { promptRestarted: true } : {}),
			};
	}
	return prev;
}

/**
 * The prompt-cache misses of entries added in the order they were stored, one at a time, so a reader can add entries
 * from pages it does not keep. `add` returns the miss an assistant reply had, if any.
 */
export function cacheWasteScan(models: ModelPriceSource) {
	let prev: PreviousRequest | undefined;
	const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0, unpricedCount: 0 };
	return {
		totals,
		get prev() {
			return prev;
		},
		add(entry: SessionEntry): CacheMiss | undefined {
			if (entry.type !== "message" || entry.message.role !== "assistant") {
				prev = advanceCacheHistory(prev, entry);
				return undefined;
			}
			const miss = cacheMissAfter(prev, entry.message, models);
			if (miss) {
				totals.missedTokens += miss.missedTokens;
				totals.missedCost += miss.missedCost;
				totals.missCount++;
				if (miss.rebilledCost === undefined) totals.unpricedCount++;
			}
			prev = previous(entry.message, prev?.reportedCache ?? false) ?? prev;
			return miss;
		},
	};
}

function scan(entries: SessionEntry[], models: ModelPriceSource, beforeId?: string) {
	const scanner = cacheWasteScan(models);
	const misses = new Map<AssistantMessage, CacheMiss>();
	for (const entry of entries) {
		if (beforeId !== undefined && entry.id === beforeId) break;
		const miss = scanner.add(entry);
		if (miss && entry.type === "message") misses.set(entry.message as AssistantMessage, miss);
	}
	return { prev: scanner.prev, totals: scanner.totals, misses };
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
	beforeId?: string,
): CacheMiss | undefined {
	return cacheMissAfter(scan(entries, models, beforeId).prev, message, models);
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

/** The session stats value for cache waste: the total extra cost over cache hits. */
export function formatCacheWaste(totals: CacheWasteTotals): string {
	const misses = `${totals.missCount} ${totals.missCount === 1 ? "miss" : "misses"}`;
	if (totals.unpricedCount === totals.missCount) return `unknown (${misses} without pricing)`;
	const unpriced = totals.unpricedCount > 0 ? `, ${totals.unpricedCount} without pricing` : "";
	return `${formatCacheCost(totals.missedCost, 4)} (${misses}${unpriced})`;
}
