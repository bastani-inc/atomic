/**
 * GitHub Copilot model catalog (CAPI) — dynamic prompt-token budgets.
 *
 * GitHub's Copilot API (CAPI) exposes distinct model limits via `GET {baseUrl}/models`:
 *
 *   - `capabilities.limits.max_context_window_tokens` is the model's total context capacity
 *     (prompt + completion reserve).
 *   - `capabilities.limits.max_prompt_tokens` is the maximum prompt/input budget Atomic can safely
 *     fill before the provider must reserve output tokens.
 *   - `billing.token_prices.<tier>.context_max` is a prompt-token billing/selection threshold. The
 *     `default` tier is the short prompt budget (e.g. gpt-5.5 272k, Claude 200k); a
 *     `long_context` tier adds a selectable larger prompt budget (e.g. gpt-5.5 922k, Claude 936k).
 *
 * Atomic shows the model's full context window for the selectable long tier (the
 * `max_context_window_tokens` total, e.g. 1_000_000/1_050_000), matching how the native `openai/*`
 * and `anthropic/*` providers advertise these models. Because GitHub enforces a lower server-side
 * prompt cap (`max_prompt_tokens`, e.g. 936k/922k) below that total, the prompt cap is retained as
 * an internal effective input budget (`CopilotModelContext.maxInputTokens`) that drives compaction
 * thresholds and the overflow-recovery guard, so the branded total can be displayed without
 * overrunning the server limit. The default (short) tier stays at the `default` billing tier's
 * prompt budget.
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
	 * Base/displayed context window — shown in the footer. The default tier's `context_max`, or the
	 * model-level `max_prompt_tokens` fallback otherwise.
	 */
	contextWindow: number;
	/**
	 * Selectable windows (`[default, long]`) when the model exposes a `long_context` tier larger than
	 * its default; absent for single-window models. The long entry is the model's full
	 * `max_context_window_tokens` (total capacity) when advertised, matching `openai/*` and
	 * `anthropic/*`.
	 */
	contextWindowOptions?: readonly number[];
	/**
	 * Hard prompt/input cap (`max_prompt_tokens`) when it sits below the displayed long window. Used
	 * as the effective input budget for compaction thresholds and overflow recovery so the branded
	 * total can be shown without overrunning GitHub's server-side prompt limit. Absent when the
	 * displayed window already equals the input cap.
	 */
	maxInputTokens?: number;
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

/** Default Copilot CAPI base URL for OAuth tokens when no route can be resolved. */
export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";

/** GitHub Copilot public routing hub for PAT-based `COPILOT_GITHUB_TOKEN` auth. */
export const COPILOT_PUBLIC_API_BASE_URL = "https://api.githubcopilot.com";

/** Enterprise Copilot CAPI host for GHES/non-github.com server URLs. */
export const COPILOT_ENTERPRISE_API_BASE_URL = "https://api.enterprise.githubcopilot.com";

export const COPILOT_GITHUB_TOKEN_ENV = "COPILOT_GITHUB_TOKEN";
export const COPILOT_API_TARGET_ENV = "COPILOT_API_TARGET";
export const GITHUB_COPILOT_BASE_URL_ENV = "GITHUB_COPILOT_BASE_URL";
export const GITHUB_SERVER_URL_ENV = "GITHUB_SERVER_URL";

type CopilotEnvironment = Record<string, string | undefined>;

function normalizeCopilotApiBaseUrl(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		new URL(withScheme);
	} catch {
		return undefined;
	}
	return withScheme.replace(/\/+$/, "");
}

function explicitCopilotApiBaseUrlFromEnvironment(env: CopilotEnvironment): string | undefined {
	return normalizeCopilotApiBaseUrl(env[COPILOT_API_TARGET_ENV]) ?? normalizeCopilotApiBaseUrl(env[GITHUB_COPILOT_BASE_URL_ENV]);
}

function copilotApiBaseUrlFromServerUrl(serverUrl: string | undefined): string | undefined {
	const trimmed = serverUrl?.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
		const host = parsed.hostname.toLowerCase();
		if (!host || host === "github.com") return undefined;
		if (host.endsWith(".ghe.com")) return `https://copilot-api.${host}`;
		return COPILOT_ENTERPRISE_API_BASE_URL;
	} catch {
		return undefined;
	}
}

function isCopilotEnvironmentToken(token: string | undefined, env: CopilotEnvironment): boolean {
	const environmentToken = copilotTokenFromEnvironment(env);
	return environmentToken !== undefined && token === environmentToken;
}

export function copilotTokenFromEnvironment(env: CopilotEnvironment = process.env): string | undefined {
	const token = env[COPILOT_GITHUB_TOKEN_ENV]?.trim();
	return token ? token : undefined;
}

/** Disk-cache freshness window, matching the Copilot CLI's list-models cache TTL. */
export const COPILOT_CATALOG_CACHE_TTL_MS = 30 * 60 * 1000;

/** Current on-disk cache schema version. */
export const COPILOT_CATALOG_CACHE_VERSION = 3 as const;

/**
 * Resolve the Copilot CAPI base URL.
 *
 * Copilot access tokens embed a `proxy-ep=proxy.<host>` segment; the API host is the same host with
 * `proxy.` swapped for `api.`. Env-token routing resolves explicit `COPILOT_API_TARGET` /
 * `GITHUB_COPILOT_BASE_URL` overrides, then `GITHUB_SERVER_URL` (`*.ghe.com` ->
 * `copilot-api.<tenant>.ghe.com`, other non-github.com -> `api.enterprise.githubcopilot.com`),
 * then the public Copilot routing hub `api.githubcopilot.com` for `COPILOT_GITHUB_TOKEN`. Stored
 * OAuth credentials still fall back to the generated individual host when no token route is known.
 */
export function copilotApiBaseUrlFromToken(
	token: string | undefined,
	enterpriseDomain?: string,
	env: CopilotEnvironment = process.env,
): string {
	const explicitOverride = explicitCopilotApiBaseUrlFromEnvironment(env);
	if (explicitOverride) return explicitOverride;
	if (token) {
		const match = token.match(/proxy-ep=([^;]+)/);
		if (match) {
			return `https://${match[1].replace(/^proxy\./, "api.")}`;
		}
	}
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	const serverUrlOverride = copilotApiBaseUrlFromServerUrl(env[GITHUB_SERVER_URL_ENV]);
	if (serverUrlOverride) return serverUrlOverride;
	if (isCopilotEnvironmentToken(token, env)) return COPILOT_PUBLIC_API_BASE_URL;
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

/** Raw token limits parsed from a CAPI model entry. */
export interface CopilotModelLimits {
	/** `capabilities.limits.max_prompt_tokens` — maximum prompt/input budget (the hard input cap). */
	maxPromptTokens?: number;
	/** `capabilities.limits.max_context_window_tokens` — total context capacity (the displayed long tier). */
	maxContextWindowTokens?: number;
	/** `capabilities.limits.max_output_tokens` — output reserve; derives the input cap when `max_prompt_tokens` is absent. */
	maxOutputTokens?: number;
	/** `billing.token_prices.default.context_max` — default-tier prompt threshold. */
	defaultContextMax?: number;
	/** `billing.token_prices.long_context.context_max` — long-context prompt threshold. */
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
		// Display the model's full context window as the long tier (matching openai/* and anthropic/*)
		// when CAPI advertises it; otherwise fall back to the long-context prompt threshold for
		// older/sparse payloads.
		const longWindow = limits.maxContextWindowTokens ?? limits.longContextMax;
		// The hard prompt/input cap GitHub enforces server-side: prefer max_prompt_tokens, else derive
		// it from total − output reserve, else fall back to the long-context prompt threshold.
		const derivedInputCap =
			limits.maxContextWindowTokens !== undefined && limits.maxOutputTokens !== undefined
				? limits.maxContextWindowTokens - limits.maxOutputTokens
				: undefined;
		const inputCap =
			limits.maxPromptTokens ??
			(derivedInputCap !== undefined && derivedInputCap > 0 ? derivedInputCap : undefined) ??
			limits.longContextMax;
		// Only carry the cap when the displayed long window actually exceeds it (the branded-total
		// case); when they coincide there is no gap and the input budget is just the window.
		return longWindow > inputCap
			? { contextWindow: base, contextWindowOptions: [base, longWindow], maxInputTokens: inputCap }
			: { contextWindow: base, contextWindowOptions: [base, longWindow] };
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
			maxOutputTokens: toPositiveInt(limits?.max_output_tokens),
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
	const maxInputTokens = toPositiveInt(record?.maxInputTokens);
	const rawOptions = record?.contextWindowOptions;
	if (Array.isArray(rawOptions)) {
		const options = rawOptions.map(toPositiveInt).filter((n): n is number => n !== undefined);
		if (options.length > 1) {
			return maxInputTokens !== undefined
				? { contextWindow, contextWindowOptions: options, maxInputTokens }
				: { contextWindow, contextWindowOptions: options };
		}
	}
	return maxInputTokens !== undefined ? { contextWindow, maxInputTokens } : { contextWindow };
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
