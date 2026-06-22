import { CONFIG_DIR_NAME, getUserConfigPaths } from "@bastani/atomic";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findReadableConfigPath } from "./config-paths.ts";
import { isExaAvailable } from "./exa.js";
import { isGeminiApiAvailable } from "./gemini-api.js";
import { isGeminiWebAvailable } from "./gemini-web.js";
import { isPerplexityAvailable } from "./perplexity.js";
import type { SearchProvider, ResolvedSearchProvider } from "./gemini-search.js";

const WEB_SEARCH_CONFIG_PATH = getUserConfigPaths("web-search.json")[0] ?? join(homedir(), CONFIG_DIR_NAME, "web-search.json");
const WEB_SEARCH_CONFIG_READ_PATH = findReadableConfigPath();
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

export type WebSearchWorkflow = "none" | "summary-review";
export type CuratorWorkflow = "summary-review";

export interface CuratorBootstrap {
	availableProviders: ProviderAvailability;
	defaultProvider: ResolvedSearchProvider;
	timeoutSeconds: number;
}

export function loadConfig(): WebSearchConfig {
	if (!existsSync(WEB_SEARCH_CONFIG_READ_PATH)) return {};
	const raw = readFileSync(WEB_SEARCH_CONFIG_READ_PATH, "utf-8");
	try {
		return JSON.parse(raw) as WebSearchConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_READ_PATH}: ${message}`);
	}
}

export function saveConfig(updates: Partial<WebSearchConfig>): void {
	let config: Record<string, unknown> = {};
	const existingConfigPath = findReadableConfigPath();
	if (existsSync(existingConfigPath)) {
		const raw = readFileSync(existingConfigPath, "utf-8");
		try {
			config = JSON.parse(raw) as Record<string, unknown>;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to parse ${existingConfigPath}: ${message}`);
		}
	}

	Object.assign(config, updates);
	const dir = join(homedir(), CONFIG_DIR_NAME);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(WEB_SEARCH_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function loadConfigForExtensionInit(): WebSearchConfig {
	try {
		return loadConfig();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[pi-web-access] ${message}`);
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

export function resolveWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {
	if (!hasUI) return "none";
	if (typeof input === "string" && input.trim().toLowerCase() === "none") return "none";
	return "summary-review";
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

function getCuratorTimeoutSeconds(): number {
	const source = loadConfig();
	return normalizeCuratorTimeoutSeconds(source.curatorTimeoutSeconds) ?? DEFAULT_CURATOR_TIMEOUT_SECONDS;
}

async function getProviderAvailability(): Promise<ProviderAvailability> {
	const geminiWebAvail = await isGeminiWebAvailable();
	return {
		perplexity: isPerplexityAvailable(),
		exa: isExaAvailable(),
		gemini: isGeminiApiAvailable() || !!geminiWebAvail,
	};
}

export async function loadCuratorBootstrap(requestedProvider: unknown): Promise<CuratorBootstrap> {
	const availableProviders = await getProviderAvailability();
	return {
		availableProviders,
		defaultProvider: resolveProvider(requestedProvider, availableProviders),
		timeoutSeconds: getCuratorTimeoutSeconds(),
	};
}

function resolveProvider(requested: unknown, available: ProviderAvailability): ResolvedSearchProvider {
	const provider = normalizeProviderInput(requested ?? loadConfig().provider ?? "auto") ?? "auto";

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
