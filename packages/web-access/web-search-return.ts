import type { ExtensionAPI } from "@bastani/atomic";
import type { ExtractedContent } from "./extract.js";
import {
	duplicateQuerySet,
	formatQueryHeader,
	formatSearchSummary,
	hasFullInlineCoverage,
} from "./web-search-formatting.js";
import { generateId, storeResult, type QueryResultData, type StoredSearchData } from "./storage.js";
import type { SummaryMeta } from "./summary-review.js";
import type { CuratorWorkflow } from "./web-search-config.js";

export interface SearchReturnOptions {
	queryList: string[];
	results: QueryResultData[];
	urls: string[];
	includeContent: boolean;
	inlineContent?: ExtractedContent[];
	curated?: boolean;
	curatedFrom?: number;
	workflow?: CuratorWorkflow;
	approvedSummary?: string;
	summaryMeta?: SummaryMeta;
}

export interface SearchReturnPayload {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
}

export type SearchReturnBuilder = (opts: SearchReturnOptions) => SearchReturnPayload;

interface BuildSearchReturnDeps {
	pi: ExtensionAPI;
	startBackgroundFetch(urls: string[]): string | null;
}

function storeAndPublishSearch(pi: ExtensionAPI, results: QueryResultData[]): string {
	const id = generateId();
	const data: StoredSearchData = {
		id, type: "search", timestamp: Date.now(), queries: results,
	};
	storeResult(id, data);
	pi.appendEntry("web-search-results", data);
	return id;
}

export function buildSearchReturn(opts: SearchReturnOptions, deps: BuildSearchReturnDeps): SearchReturnPayload {
	const sc = opts.results.filter(r => !r.error).length;
	const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);
	const allFailed = opts.results.length > 0 && sc === 0;

	const hasApprovedSummary = typeof opts.approvedSummary === "string" && opts.approvedSummary.trim().length > 0;
	let output = "";
	if (hasApprovedSummary) {
		output = opts.approvedSummary!.trim();
	} else {
		if (opts.curated) {
			output += "[These results were manually curated by the user in the browser. Use them as-is — do not re-search or discard.]\n\n";
		}
		const duplicateQueries = opts.curated ? duplicateQuerySet(opts.results) : new Set<string>();
		for (const { query, answer, results, error, provider } of opts.results) {
			if (opts.queryList.length > 1) {
				output += opts.curated
					? formatQueryHeader(query, provider, duplicateQueries)
					: `## Query: "${query}"\n\n`;
			}
			if (error) output += `Error: ${error}\n\n`;
			else if (results.length === 0) output += "No results found.\n\n";
			else output += formatSearchSummary(results, answer) + "\n\n";
		}
	}

	const hasInlineReady = hasFullInlineCoverage(opts.urls, opts.inlineContent);
	let fetchId: string | null = null;
	if (hasInlineReady && opts.inlineContent) {
		fetchId = generateId();
		const data: StoredSearchData = {
			id: fetchId,
			type: "fetch",
			timestamp: Date.now(),
			urls: opts.inlineContent,
		};
		storeResult(fetchId, data);
		deps.pi.appendEntry("web-search-results", data);
		if (!hasApprovedSummary) {
			output += `---\nFull content for ${opts.inlineContent.length} sources available [${fetchId}].`;
		}
	} else if (opts.includeContent) {
		fetchId = deps.startBackgroundFetch(opts.urls);
		if (fetchId && !hasApprovedSummary) {
			output += `---\nContent fetching in background [${fetchId}]. Will notify when ready.`;
		}
	}

	const searchId = storeAndPublishSearch(deps.pi, opts.results);
	const isBackgroundFetch = fetchId !== null && !hasInlineReady;

	return {
		content: [{ type: "text", text: output.trim() }],
		details: {
			...(allFailed ? {
				outcome: "all_failed",
				stage: "provider_execution",
				failedQueries: opts.results.length,
				error: `All ${opts.results.length} search provider request(s) failed`,
			} : {}),
			queries: opts.queryList,
			queryCount: opts.queryList.length,
			successfulQueries: sc,
			totalResults: tr,
			includeContent: opts.includeContent,
			fetchId,
			fetchUrls: isBackgroundFetch ? opts.urls : undefined,
			searchId,
			...(opts.curated ? {
				curated: true,
				curatedFrom: opts.curatedFrom,
				curatedQueries: opts.results.map(r => ({
					query: r.query,
					provider: r.provider || null,
					answer: r.answer || null,
					sources: r.results.map(s => ({ title: s.title, url: s.url })),
					error: r.error,
				})),
			} : {}),
			...((opts.workflow && hasApprovedSummary)
				? {
					summary: {
						text: opts.approvedSummary!.trim(),
						workflow: opts.workflow,
						model: opts.summaryMeta?.model ?? null,
						durationMs: opts.summaryMeta?.durationMs ?? 0,
						tokenEstimate: opts.summaryMeta?.tokenEstimate ?? 0,
						fallbackUsed: opts.summaryMeta?.fallbackUsed === true,
						fallbackReason: opts.summaryMeta?.fallbackReason,
						edited: opts.summaryMeta?.edited === true,
					},
				}
				: {}),
		},
	};
}
