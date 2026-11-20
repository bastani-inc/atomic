import type { Usage } from "@bastani/atomic-ai/compat";
import type { SessionEntry } from "./session-manager.ts";
import type { SessionHistoryTotals } from "./storage/session/types.js";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

export function addHistoryUsageToTotals(
	totals: UsageTotals,
	history: SessionHistoryTotals | undefined,
	includeAuxiliary = false,
): void {
	if (history === undefined) return;
	for (const part of [
		history.assistant,
		history.toolResult,
		history.summaries,
		...(includeAuxiliary && history.auxiliary ? [history.auxiliary] : []),
	]) {
		totals.input += part.input;
		totals.output += part.output;
		totals.cacheRead += part.cacheRead;
		totals.cacheWrite += part.cacheWrite;
		totals.cost += part.cost;
	}
}

/** Sum nested/classifier usage without losing optional token splits. */
export function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
			// A sum is provider-reported only when every part is.
			totalFromProvider: first.cost.totalFromProvider === true && second.cost.totalFromProvider === true,
		},
	};
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

type MessageWithUsage = { role: "toolResult"; usage?: Usage };

export function getUsageCostBreakdown(entries: Iterable<SessionEntry>): UsageCostBreakdownEntry[] {
	const breakdown = usageCostBreakdown();
	for (const entry of entries) breakdown.add(entry);
	return breakdown.result();
}

/** The cost by model of entries added one at a time, so a reader can add entries from pages it does not keep. */
export function usageCostBreakdown() {
	const totalsByKey = new Map<string, UsageTotals>();
	const add = (entry: SessionEntry): void => {
		let key: string | undefined;
		let usage: Usage | undefined;
		if (entry.type === "usage") {
			key = `${entry.provider}/${entry.model}`;
			usage = entry.usage;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = entry.message.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			usage = (entry.message as MessageWithUsage).usage;
			key = usage ? "Tools/summaries" : undefined;
		} else if (
			(entry.type === "branch_summary" || entry.type === "session_summary" || entry.type === "compaction") &&
			entry.usage
		) {
			key = "Tools/summaries";
			usage = entry.usage;
		}
		if (!key || !usage) return;
		const totals = totalsByKey.get(key) ?? createUsageTotals();
		addUsageToTotals(totals, usage);
		totalsByKey.set(key, totals);
	};
	const result = (): UsageCostBreakdownEntry[] =>
		[...totalsByKey]
			.map(([key, totals]) => ({
				key,
				cost: totals.cost,
				tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
			}))
			.filter((entry) => entry.cost > 0 || entry.tokens > 0)
			.sort((a, b) => b.cost - a.cost);
	return { add, result };
}
