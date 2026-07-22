import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export const CACHE_TTL_MS = 5 * 60 * 1000;
const MISS_TOKEN_THRESHOLD = 20_000;
const MISS_COST_THRESHOLD = 0.1;

export interface CacheMiss {
	missedTokens: number;
	missedCost: number;
	idleMs: number;
	modelChanged: boolean;
}
export interface CacheWasteTotals { missedTokens: number; missedCost: number; missCount: number }
export interface ModelPriceSource {
	getModel(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}
interface PreviousRequest { promptTokens: number; modelKey: string; timestamp: number; reportedCache: boolean }

function detect(prev: PreviousRequest | undefined, message: AssistantMessage, models: ModelPriceSource): CacheMiss | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) return undefined;
	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	if (missedTokens <= 0) return undefined;
	const paidTokens = usage.input + usage.cacheWrite;
	const paidRate = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	const readRate = usage.cacheRead > 0
		? usage.cost.cacheRead / usage.cacheRead
		: (models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;
	const missedCost = missedTokens * Math.max(0, paidRate - readRate);
	if (missedTokens < MISS_TOKEN_THRESHOLD && missedCost < MISS_COST_THRESHOLD) return undefined;
	return {
		missedTokens,
		missedCost,
		idleMs: Math.max(0, message.timestamp - prev.timestamp),
		modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
	};
}

function previous(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0 ? {
		promptTokens,
		modelKey: `${message.provider}/${message.model}`,
		timestamp: message.timestamp,
		reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
	} : undefined;
}

function scan(entries: SessionEntry[], models: ModelPriceSource) {
	let prev: PreviousRequest | undefined;
	const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
	const misses = new Map<AssistantMessage, CacheMiss>();
	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") { prev = undefined; continue; }
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const miss = detect(prev, entry.message, models);
		if (miss) {
			totals.missedTokens += miss.missedTokens;
			totals.missedCost += miss.missedCost;
			totals.missCount++;
			misses.set(entry.message, miss);
		}
		prev = previous(entry.message, prev?.reportedCache ?? false) ?? prev;
	}
	return { prev, totals, misses };
}

export function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals {
	return scan(entries, models).totals;
}
export function collectCacheMisses(entries: SessionEntry[], models: ModelPriceSource): Map<AssistantMessage, CacheMiss> {
	return scan(entries, models).misses;
}
export function detectCacheMiss(entries: SessionEntry[], message: AssistantMessage, models: ModelPriceSource): CacheMiss | undefined {
	return detect(scan(entries, models).prev, message, models);
}
