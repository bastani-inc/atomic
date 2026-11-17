import { activityMonitor } from "./activity.js";
import type { ExtractedContent } from "./extract.js";
import { findReadableConfigPath } from "./config-paths.ts";
import { createAsyncOwnerState, readWebSearchConfigFile } from "./gemini-web-config.ts";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";

const RATE_LIMIT = {
	maxRequests: 10,
	windowMs: 60 * 1000,
};

const requestTimestamps: number[] = [];

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: ExtractedContent[];
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
}

interface WebSearchConfig {
	perplexityApiKey?: unknown;
}

const loadConfig = createAsyncOwnerState<WebSearchConfig>(async () => {
	return (await readWebSearchConfigFile<WebSearchConfig>()) ?? {};
});

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

async function getApiKey(): Promise<string> {
	const config = await loadConfig();
	const key = normalizeApiKey(process.env.PERPLEXITY_API_KEY) ?? normalizeApiKey(config.perplexityApiKey);
	if (!key) {
		const configPath = await findReadableConfigPath();
		throw new Error(
			"Perplexity API key not found. Either:\n" +
			`  1. Create ${configPath} with { "perplexityApiKey": "your-key" }\n` +
			"  2. Set PERPLEXITY_API_KEY environment variable\n" +
			"Get a key at https://perplexity.ai/settings/api"
		);
	}
	return key;
}

function checkRateLimit(): void {
	const now = Date.now();
	const windowStart = now - RATE_LIMIT.windowMs;

	while (requestTimestamps.length > 0 && requestTimestamps[0] < windowStart) {
		requestTimestamps.shift();
	}

	if (requestTimestamps.length >= RATE_LIMIT.maxRequests) {
		const waitMs = requestTimestamps[0] + RATE_LIMIT.windowMs - now;
		throw new Error(`Rate limited. Try again in ${Math.ceil(waitMs / 1000)}s`);
	}

	requestTimestamps.push(now);
}

function validateDomainFilter(domains: string[]): string[] {
	return domains.filter((d) => {
		const domain = d.startsWith("-") ? d.slice(1) : d;
		return /^[a-zA-Z0-9][a-zA-Z0-9-_.]*\.[a-zA-Z]{2,}$/.test(domain);
	});
}

export async function isPerplexityAvailable(): Promise<boolean> {
	const config = await loadConfig();
	return !!(normalizeApiKey(process.env.PERPLEXITY_API_KEY) ?? normalizeApiKey(config.perplexityApiKey));
}

export async function searchWithPerplexity(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	checkRateLimit();

	const activityId = activityMonitor.logStart({ type: "api", query });

	activityMonitor.updateRateLimit({
		used: requestTimestamps.length,
		max: RATE_LIMIT.maxRequests,
		oldestTimestamp: requestTimestamps[0] ?? null,
		windowMs: RATE_LIMIT.windowMs,
	});

	const apiKey = await getApiKey();
	const numResults = Math.min(options.numResults ?? 5, 20);

	const requestBody: Record<string, unknown> = {
		model: "sonar",
		messages: [{ role: "user", content: query }],
		max_tokens: 1024,
		return_related_questions: false,
	};

	if (options.recencyFilter) {
		requestBody.search_recency_filter = options.recencyFilter;
	}

	if (options.domainFilter && options.domainFilter.length > 0) {
		const validated = validateDomainFilter(options.domainFilter);
		if (validated.length > 0) {
			requestBody.search_domain_filter = validated;
		}
	}

	let response: Response;
	try {
		response = await fetch(PERPLEXITY_API_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
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
		throw new Error(`Perplexity API error ${response.status}: ${errorText}`);
	}

	let data: Record<string, unknown>;
	try {
		data = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Perplexity API returned invalid JSON: ${message}`);
	}

	const answer = (data.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content || "";
	const citations = Array.isArray(data.citations) ? data.citations : [];

	const results: SearchResult[] = [];
	for (let i = 0; i < Math.min(citations.length, numResults); i++) {
		const citation = citations[i];
		if (typeof citation === "string") {
			results.push({ title: `Source ${i + 1}`, url: citation, snippet: "" });
		} else if (citation && typeof citation === "object" && typeof citation.url === "string") {
			results.push({
				title: citation.title || `Source ${i + 1}`,
				url: citation.url,
				snippet: "",
			});
		}
	}

	activityMonitor.logComplete(activityId, response.status);
	return { answer, results };
}
