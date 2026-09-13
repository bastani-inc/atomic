import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.js";
import { findReadableConfigPath } from "./config-paths.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

const YOUCOM_API_URL = "https://ydc-index.io/v1/search";
const CONFIG_PATH = findReadableConfigPath();
const MAX_RESULTS = 20;

interface WebSearchConfig {
	youcomApiKey?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const content = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(content) as WebSearchConfig;
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

function getApiKey(): string {
	const config = loadConfig();
	const key = normalizeApiKey(process.env.YDC_API_KEY) ?? normalizeApiKey(config.youcomApiKey);
	if (!key) {
		throw new Error(
			"You.com API key not found. Either:\n" +
				`  1. Create ${CONFIG_PATH} with { "youcomApiKey": "your-key" }\n` +
				"  2. Set YDC_API_KEY environment variable\n" +
				"Get a key at https://you.com/platform/api-keys"
		);
	}
	return key;
}

function splitDomainFilter(domainFilter: string[] | undefined): { includes: string[]; excludes: string[] } {
	const includes: string[] = [];
	const excludes: string[] = [];
	for (const entry of domainFilter ?? []) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("-")) {
			const domain = trimmed.slice(1).trim();
			if (domain) excludes.push(domain.toLowerCase());
		} else {
			includes.push(trimmed.toLowerCase());
		}
	}
	return { includes, excludes };
}

function domainMatches(host: string, filter: string): boolean {
	const normalizedHost = host.toLowerCase();
	const normalizedFilter = filter.toLowerCase();
	return normalizedHost === normalizedFilter || normalizedHost.endsWith(`.${normalizedFilter}`);
}

/** Client-side enforcement of domainFilter on results (the API has no domain filter parameter). */
function applyDomainFilter(result: SearchResult, domainFilter: string[] | undefined): boolean {
	if (!domainFilter?.length) return true;
	const { includes, excludes } = splitDomainFilter(domainFilter);
	if (!includes.length && !excludes.length) return true;
	let host: string;
	try {
		host = new URL(result.url).hostname;
	} catch {
		// Unparseable URL cannot be proven to satisfy the restriction — drop it.
		return false;
	}
	if (excludes.some((domain) => domainMatches(host, domain))) return false;
	if (includes.length > 0 && !includes.some((domain) => domainMatches(host, domain))) return false;
	return true;
}

interface YoucomSearchResult {
	url?: string;
	title?: string;
	description?: string;
	snippets?: string[];
	page_age?: string;
}

interface YoucomSearchResponse {
	results?: {
		web?: YoucomSearchResult[];
		news?: YoucomSearchResult[];
	};
}

function isYoucomSearchResult(value: unknown): value is YoucomSearchResult {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.url === "string" &&
		(record.title === undefined || typeof record.title === "string") &&
		(record.description === undefined || typeof record.description === "string") &&
		(record.snippets === undefined || (Array.isArray(record.snippets) && record.snippets.every((s) => typeof s === "string")))
	);
}

function parseYoucomResponse(data: unknown): { web: YoucomSearchResult[]; news: YoucomSearchResult[] } {
	if (typeof data !== "object" || data === null) {
		throw new Error("You.com API returned unexpected response: expected a JSON object");
	}
	const results = (data as Record<string, unknown>).results;
	if (results === undefined) {
		return { web: [], news: [] };
	}
	if (typeof results !== "object" || results === null) {
		throw new Error("You.com API returned unexpected response: 'results' is not an object");
	}
	const sections = results as Record<string, unknown>;
	const web = parseResultSection(sections.web, "web");
	const news = parseResultSection(sections.news, "news");
	return { web, news };
}

function parseResultSection(section: unknown, name: string): YoucomSearchResult[] {
	if (section === undefined) return [];
	if (!Array.isArray(section)) {
		throw new Error(`You.com API returned unexpected response: 'results.${name}' is not an array`);
	}
	return section.filter(isYoucomSearchResult);
}

function toSearchResult(result: YoucomSearchResult, fallbackIndex: number): SearchResult | null {
	const url = typeof result.url === "string" ? result.url.trim() : "";
	if (!url) return null;
	const snippetParts: string[] = [];
	if (typeof result.description === "string" && result.description.length > 0) {
		snippetParts.push(result.description);
	}
	if (Array.isArray(result.snippets)) {
		for (const snippet of result.snippets) {
			if (typeof snippet === "string" && snippet.length > 0 && !snippetParts.includes(snippet)) {
				snippetParts.push(snippet);
			}
		}
	}
	return {
		title: result.title || `Source ${fallbackIndex}`,
		url,
		snippet: snippetParts.join(" · "),
	};
}

export function isYoucomAvailable(): boolean {
	const config = loadConfig();
	return !!(normalizeApiKey(process.env.YDC_API_KEY) ?? normalizeApiKey(config.youcomApiKey));
}

export async function searchWithYoucom(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	// Validate credentials before starting activity tracking so a missing key
	// never leaves a dangling activity entry.
	const apiKey = getApiKey();
	const numResults = Math.min(options.numResults ?? 5, MAX_RESULTS);

	const activityId = activityMonitor.logStart({ type: "api", query });

	const requestBody: Record<string, unknown> = {
		query,
		count: numResults,
	};

	if (options.recencyFilter) {
		requestBody.freshness = options.recencyFilter;
	}

	let response: Response;
	try {
		response = await fetch(YOUCOM_API_URL, {
			method: "POST",
			headers: {
				"X-API-Key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
			signal: options.signal,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = await response.text();
		throw new Error(`You.com API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`You.com API returned invalid JSON: ${message}`);
	}

	// Response-shape validation at the API boundary; also settles tracking on failure.
	let sections: { web: YoucomSearchResult[]; news: YoucomSearchResult[] };
	try {
		sections = parseYoucomResponse(data);
	} catch (err) {
		activityMonitor.logError(activityId, err instanceof Error ? err.message : String(err));
		throw err;
	}

	const results: SearchResult[] = [];
	let sourceIndex = 0;
	for (const result of [...sections.web, ...sections.news]) {
		if (results.length >= numResults) break;
		const mapped = toSearchResult(result, ++sourceIndex);
		if (mapped && applyDomainFilter(mapped, options.domainFilter)) {
			results.push(mapped);
		}
	}

	activityMonitor.logComplete(activityId, response.status);
	return { answer: "", results };
}
