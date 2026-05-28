import { createHash } from "node:crypto";
import { dedupeCursorModelVariants, type CursorModel } from "./model-mapping.ts";

export { type CursorModel } from "./model-mapping.ts";

export interface CursorModelsBridge {
	getUsableModels(accessToken: string): Promise<unknown>;
}

export interface DiscoverCursorModelsOptions {
	bridge?: CursorModelsBridge;
	cacheTtlMs?: number;
	fallbackModels?: CursorModel[];
}

export interface DiscoverCursorModelsResult {
	source: "live" | "cache" | "fallback";
	models: CursorModel[];
	warning?: string;
}

interface CacheEntry {
	tokenHash: string;
	fetchedAt: number;
	models: CursorModel[];
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, CacheEntry>();

export const FALLBACK_CURSOR_MODELS: CursorModel[] = [];

function tokenHash(accessToken: string): string {
	return createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[], fallback: number): number {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	}
	return fallback;
}

function firstBoolean(record: Record<string, unknown>, keys: string[]): boolean {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "boolean") return value;
	}
	return false;
}

function extractModelArray(raw: unknown): unknown[] {
	if (Array.isArray(raw)) return raw;
	const record = asRecord(raw);
	if (!record) return [];
	for (const key of ["models", "usableModels", "availableModels", "modelNames"]) {
		const value = record[key];
		if (Array.isArray(value)) return value;
	}
	return [];
}

function normalizeName(id: string, name: string): string {
	const parsedSuffix = id.match(/-(low|medium|high|xhigh|max|none|thinking)(-fast)?$/);
	if (!parsedSuffix) return name;
	return name.replace(/\s+(low|medium|high|x\s*high|max|none|thinking)(\s+fast)?$/i, "").trim() || id;
}

export function normalizeCursorModels(raw: unknown): CursorModel[] {
	const normalized: CursorModel[] = [];
	for (const item of extractModelArray(raw)) {
		if (typeof item === "string") {
			normalized.push({
				id: item,
				name: item,
				reasoning: /-(low|medium|high|xhigh|max|thinking)(-fast)?$/.test(item),
				contextWindow: DEFAULT_CONTEXT_WINDOW,
				maxTokens: DEFAULT_MAX_TOKENS,
				raw: item,
			});
			continue;
		}

		const record = asRecord(item);
		if (!record) continue;
		const id = firstString(record, ["id", "modelId", "modelName", "name", "model", "slug"]);
		if (!id) continue;
		const displayName = firstString(record, ["displayName", "displayNameShort", "displayModelId", "title", "label", "name"]) ?? id;
		const reasoning =
			firstBoolean(record, ["reasoning", "supportsReasoning", "supportsThinking", "isReasoningModel"]) ||
			record.thinkingDetails != null ||
			/-(low|medium|high|xhigh|max|thinking)(-fast)?$/.test(id);
		normalized.push({
			id,
			name: normalizeName(id, displayName),
			reasoning,
			contextWindow: firstNumber(record, ["contextWindow", "maxContextTokens", "context", "maxContext"], DEFAULT_CONTEXT_WINDOW),
			maxTokens: firstNumber(record, ["maxTokens", "maxOutputTokens", "maxOutput", "outputTokens"], DEFAULT_MAX_TOKENS),
			raw: item,
		});
	}
	return dedupeCursorModelVariants(normalized);
}

export async function discoverCursorModels(
	accessToken: string,
	options: DiscoverCursorModelsOptions = {},
): Promise<DiscoverCursorModelsResult> {
	const hash = tokenHash(accessToken);
	const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const cached = cache.get(hash);
	if (cached && Date.now() - cached.fetchedAt < ttl) {
		return { source: "cache", models: cached.models };
	}

	try {
		if (!options.bridge) {
			throw new Error("Cursor model bridge is not configured yet");
		}
		const raw = await options.bridge.getUsableModels(accessToken);
		const models = normalizeCursorModels(raw);
		if (models.length === 0) throw new Error("Cursor returned no usable models");
		cache.set(hash, { tokenHash: hash, fetchedAt: Date.now(), models });
		return { source: "live", models };
	} catch (error) {
		const warning = error instanceof Error ? error.message : String(error);
		return { source: "fallback", models: options.fallbackModels ?? FALLBACK_CURSOR_MODELS, warning };
	}
}

export function clearCursorModelDiscoveryCache(): void {
	cache.clear();
}
