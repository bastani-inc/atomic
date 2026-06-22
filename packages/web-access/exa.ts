import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@bastani/atomic";
import { EXA_USAGE_PATH, findReadableConfigPath } from "./config-paths.ts";
import { activityMonitor } from "./activity.js";
import { searchWithExaMcp, callExaMcp } from "./exa-mcp.js";
import type { ExtractedContent } from "./extract.js";
import type { SearchOptions, SearchResponse } from "./perplexity.js";

const EXA_ANSWER_URL = "https://api.exa.ai/answer";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const CONFIG_PATH = findReadableConfigPath();
const USAGE_PATH = EXA_USAGE_PATH;

const MONTHLY_LIMIT = 1000;
const WARNING_THRESHOLD = 800;

interface WebSearchConfig {
	exaApiKey?: unknown;
}

interface ExaUsage {
	month: string;
	count: number;
}

interface ExaAnswerResponse {
	answer?: string;
	citations?: Array<{ url?: string; title?: string; text?: string; publishedDate?: string }>;
}

interface ExaSearchResponse {
	results?: Array<{
		title?: string;
		url?: string;
		publishedDate?: string;
		author?: string;
		text?: string;
		highlights?: unknown;
		highlightScores?: number[];
	}>;
}

export type ExaSearchResult = SearchResponse | { exhausted: true } | null;

export interface ExaSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

let cachedConfig: WebSearchConfig | null = null;
let warnedMonth: string | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function getApiKey(): string | null {
	return normalizeApiKey(process.env.EXA_API_KEY) ?? normalizeApiKey(loadConfig().exaApiKey);
}

function getCurrentMonth(): string {
	return new Date().toISOString().slice(0, 7);
}

function normalizeUsage(raw: unknown): ExaUsage {
	const month = getCurrentMonth();
	if (!raw || typeof raw !== "object") return { month, count: 0 };
	const data = raw as { month?: unknown; count?: unknown };
	const parsedMonth = typeof data.month === "string" ? data.month : month;
	const parsedCount = typeof data.count === "number" && Number.isFinite(data.count) ? data.count : 0;
	if (parsedMonth !== month) return { month, count: 0 };
	return { month: parsedMonth, count: Math.max(0, Math.floor(parsedCount)) };
}

function readUsage(): ExaUsage {
	if (!existsSync(USAGE_PATH)) return { month: getCurrentMonth(), count: 0 };
	const raw = readFileSync(USAGE_PATH, "utf-8");
	try {
		return normalizeUsage(JSON.parse(raw));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${USAGE_PATH}: ${message}`);
	}
}

function writeUsage(usage: ExaUsage): void {
	const dir = join(homedir(), CONFIG_DIR_NAME);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2) + "\n");
}

function reserveRequestBudget(): { exhausted: true } | null {
	const usage = readUsage();

	if (usage.count >= MONTHLY_LIMIT) {
		return { exhausted: true };
	}

	const nextCount = usage.count + 1;
	if (nextCount >= WARNING_THRESHOLD && warnedMonth !== usage.month) {
		warnedMonth = usage.month;
		console.error(`Exa usage warning: ${nextCount}/${MONTHLY_LIMIT} monthly requests used.`);
	}

	writeUsage({ month: usage.month, count: nextCount });
	return null;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(60000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function recencyToStartDate(filter: string): string {
	const now = new Date();
	const offsets: Record<string, number> = {
		day: 1,
		week: 7,
		month: 30,
		year: 365,
	};
	const days = offsets[filter] ?? 0;
	return new Date(now.getTime() - days * 86400000).toISOString();
}

function mapDomainFilter(domainFilter: string[] | undefined): { includeDomains?: string[]; excludeDomains?: string[] } {
	if (!domainFilter?.length) return {};
	const includeDomains = domainFilter
		.filter(d => !d.startsWith("-") && d.trim().length > 0)
		.map(d => d.trim());
	const excludeDomains = domainFilter
		.filter(d => d.startsWith("-"))
		.map(d => d.slice(1).trim())
		.filter(Boolean);
	return {
		...(includeDomains.length ? { includeDomains } : {}),
		...(excludeDomains.length ? { excludeDomains } : {}),
	};
}

function normalizeHighlights(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function buildAnswerFromSearchResults(results: ExaSearchResponse["results"]): string {
	if (!results?.length) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		const highlights = normalizeHighlights(item.highlights);
		const content = highlights.length > 0
			? highlights.join(" ")
			: typeof item.text === "string" ? item.text.trim().slice(0, 1000) : "";
		if (!content) continue;
		const sourceTitle = item.title || `Source ${i + 1}`;
		parts.push(`${content}\nSource: ${sourceTitle} (${item.url})`);
	}
	return parts.join("\n\n");
}

function mapResults(results: ExaSearchResponse["results"] | ExaAnswerResponse["citations"]): SearchResponse["results"] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResponse["results"] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		mapped.push({
			title: item.title || `Source ${i + 1}`,
			url: item.url,
			snippet: "",
		});
	}
	return mapped;
}

function mapInlineContent(results: ExaSearchResponse["results"]): ExtractedContent[] {
	if (!results?.length) return [];
	return results
		.filter((r): r is NonNullable<ExaSearchResponse["results"]>[number] & { url: string; text: string } =>
			!!r?.url && typeof r.text === "string" && r.text.length > 0)
		.map(r => ({
			url: r.url,
			title: r.title || "",
			content: r.text,
			error: null,
		}));
}

export { callExaMcp };

export function isExaAvailable(): boolean {
	if (getApiKey()) {
		const usage = readUsage();
		return usage.count < MONTHLY_LIMIT;
	}
	return true;
}

export function hasExaApiKey(): boolean {
	return !!getApiKey();
}

export async function searchWithExa(query: string, options: ExaSearchOptions = {}): Promise<ExaSearchResult> {
	const apiKey = getApiKey();
	if (!apiKey) {
		return searchWithExaMcp(query, options);
	}

	const budget = reserveRequestBudget();
	if (budget) return budget;

	const useSearch = options.includeContent
		|| !!options.recencyFilter
		|| !!options.domainFilter?.length
		|| !!(options.numResults && options.numResults !== 5);

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		if (!useSearch) {
			const response = await fetch(EXA_ANSWER_URL, {
				method: "POST",
				headers: {
					"x-api-key": apiKey,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					query,
					text: true,
				}),
				signal: requestSignal(options.signal),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 300)}`);
			}

			const data = await response.json() as ExaAnswerResponse;
			activityMonitor.logComplete(activityId, response.status);
			return {
				answer: data.answer || "",
				results: mapResults(data.citations),
			};
		}

		const startDate = options.recencyFilter ? recencyToStartDate(options.recencyFilter) : null;
		const domainFilters = mapDomainFilter(options.domainFilter);
		const response = await fetch(EXA_SEARCH_URL, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query,
				type: "auto",
				numResults: options.numResults ?? 5,
				...domainFilters,
				...(startDate ? { startPublishedDate: startDate } : {}),
				contents: {
					text: options.includeContent ? true : { maxCharacters: 3000 },
					highlights: true,
				},
			}),
			signal: requestSignal(options.signal),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await response.json() as ExaSearchResponse;
		activityMonitor.logComplete(activityId, response.status);

		const mapped: SearchResponse = {
			answer: buildAnswerFromSearchResults(data.results),
			results: mapResults(data.results),
		};
		if (options.includeContent) {
			const inlineContent = mapInlineContent(data.results);
			if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
		}
		return mapped;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}
