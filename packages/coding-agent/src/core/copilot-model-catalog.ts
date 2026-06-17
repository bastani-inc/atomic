/**
 * GitHub Copilot model catalog (CAPI) — dynamic context-window tiers.
 *
 * GitHub's Copilot API (CAPI) exposes per-model context tiers via `GET {baseUrl}/models`.
 * Each model reports `billing.token_prices.<tier>.context_max` (the max input/prompt tokens
 * for that tier) and `capabilities.limits.max_output_tokens`. The Copilot CLI
 * (copilot-agent-runtime) derives a tier's effective window as
 * `context_max + max_output_tokens` and only offers a selectable "long context" window when a
 * `long_context` tier exists. Atomic mirrors those decisions here.
 *
 * Atomic's token counter measures input+output (see `calculateContextTokens`), so the
 * input+output total window is the correct budget to expose — matching the Copilot CLI display.
 *
 * This data is intentionally NOT baked into a static map: GitHub adds/removes models and retiers
 * windows over time (e.g. a model that disappears from the catalog), so a hardcoded snapshot goes
 * stale. Instead the catalog is fetched live (gated on the user actually having the GitHub Copilot
 * provider) and cached on disk for a short TTL, exactly like the Copilot CLI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Per-model context-tier data parsed from a CAPI `/models` entry. */
export interface CopilotModelTier {
	/** `capabilities.limits.max_output_tokens` (0 when the model does not report one). */
	maxOutputTokens: number;
	/** `billing.token_prices.default.context_max` — max input tokens for the default tier. */
	defaultContextMax: number;
	/** `billing.token_prices.long_context.context_max` — present only when a long_context tier exists. */
	longContextMax: number;
}

/** Map of model id → context-tier data. Only models with a `long_context` tier are included. */
export type CopilotModelCatalog = ReadonlyMap<string, CopilotModelTier>;

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
export const COPILOT_CATALOG_CACHE_VERSION = 1 as const;

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

function toNonNegativeInt(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Parse a raw CAPI `/models` response body into a context-tier catalog.
 *
 * Mirrors the Copilot CLI gating: a model only yields a selectable window when its token prices are
 * tiered AND a `long_context` tier exists. Entries missing either tier's `context_max` are skipped.
 */
export function parseCopilotModelCatalog(body: unknown): CopilotModelCatalog {
	const catalog = new Map<string, CopilotModelTier>();
	const data = asRecord(body)?.data;
	if (!Array.isArray(data)) return catalog;

	for (const entry of data) {
		const record = asRecord(entry);
		if (!record) continue;
		const id = record.id;
		if (typeof id !== "string" || id.length === 0) continue;

		const limits = asRecord(asRecord(record.capabilities)?.limits);
		const prices = asRecord(asRecord(record.billing)?.token_prices);
		if (!prices) continue;

		const defaultContextMax = toPositiveInt(asRecord(prices.default)?.context_max);
		const longContextMax = toPositiveInt(asRecord(prices.long_context)?.context_max);
		// Gate: only models exposing both a default and a long_context tier get a picker.
		if (defaultContextMax === undefined || longContextMax === undefined) continue;

		catalog.set(id, {
			maxOutputTokens: toNonNegativeInt(limits?.max_output_tokens),
			defaultContextMax,
			longContextMax,
		});
	}

	return catalog;
}

/** Effective (input+output) window for a tier — mirrors the Copilot CLI `tierContextWindowTokens`. */
export function tierContextWindowTokens(contextMax: number, maxOutputTokens: number): number {
	return contextMax + Math.max(0, maxOutputTokens);
}

export interface CopilotContextWindows {
	/** Default-tier window: `default.context_max + max_output_tokens`. */
	defaultWindow: number;
	/** Long-context-tier window: `long_context.context_max + max_output_tokens`. */
	longWindow: number;
}

/** Derive the default and long-context (input+output) windows for a model tier. */
export function deriveCopilotContextWindows(tier: CopilotModelTier): CopilotContextWindows {
	return {
		defaultWindow: tierContextWindowTokens(tier.defaultContextMax, tier.maxOutputTokens),
		longWindow: tierContextWindowTokens(tier.longContextMax, tier.maxOutputTokens),
	};
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
// Empty by default, so with no Copilot auth / no successful fetch the registry adds no
// context-window options and the picker never appears.
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
	models: Record<string, CopilotModelTier>;
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

/** Read a fresh, host-matching catalog from the cache file, or `undefined` if missing/stale/invalid. */
export function readCopilotCatalogCache(path: string, options: ReadCopilotCatalogCacheOptions): CopilotModelCatalog | undefined {
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

	const catalog = new Map<string, CopilotModelTier>();
	for (const [id, value] of Object.entries(models)) {
		const tier = asRecord(value);
		const defaultContextMax = toPositiveInt(tier?.defaultContextMax);
		const longContextMax = toPositiveInt(tier?.longContextMax);
		if (defaultContextMax === undefined || longContextMax === undefined) continue;
		catalog.set(id, { maxOutputTokens: toNonNegativeInt(tier?.maxOutputTokens), defaultContextMax, longContextMax });
	}
	return catalog;
}

/** Write the catalog to the cache file (creating parent dirs). Best-effort; never throws. */
export function writeCopilotCatalogCache(path: string, baseUrl: string, catalog: CopilotModelCatalog, now?: number): void {
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
