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
	const activityId = activityMonitor.logStart({ type: "api", query });

	const apiKey = getApiKey();
	const numResults = Math.min(options.numResults ?? 5, MAX_RESULTS);

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

	let data: YoucomSearchResponse;
	try {
		data = await response.json() as YoucomSearchResponse;
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`You.com API returned invalid JSON: ${message}`);
	}

	const results: SearchResult[] = [];
	let sourceIndex = 0;
	for (const result of data.results?.web ?? []) {
		const mapped = toSearchResult(result, ++sourceIndex);
		if (mapped) results.push(mapped);
	}
	for (const result of data.results?.news ?? []) {
		const mapped = toSearchResult(result, ++sourceIndex);
		if (mapped && results.length < numResults) results.push(mapped);
	}

	activityMonitor.logComplete(activityId, response.status);
	return { answer: "", results };
}
