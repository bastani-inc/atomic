import { type CacheWasteTotals, cacheWasteScan, type ModelPriceSource } from "./cache-stats.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";
import { readAhead } from "./storage/session/history-pages.js";
import { type OversizedSessionEntry, SESSION_HISTORY_SCAN_ENTRIES } from "./storage/session/types.js";
import { type UsageCostBreakdownEntry, usageCostBreakdown } from "./usage-totals.ts";

/**
 * What `/session` lists beside a session's totals, over every entry the session stored, on every branch, in the order
 * they were stored: the cost of each model, the prompt and cache-read tokens of the assistant replies behind the cache
 * hit rate, and the extra cost of prompt-cache misses.
 */
export interface SessionUsageDetails {
	readonly breakdown: readonly UsageCostBreakdownEntry[];
	readonly promptTokens: number;
	readonly cacheRead: number;
	readonly cacheWaste: CacheWasteTotals;
}

function usageDetails(models: ModelPriceSource) {
	const breakdown = usageCostBreakdown();
	const waste = cacheWasteScan(models);
	let promptTokens = 0;
	let cacheRead = 0;
	return {
		add(entry: SessionEntry): void {
			breakdown.add(entry);
			waste.add(entry);
			if (entry.type === "message" && entry.message.role === "assistant") {
				const { usage } = entry.message;
				promptTokens += usage.input + usage.cacheRead + usage.cacheWrite;
				cacheRead += usage.cacheRead;
			}
		},
		result: (): SessionUsageDetails => ({
			breakdown: breakdown.result(),
			promptTokens,
			cacheRead,
			cacheWaste: { ...waste.totals },
		}),
	};
}

/** The details of `entries`, every entry of a session in the order it stored them. */
export function sessionUsageDetails(entries: Iterable<SessionEntry>, models: ModelPriceSource): SessionUsageDetails {
	const details = usageDetails(models);
	for (const entry of entries) details.add(entry);
	return details.result();
}

type HistoryCut = ReturnType<SessionManager["captureArchive"]>;

async function oversizedEntry(cut: HistoryCut, item: OversizedSessionEntry, signal?: AbortSignal) {
	const chunks: Uint8Array[] = [];
	for await (const chunk of cut.chunks(item, signal)) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as SessionEntry;
}

/**
 * The details of the session `manager` has open, as it stands when the call starts, for a manager that holds only its
 * current context window. The entries it holds come from memory and the others from its store, a page at a time; each
 * page is dropped once counted, so the manager holds no more than before (#5554).
 */
export async function readSessionUsageDetails(
	manager: Pick<SessionManager, "captureArchive">,
	models: ModelPriceSource,
	signal?: AbortSignal,
): Promise<SessionUsageDetails> {
	const cut = manager.captureArchive();
	const details = usageDetails(models);
	for await (const { items } of readAhead(cut.pages({ pageEntries: SESSION_HISTORY_SCAN_ENTRIES, signal })))
		for (const item of items)
			details.add(
				cut.held.get(item.seq) ?? ("entry" in item ? item.entry : await oversizedEntry(cut, item, signal)),
			);
	return details.result();
}
