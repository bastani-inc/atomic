import { reportOwnedWebDiagnostic } from "./diagnostics.js";
import { CONFIG_DIR_NAME, getUserConfigPaths } from "@bastani/atomic";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isExaAvailable } from "./exa.js";
import { isGeminiApiAvailable } from "./gemini-api.js";
import { isGeminiWebAvailable } from "./gemini-web.js";
import { readWebSearchConfigFile } from "./gemini-web-config.ts";
import { isPerplexityAvailable } from "./perplexity.js";
import { resetSearchConfig, type ResolvedSearchProvider, type SearchProvider } from "./gemini-search.js";

const WEB_SEARCH_CONFIG_PATH = getUserConfigPaths("web-search.json")[0] ?? join(homedir(), CONFIG_DIR_NAME, "web-search.json");
const MAX_CURATOR_TIMEOUT_SECONDS = 600;
const DEFAULT_CURATOR_TIMEOUT_SECONDS = 20;

export const DEFAULT_SHORTCUTS = { curate: "ctrl+shift+s", activity: "ctrl+shift+w" };

export interface WebSearchConfig {
	provider?: string;
	workflow?: string;
	curatorTimeoutSeconds?: unknown;
	summaryModel?: string;
	shortcuts?: {
		curate?: string;
		activity?: string;
	};
}

export interface ProviderAvailability {
	perplexity: boolean;
	exa: boolean;
	gemini: boolean;
}

export type { CuratorWorkflow, WebSearchWorkflow } from "./web-search-workflow.js";
export { resolveWorkflow } from "./web-search-workflow.js";

export interface CuratorBootstrap {
	availableProviders: ProviderAvailability;
	defaultProvider: ResolvedSearchProvider;
	timeoutSeconds: number;
}

export async function loadConfig(): Promise<WebSearchConfig> {
	// Resolve the readable path on every call: saveConfig always writes the
	// Atomic path, which must win over a legacy file that existed at startup.
	return (await readWebSearchConfigFile<WebSearchConfig>()) ?? {};
}

let saveConfigQueue: Promise<void> = Promise.resolve();

export function saveConfig(updates: Partial<WebSearchConfig>): Promise<void> {
	const run = async (): Promise<void> => {
		const existing = await readWebSearchConfigFile<Record<string, unknown>>();
		const config: Record<string, unknown> = existing ? { ...existing } : {};

		Object.assign(config, updates);
		if (updates.provider !== undefined) {
			delete config.searchProvider;
		}
		await mkdir(dirname(WEB_SEARCH_CONFIG_PATH), { recursive: true });
		await writeFile(WEB_SEARCH_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
		resetSearchConfig();
	};
	const next = saveConfigQueue.then(run, run);
	saveConfigQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

export async function loadConfigForExtensionInit(): Promise<WebSearchConfig> {
	try {
		return await loadConfig();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!reportOwnedWebDiagnostic()) console.error(`[pi-web-access] ${message}`);
		return {};
	}
}

export function normalizeProviderInput(value: unknown): SearchProvider | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return "auto";
	const normalized = value.trim().toLowerCase();
	if (normalized === "auto" || normalized === "exa" || normalized === "perplexity" || normalized === "gemini") {
		return normalized;
	}
	return "auto";
}

function normalizeCuratorTimeoutSeconds(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const normalized = Math.floor(value);
	if (normalized < 1) return undefined;
	return Math.min(normalized, MAX_CURATOR_TIMEOUT_SECONDS);
}

export function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

async function getProviderAvailability(): Promise<ProviderAvailability> {
	const [geminiWebAvail, perplexity, exa, geminiApi] = await Promise.all([
		isGeminiWebAvailable(),
		isPerplexityAvailable(),
		isExaAvailable(),
		isGeminiApiAvailable(),
	]);
	return {
		perplexity,
		exa,
		gemini: geminiApi || !!geminiWebAvail,
	};
}

export async function loadCuratorBootstrap(requestedProvider: unknown): Promise<CuratorBootstrap> {
	const [availableProviders, config] = await Promise.all([getProviderAvailability(), loadConfig()]);
	return {
		availableProviders,
		defaultProvider: resolveProvider(requestedProvider, availableProviders, config.provider),
		timeoutSeconds: normalizeCuratorTimeoutSeconds(config.curatorTimeoutSeconds) ?? DEFAULT_CURATOR_TIMEOUT_SECONDS,
	};
}

function resolveProvider(
	requested: unknown,
	available: ProviderAvailability,
	configuredProvider?: unknown,
): ResolvedSearchProvider {
	const provider = normalizeProviderInput(requested ?? configuredProvider ?? "auto") ?? "auto";

	if (provider === "auto") {
		if (available.exa) return "exa";
		if (available.perplexity) return "perplexity";
		if (available.gemini) return "gemini";
		return "exa";
	}
	if (provider === "exa" && !available.exa) {
		if (available.perplexity) return "perplexity";
		return available.gemini ? "gemini" : "exa";
	}
	if (provider === "perplexity" && !available.perplexity) {
		if (available.exa) return "exa";
		return available.gemini ? "gemini" : "perplexity";
	}
	if (provider === "gemini" && !available.gemini) {
		if (available.exa) return "exa";
		return available.perplexity ? "perplexity" : "gemini";
	}
	return provider;
}
