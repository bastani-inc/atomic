import type { ExtractedContent } from "./extract.js";
import type { SearchResult } from "./perplexity.js";
import type { QueryResultData } from "./storage.js";
import type { SummaryMeta } from "./summary-review.js";

export const MAX_INLINE_CONTENT = 30000;

export function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
	return results.map(({ thumbnail, frames, ...rest }) => rest);
}

export function formatSearchSummary(results: SearchResult[], answer: string): string {
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

export function duplicateQuerySet(results: QueryResultData[]): Set<string> {
	const counts = new Map<string, number>();
	for (const result of results) {
		counts.set(result.query, (counts.get(result.query) ?? 0) + 1);
	}
	const duplicates = new Set<string>();
	for (const [query, count] of counts) {
		if (count > 1) duplicates.add(query);
	}
	return duplicates;
}

export function formatQueryHeader(query: string, provider: string | undefined, duplicateQueries: Set<string>): string {
	const suffix = duplicateQueries.has(query) && provider ? ` (${provider})` : "";
	return `## Query: "${query}"${suffix}\n\n`;
}

export function hasFullInlineCoverage(urls: string[], inlineContent: ExtractedContent[] | undefined): boolean {
	if (!inlineContent || inlineContent.length === 0) return false;
	const coveredUrls = new Set(inlineContent.map(c => c.url));
	return urls.every(url => coveredUrls.has(url));
}

export function formatFullResults(queryData: QueryResultData): string {
	let output = `## Results for: "${queryData.query}"\n\n`;
	if (queryData.answer) {
		output += `${queryData.answer}\n\n---\n\n`;
	}
	for (const r of queryData.results) {
		output += `### ${r.title}\n${r.url}\n\n`;
	}
	return output;
}

export function normalizeSummaryMeta(meta: SummaryMeta | undefined, summaryText: string): SummaryMeta {
	const normalizedText = summaryText.trim();
	if (!meta) {
		return {
			model: null,
			durationMs: 0,
			tokenEstimate: normalizedText.length > 0 ? Math.max(1, Math.ceil(normalizedText.length / 4)) : 0,
			fallbackUsed: false,
			edited: false,
		};
	}

	return {
		model: meta.model,
		durationMs: Number.isFinite(meta.durationMs) && meta.durationMs >= 0 ? meta.durationMs : 0,
		tokenEstimate: Number.isFinite(meta.tokenEstimate) && meta.tokenEstimate >= 0
			? meta.tokenEstimate
			: (normalizedText.length > 0 ? Math.max(1, Math.ceil(normalizedText.length / 4)) : 0),
		fallbackUsed: meta.fallbackUsed === true,
		fallbackReason: meta.fallbackReason,
		edited: meta.edited === true,
	};
}

export function buildCurationCancelledReturn(reason: "user" | "stale") {
	const message = `Search curation cancelled (${reason}).`;
	return {
		content: [{ type: "text", text: message }],
		details: {
			error: message,
			cancelled: true,
			cancelReason: reason,
		},
	};
}

export function filterByQueryIndices(selectedQueryIndices: number[], results: Map<number, QueryResultData>) {
	const filteredResults: QueryResultData[] = [];
	const filteredUrls: string[] = [];
	for (const qi of selectedQueryIndices) {
		const r = results.get(qi);
		if (r) {
			filteredResults.push(r);
			for (const res of r.results) {
				if (!filteredUrls.includes(res.url)) filteredUrls.push(res.url);
			}
		}
	}
	return { results: filteredResults, urls: filteredUrls };
}

export function collectAllResultsAndUrls(resultsByIndex: Map<number, QueryResultData>) {
	const results = [...resultsByIndex.values()];
	const urls: string[] = [];
	for (const result of results) {
		for (const source of result.results) {
			if (!urls.includes(source.url)) urls.push(source.url);
		}
	}
	return { results, urls };
}

export function extractDomain(url: string): string {
	try { return new URL(url).hostname; }
	catch { return url; }
}
