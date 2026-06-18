/**
 * GitHub Copilot model catalog (CAPI) — dynamic, input-token context windows.
 *
 * GitHub's Copilot API (CAPI) exposes per-model limits via `GET {baseUrl}/models`. Every window
 * Atomic shows for a Copilot model is measured in INPUT (prompt) tokens, exactly like every other
 * provider's `contextWindow`, so GitHub models read consistently across the UI:
 *
 *   - A model's input budget = `capabilities.limits.max_prompt_tokens`
 *       ?? `capabilities.limits.max_context_window_tokens`
 *       ?? 128_000   (the two fallbacks are safeties real CAPI entries never hit).
 *   - Models with tiered pricing expose per-tier input budgets via
 *     `billing.token_prices.<tier>.context_max`. The `default` tier is the base context window
 *     (e.g. gpt-5.5 272k, Claude 200k); a `long_context` tier adds a selectable larger input
 *     window (e.g. gpt-5.5 922k, Claude 936k) the user can switch to via the `/model` picker.
 *
 * This data is intentionally NOT baked into a static map: GitHub adds/removes models and retiers
 * windows over time (e.g. a model that disappears from the catalog), so a hardcoded snapshot goes
 * stale. Instead the catalog is fetched live (gated on the user actually having the GitHub Copilot
 * provider) and cached on disk for a short TTL, exactly like the Copilot CLI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Resolved input-token context window(s) for a single Copilot model. */
export interface CopilotModelContext {
	/**
	 * Base context window in INPUT tokens — shown in the footer and used for compaction. The
	 * default tier's `context_max`, or the model-level `max_prompt_tokens` fallback otherwise.
	 */
	contextWindow: number;
	/**
	 * Selectable input-token windows (`[default, long]`) when the model exposes a `long_context`
	 * tier larger than its default; absent for single-window models.
	 */
	contextWindowOptions?: readonly number[];
}

/** Map of model id → resolved input-token context window(s). */
export type CopilotModelCatalog = ReadonlyMap<string, CopilotModelContext>;

/** Safety fallback when a model reports neither `max_prompt_tokens` nor `max_context_window_tokens`. */
export const COPILOT_CONTEXT_WINDOW_FALLBACK = 128_000;

export const COPILOT_CATALOG_API_VERSION = "2026-06-01";

/**
 * Headers GitHub's CAPI expects for catalog reads. Mirrors the editor headers pi-ai already sends
 * for Copilot token refresh and model-policy calls, plus the dated API version.
 */
export const COPILOT_CATALOG_HEADERS: Readonly<Record<string, string>> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
	"X-GitHub-Api-Version": COPILOT_CATALOG_API_VERSION,
};

/** Default (non-enterprise) Copilot CAPI base URL when the token has no resolvable `proxy-ep`. */
export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";

/** Disk-cache freshness window, matching the Copilot CLI's list-models cache TTL. */
export const COPILOT_CATALOG_CACHE_TTL_MS = 30 * 60 * 1000;

/** Current on-disk cache schema version. */
export const COPILOT_CATALOG_CACHE_VERSION = 2 as const;

/**
 * Resolve the Copilot CAPI base URL.
 *
 * Copilot access tokens embed a `proxy-ep=proxy.<host>` segment; the API host is the same host with
 * `proxy.` swapped for `api.`. Falls back to the enterprise host or the individual default. (pi-ai
 * exposes an equivalent helper, but its published `dist` mangles the export name, so the small,
 * stable parsing logic is reimplemented here.)
 */
export function copilotApiBaseUrlFromToken(token: string | undefined, enterpriseDomain?: string): string {
	if (token) {
		const match = token.match(/proxy-ep=([^;]+)/);
		if (match) {
			return `https://${match[1].replace(/^proxy\./, "api.")}`;
		}
	}
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return DEFAULT_COPILOT_API_BASE_URL;
}

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function toPositiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Raw input-token limits parsed from a CAPI model entry. */
export interface CopilotModelLimits {
	/** `capabilities.limits.max_prompt_tokens`. */
	maxPromptTokens?: number;
	/** `capabilities.limits.max_context_window_tokens`. */
	maxContextWindowTokens?: number;
	/** `billing.token_prices.default.context_max`. */
	defaultContextMax?: number;
	/** `billing.token_prices.long_context.context_max`. */
	longContextMax?: number;
}

/**
 * Resolve a model's input-token context window(s) from its CAPI limits.
 *
 * `contextWindow` is the model's base input budget — the default tier's `context_max` when tiered,
 * otherwise `max_prompt_tokens ?? max_context_window_tokens ?? 128_000`. A `long_context` tier that
 * is larger than the base adds a second selectable window. Returns `undefined` when the entry
 * carries no usable limit signal at all.
 */
export function resolveCopilotModelContext(limits: CopilotModelLimits): CopilotModelContext | undefined {
	const hasSignal =
		limits.maxPromptTokens !== undefined ||
		limits.maxContextWindowTokens !== undefined ||
		limits.defaultContextMax !== undefined ||
		limits.longContextMax !== undefined;
	if (!hasSignal) return undefined;

	const maxInput = limits.maxPromptTokens ?? limits.maxContextWindowTokens ?? COPILOT_CONTEXT_WINDOW_FALLBACK;
	const base = limits.defaultContextMax ?? maxInput;
	if (limits.longContextMax !== undefined && limits.longContextMax > base) {
		return { contextWindow: base, contextWindowOptions: [base, limits.longContextMax] };
	}
	return { contextWindow: base };
}

/**
 * Parse a raw CAPI `/models` response body into an input-token context-window catalog.
 */
export function parseCopilotModelCatalog(body: unknown): CopilotModelCatalog {
	const catalog = new Map<string, CopilotModelContext>();
	const data = asRecord(body)?.data;
	if (!Array.isArray(data)) return catalog;

	for (const entry of data) {
		const record = asRecord(entry);
		if (!record) continue;
		const id = record.id;
		if (typeof id !== "string" || id.length === 0) continue;

		const limits = asRecord(asRecord(record.capabilities)?.limits);
		const prices = asRecord(asRecord(record.billing)?.token_prices);
		const context = resolveCopilotModelContext({
			maxPromptTokens: toPositiveInt(limits?.max_prompt_tokens),
			maxContextWindowTokens: toPositiveInt(limits?.max_context_window_tokens),
			defaultContextMax: toPositiveInt(asRecord(prices?.default)?.context_max),
			longContextMax: toPositiveInt(asRecord(prices?.long_context)?.context_max),
		});
		if (context) catalog.set(id, context);
	}

	return catalog;
}

export interface FetchCopilotModelCatalogOptions {
	/** Valid Copilot CAPI bearer token (e.g. from `modelRegistry.getApiKeyForProvider`). */
	token: string;
	/** Override the resolved base URL; defaults to one derived from the token. */
	baseUrl?: string;
	/** Enterprise domain, used for base-URL resolution when the token lacks a `proxy-ep`. */
	enterpriseDomain?: string;
	/** Extra/override request headers. */
	headers?: Record<string, string>;
	/** Injectable `fetch` for testing. */
	fetchImpl?: typeof fetch;
	/** Abort signal. */
	signal?: AbortSignal;
}

/** Fetch and parse the live Copilot model catalog from CAPI `GET {baseUrl}/models`. */
export async function fetchCopilotModelCatalog(options: FetchCopilotModelCatalogOptions): Promise<CopilotModelCatalog> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = options.baseUrl ?? copilotApiBaseUrlFromToken(options.token, options.enterpriseDomain);
	const response = await fetchImpl(`${trimTrailingSlash(baseUrl)}/models`, {
		method: "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${options.token}`,
			...COPILOT_CATALOG_HEADERS,
			...options.headers,
		},
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (!response.ok) {
		throw new Error(`GitHub Copilot /models request failed: ${response.status} ${response.statusText}`);
	}
	return parseCopilotModelCatalog(await response.json());
}

// ----------------------------------------------------------------------------
// Active in-memory catalog (consulted by the model registry).
//
// Empty by default, so with no Copilot auth / no successful fetch the registry leaves Copilot
// model context windows untouched and the picker never appears.
// ----------------------------------------------------------------------------

let activeCatalog: CopilotModelCatalog = new Map();

/** Replace the active catalog the registry derives context windows from. */
export function setActiveCopilotModelCatalog(catalog: CopilotModelCatalog): void {
	activeCatalog = catalog;
}

/** The active catalog (empty until a successful auth-gated fetch/cache load). */
export function getActiveCopilotModelCatalog(): CopilotModelCatalog {
	return activeCatalog;
}

/** Reset the active catalog (primarily for tests). */
export function clearActiveCopilotModelCatalog(): void {
	activeCatalog = new Map();
}

// ----------------------------------------------------------------------------
// Disk cache.
// ----------------------------------------------------------------------------

interface CopilotCatalogCacheFile {
	version: typeof COPILOT_CATALOG_CACHE_VERSION;
	/** CAPI host the catalog was fetched from; cache misses on host change (e.g. enterprise switch). */
	host: string;
	/** Epoch ms the catalog was fetched. */
	fetchedAt: number;
	models: Record<string, CopilotModelContext>;
}

function hostFromBaseUrl(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}

export interface ReadCopilotCatalogCacheOptions {
	/** Expected CAPI host; a cached file from a different host is ignored. */
	host: string;
	/** Current epoch ms (injectable for tests). */
	now?: number;
	/** Freshness window; defaults to {@link COPILOT_CATALOG_CACHE_TTL_MS}. */
	ttlMs?: number;
}

function sanitizeCachedContext(value: unknown): CopilotModelContext | undefined {
	const record = asRecord(value);
	const contextWindow = toPositiveInt(record?.contextWindow);
	if (contextWindow === undefined) return undefined;
	const rawOptions = record?.contextWindowOptions;
	if (Array.isArray(rawOptions)) {
		const options = rawOptions.map(toPositiveInt).filter((n): n is number => n !== undefined);
		if (options.length > 1) return { contextWindow, contextWindowOptions: options };
	}
	return { contextWindow };
}

/** Read a fresh, host-matching catalog from the cache file, or `undefined` if missing/stale/invalid. */
export function readCopilotCatalogCache(
	path: string,
	options: ReadCopilotCatalogCacheOptions,
): CopilotModelCatalog | undefined {
	let parsed: CopilotCatalogCacheFile;
	try {
		if (!existsSync(path)) return undefined;
		parsed = JSON.parse(readFileSync(path, "utf8")) as CopilotCatalogCacheFile;
	} catch {
		return undefined;
	}
	if (!parsed || parsed.version !== COPILOT_CATALOG_CACHE_VERSION) return undefined;
	if (parsed.host !== options.host) return undefined;
	const now = options.now ?? Date.now();
	const ttlMs = options.ttlMs ?? COPILOT_CATALOG_CACHE_TTL_MS;
	if (typeof parsed.fetchedAt !== "number" || now - parsed.fetchedAt >= ttlMs) return undefined;
	const models = asRecord(parsed.models);
	if (!models) return undefined;

	const catalog = new Map<string, CopilotModelContext>();
	for (const [id, value] of Object.entries(models)) {
		const context = sanitizeCachedContext(value);
		if (context) catalog.set(id, context);
	}
	return catalog;
}

/** Write the catalog to the cache file (creating parent dirs). Best-effort; never throws. */
export function writeCopilotCatalogCache(
	path: string,
	baseUrl: string,
	catalog: CopilotModelCatalog,
	now?: number,
): void {
	const payload: CopilotCatalogCacheFile = {
		version: COPILOT_CATALOG_CACHE_VERSION,
		host: hostFromBaseUrl(baseUrl),
		fetchedAt: now ?? Date.now(),
		models: Object.fromEntries(catalog),
	};
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(payload), "utf8");
	} catch {
		// best-effort cache; ignore write failures
	}
}

/** Host component of a base URL, for matching {@link readCopilotCatalogCache} `host`. */
export function copilotCatalogCacheHost(baseUrl: string): string {
	return hostFromBaseUrl(baseUrl);
}

/** Standard on-disk cache path for the Copilot model catalog under an agent directory. */
export function copilotCatalogCachePath(agentDir: string): string {
	return join(agentDir, "cache", "copilot-models.json");
}

/**
 * Seed the active catalog synchronously from the on-disk cache, gated on a Copilot access token.
 *
 * Called at model-registry construction so a returning user's previously selected long-context
 * window is recognized before startup validation runs — otherwise the persisted choice would warn
 * ("context window 936k is not supported…") and reset until the async refresh completes. The cache
 * TTL is intentionally ignored here: stale-but-present windows are still valid for selection, and
 * the async loader independently refetches on its own freshness window. Returns true when a catalog
 * was applied. No-op (returns false) without a token or a host-matching cached catalog.
 */
export function seedActiveCopilotModelCatalogFromCache(
	accessToken: string | undefined,
	cachePath: string,
	now?: number,
): boolean {
	if (typeof accessToken !== "string" || accessToken.length === 0) return false;
	const host = copilotCatalogCacheHost(copilotApiBaseUrlFromToken(accessToken));
	const cached = readCopilotCatalogCache(cachePath, { host, now, ttlMs: Number.POSITIVE_INFINITY });
	if (!cached) return false;
	setActiveCopilotModelCatalog(cached);
	return true;
}
