import { existsSync, readFileSync } from "node:fs";
import { domainToASCII } from "node:url";
import { activityMonitor } from "./activity.js";
import { findReadableConfigPath } from "./config-paths.ts";
import { createOwnerState } from "./owner-state.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

const YOUCOM_API_URL = "https://ydc-index.io/v1/search";
const CONFIG_PATH = findReadableConfigPath();
const MAX_RESULTS = 20;

interface WebSearchConfig {
	youcomApiKey?: unknown;
}

const loadConfig = createOwnerState<WebSearchConfig>(() => {
	if (!existsSync(CONFIG_PATH)) return {};

	const content = readFileSync(CONFIG_PATH, "utf-8");
	try {
		return JSON.parse(content) as WebSearchConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
});

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

/** Hostname-shape check mirrored from perplexity.ts validateDomainFilter. */
const HOSTNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-_.]*\.[a-zA-Z]{2,}$/;

/**
 * Normalize a single domainFilter entry (after any `-` exclusion prefix has been
 * stripped): remove a scheme, path, and port, strip a leading `*.` or `.`, and
 * lowercase. Returns null for entries that do not look like a hostname.
 */
function normalizeDomainEntry(entry: string): string | null {
	let domain = entry.trim().toLowerCase();
	domain = domain.replace(/^https?:\/\//, "");
	const slash = domain.indexOf("/");
	if (slash !== -1) domain = domain.slice(0, slash);
	const colon = domain.indexOf(":");
	if (colon !== -1) domain = domain.slice(0, colon);
	if (domain.startsWith("*.")) domain = domain.slice(2);
	else if (domain.startsWith(".")) domain = domain.slice(1);
	if (domain.endsWith(".")) domain = domain.slice(0, -1);
	if (domain.length > 0) {
		// Fold IDN labels to ASCII (bücher.de → xn--bcher-kva.de); an empty
		// result means the input is not a valid domain.
		const ascii = domainToASCII(domain);
		if (ascii === "") return null;
		domain = ascii;
	}
	return HOSTNAME_PATTERN.test(domain) ? domain : null;
}

/**
 * Thrown when a caller-supplied domainFilter entry fails validation. Carries a
 * stable `name` so the routing layer can recognize it across module boundaries
 * and refuse to fall back to a provider that would ignore the restriction.
 */
export class DomainFilterValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DomainFilterValidationError";
	}
}

export function isDomainFilterValidationError(err: unknown): boolean {
	return (
		err instanceof DomainFilterValidationError ||
		(typeof err === "object" && err !== null && (err as { name?: unknown }).name === "DomainFilterValidationError")
	);
}

interface DomainFilter {
	includes: string[];
	excludes: string[];
}

/**
 * Split a domainFilter into normalized include and exclude hostnames. The
 * filter must be an array (or absent), and every entry must be a string that
 * normalizes to a hostname (optionally prefixed with `-`); a non-array filter
 * or a blank, non-string, or otherwise malformed entry (including a bare `-`)
 * throws, because skipping it would silently broaden the results the caller
 * asked to restrict. The parameter is typed as `unknown` because tool
 * arguments are not validated by the host, so any shape is reachable.
 */
function splitDomainFilter(domainFilter: unknown): DomainFilter {
	const includes: string[] = [];
	const excludes: string[] = [];
	if (domainFilter === undefined || domainFilter === null) return { includes, excludes };
	if (!Array.isArray(domainFilter)) {
		throw new DomainFilterValidationError(
			`Invalid domainFilter: domainFilter must be an array of hostnames like ["example.com", "-reddit.com"], got ${typeof domainFilter}`
		);
	}
	for (const entry of domainFilter) {
		const trimmed = typeof entry === "string" ? entry.trim() : "";
		const isExclude = trimmed.startsWith("-");
		const domain = trimmed ? normalizeDomainEntry(isExclude ? trimmed.slice(1) : trimmed) : null;
		if (!domain) {
			throw new DomainFilterValidationError(
				`Invalid domainFilter entry "${String(entry)}": expected a hostname like example.com (prefix with - to exclude)`
			);
		}
		(isExclude ? excludes : includes).push(domain);
	}
	return { includes, excludes };
}

function domainMatches(host: string, filter: string): boolean {
	const normalizedHost = host.toLowerCase();
	const normalizedFilter = filter.toLowerCase();
	return normalizedHost === normalizedFilter || normalizedHost.endsWith(`.${normalizedFilter}`);
}

/**
 * Client-side enforcement of domainFilter on results. Includes (or, for a pure
 * exclude filter, excludes) are also sent server-side, but a filter mixing both
 * only sends include_domains — the API rejects the combination — so its
 * exclusions are enforced here alone. Even when a filter was sent, results are
 * re-checked here so a restriction is never silently dropped on the server
 * contract alone.
 */
function applyDomainFilter(result: SearchResult, { includes, excludes }: DomainFilter): boolean {
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
	snippets?: unknown[];
	page_age?: string;
}

function isYoucomSearchResult(value: unknown): value is YoucomSearchResult {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.url === "string" &&
		(record.title === undefined || typeof record.title === "string") &&
		(record.description === undefined || typeof record.description === "string") &&
		(record.snippets === undefined || Array.isArray(record.snippets))
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
		// Mirror exa.ts: bound per-result content so the snippet and the
		// synthesized answer stay capped per result.
		snippet: snippetParts.join(" · ").slice(0, 1000),
	};
}

/** Mirror exa.ts buildAnswerFromSearchResults: synthesize an answer from result snippets with source citations. */
function buildAnswerFromResults(results: SearchResult[]): string {
	const parts: string[] = [];
	for (const result of results) {
		if (!result.snippet) continue;
		parts.push(`${result.snippet}\nSource: ${result.title} (${result.url})`);
	}
	return parts.join("\n\n");
}

export function isYoucomAvailable(): boolean {
	const config = loadConfig();
	return !!(normalizeApiKey(process.env.YDC_API_KEY) ?? normalizeApiKey(config.youcomApiKey));
}

export async function searchWithYoucom(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	// Validate credentials and the domain filter before starting activity
	// tracking so a missing key or a malformed filter never leaves a dangling
	// activity entry and never reaches the network.
	const apiKey = getApiKey();
	const domainFilter = splitDomainFilter(options.domainFilter);
	const requestedResults =
		typeof options.numResults === "number" && !Number.isNaN(options.numResults)
			? Math.trunc(options.numResults)
			: 5;
	const numResults = Math.max(1, Math.min(requestedResults, MAX_RESULTS));

	const activityId = activityMonitor.logStart({ type: "api", query });

	// Includes are sent server-side as include_domains; a pure exclude filter is
	// sent as exclude_domains. A filter that mixes both cannot send both (the
	// API returns 422 when include_domains and exclude_domains are both
	// present), so it keeps server-side narrowing via include_domains, enforces
	// the exclusions client-side, and requests the full page to keep that
	// post-filtering from shrinking an already-small page to zero. Client-side
	// filtering also runs in every case as enforcement of the server contract.
	const { includes, excludes } = domainFilter;
	const mixedDomainFilter = includes.length > 0 && excludes.length > 0;

	const requestBody: Record<string, unknown> = {
		query,
		count: mixedDomainFilter ? MAX_RESULTS : numResults,
	};

	if (includes.length > 0) {
		requestBody.include_domains = includes;
	} else if (excludes.length > 0) {
		requestBody.exclude_domains = excludes;
	}

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
		if (mapped && applyDomainFilter(mapped, domainFilter)) {
			results.push(mapped);
		}
	}

	activityMonitor.logComplete(activityId, response.status);
	return { answer: buildAnswerFromResults(results), results };
}
