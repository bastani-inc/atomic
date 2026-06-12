import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { CURSOR_API, CURSOR_API_BASE_URL, CURSOR_DEFAULT_MODEL_ID } from "./config.js";

export type CursorCatalogSource = "live" | "estimated";
export type CursorEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "default";

export interface CursorUsableModel {
	readonly id: string;
	readonly name?: string;
	readonly displayName?: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly supportsReasoning?: boolean;
	readonly supportsThinking?: boolean;
}

export interface CursorModelCatalog {
	readonly source: CursorCatalogSource;
	readonly fetchedAt: number;
	readonly note?: string;
	readonly models: readonly CursorUsableModel[];
}

export interface CursorProviderModelDefinition {
	readonly id: string;
	readonly name: string;
	readonly api?: string;
	readonly baseUrl?: string;
	readonly reasoning: boolean;
	readonly thinkingLevelMap?: ThinkingLevelMap;
	readonly input: ["text"];
	readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
	readonly contextWindow: number;
	readonly maxTokens: number;
}

interface CursorVariant {
	readonly id: string;
	readonly baseId: string;
	readonly displayName: string;
	readonly effort?: CursorEffort;
	readonly fast: boolean;
	readonly thinking: boolean;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly supportsReasoning?: boolean;
	readonly supportsThinking?: boolean;
}

interface CursorVariantGroup {
	readonly baseId: string;
	readonly displayName: string;
	readonly variants: readonly CursorVariant[];
}

const EFFORTS: readonly CursorEffort[] = ["default", "none", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVEL_EFFORT_PREFERENCES: Record<ThinkingLevel, readonly CursorEffort[]> = {
	minimal: ["none", "low", "default"],
	low: ["low", "none", "default"],
	medium: ["medium", "default", "low"],
	high: ["high", "medium", "default"],
	xhigh: ["max", "xhigh", "high"],
};

const ESTIMATED_CONTEXT_WINDOW = 200_000;
const ESTIMATED_MAX_TOKENS = 64_000;

export function createEstimatedCursorCatalog(now = Date.now()): CursorModelCatalog {
	return {
		source: "estimated",
		fetchedAt: now,
		note: "static fallback; Cursor private API metadata, costs, and limits are estimated",
		models: [
			{ id: CURSOR_DEFAULT_MODEL_ID, displayName: "Composer 2", supportsReasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
			{ id: `${CURSOR_DEFAULT_MODEL_ID}-low`, displayName: "Composer 2 Low", supportsReasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
			{ id: `${CURSOR_DEFAULT_MODEL_ID}-medium`, displayName: "Composer 2 Medium", supportsReasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
			{ id: `${CURSOR_DEFAULT_MODEL_ID}-high`, displayName: "Composer 2 High", supportsReasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
			{ id: `${CURSOR_DEFAULT_MODEL_ID}-max`, displayName: "Composer 2 Max", supportsReasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
			{ id: "claude-4.5-sonnet", displayName: "Claude Sonnet 4.5", supportsReasoning: true, contextWindow: 200_000, maxTokens: 32_000 },
			{ id: "gpt-5.1", displayName: "GPT-5.1", supportsReasoning: true, contextWindow: 128_000, maxTokens: 16_384 },
		],
	};
}

export function mapCursorCatalogToProviderModels(catalog: CursorModelCatalog): CursorProviderModelDefinition[] {
	return groupCursorModels(catalog.models).map((group) => {
		const efforts = collectEfforts(group.variants);
		const supportsReasoning = group.variants.some((variant) => Boolean(variant.supportsReasoning || variant.supportsThinking || variant.thinking || variant.effort));
		const name = catalog.source === "estimated" ? `${group.displayName} (estimated)` : group.displayName;
		return {
			id: group.baseId,
			name,
			api: CURSOR_API,
			baseUrl: CURSOR_API_BASE_URL,
			reasoning: supportsReasoning,
			thinkingLevelMap: supportsReasoning ? buildThinkingLevelMap(efforts) : undefined,
			input: ["text"],
			cost: estimateCost(group.baseId),
			contextWindow: chooseLargestNumber(group.variants.map((variant) => variant.contextWindow)) ?? ESTIMATED_CONTEXT_WINDOW,
			maxTokens: chooseLargestNumber(group.variants.map((variant) => variant.maxTokens)) ?? ESTIMATED_MAX_TOKENS,
		};
	});
}

export function resolveCursorModelVariant(
	baseModelId: string,
	thinkingLevelMap: ThinkingLevelMap | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): string {
	if (!thinkingLevel || !thinkingLevelMap) return baseModelId;
	const mappedEffort = thinkingLevelMap[thinkingLevel];
	if (!mappedEffort || mappedEffort === "default") return baseModelId;
	return insertEffortBeforeCursorSuffix(baseModelId, mappedEffort as CursorEffort);
}

export function insertEffortBeforeCursorSuffix(modelId: string, effort: CursorEffort): string {
	if (effort === "default") return modelId;
	let base = modelId;
	let fast = false;
	let thinking = false;
	if (base.endsWith("-fast")) {
		fast = true;
		base = base.slice(0, -"-fast".length);
	}
	if (base.endsWith("-thinking")) {
		thinking = true;
		base = base.slice(0, -"-thinking".length);
	}
	return `${base}-${effort}${thinking ? "-thinking" : ""}${fast ? "-fast" : ""}`;
}

export function parseCursorVariant(model: CursorUsableModel): CursorVariant {
	let base = model.id;
	let fast = false;
	let thinking = false;
	if (base.endsWith("-fast")) {
		fast = true;
		base = base.slice(0, -"-fast".length);
	}
	if (base.endsWith("-thinking")) {
		thinking = true;
		base = base.slice(0, -"-thinking".length);
	}
	const effort = EFFORTS.find((candidate) => base.endsWith(`-${candidate}`));
	if (effort) {
		base = base.slice(0, -effort.length - 1);
	}
	return {
		id: model.id,
		baseId: base,
		displayName: model.displayName ?? model.name ?? titleCaseModelId(base),
		effort,
		fast,
		thinking,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		supportsReasoning: model.supportsReasoning,
		supportsThinking: model.supportsThinking,
	};
}

function groupCursorModels(models: readonly CursorUsableModel[]): CursorVariantGroup[] {
	const groups = new Map<string, CursorVariant[]>();
	for (const model of models) {
		const variant = parseCursorVariant(model);
		const existing = groups.get(variant.baseId) ?? [];
		existing.push(variant);
		groups.set(variant.baseId, existing);
	}
	return [...groups.entries()]
		.map(([baseId, variants]) => ({
			baseId,
			displayName: chooseDisplayName(variants, baseId),
			variants,
		}))
		.sort((left, right) => left.baseId.localeCompare(right.baseId));
}

function collectEfforts(variants: readonly CursorVariant[]): readonly CursorEffort[] {
	const efforts = new Set<CursorEffort>();
	for (const variant of variants) {
		if (variant.effort) efforts.add(variant.effort);
	}
	if (efforts.size === 0 && variants.some((variant) => variant.thinking || variant.supportsReasoning || variant.supportsThinking)) {
		efforts.add("default");
	}
	return [...efforts];
}

function buildThinkingLevelMap(efforts: readonly CursorEffort[]): ThinkingLevelMap {
	const fallbackEfforts: readonly CursorEffort[] = ["default"];
	const available: ReadonlySet<CursorEffort> = new Set<CursorEffort>(efforts.length > 0 ? efforts : fallbackEfforts);
	return {
		minimal: chooseEffort(available, THINKING_LEVEL_EFFORT_PREFERENCES.minimal),
		low: chooseEffort(available, THINKING_LEVEL_EFFORT_PREFERENCES.low),
		medium: chooseEffort(available, THINKING_LEVEL_EFFORT_PREFERENCES.medium),
		high: chooseEffort(available, THINKING_LEVEL_EFFORT_PREFERENCES.high),
		xhigh: chooseEffort(available, THINKING_LEVEL_EFFORT_PREFERENCES.xhigh),
	};
}

function chooseEffort(available: ReadonlySet<CursorEffort>, preferences: readonly CursorEffort[]): string | null {
	return preferences.find((effort) => available.has(effort)) ?? null;
}

function chooseLargestNumber(values: readonly (number | undefined)[]): number | undefined {
	const finiteValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	return finiteValues.length > 0 ? Math.max(...finiteValues) : undefined;
}

function chooseDisplayName(variants: readonly CursorVariant[], baseId: string): string {
	return variants.find((variant) => variant.id === baseId)?.displayName ?? variants[0]?.displayName ?? titleCaseModelId(baseId);
}

function titleCaseModelId(id: string): string {
	return id
		.split(/[-_/]+/u)
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function estimateCost(modelId: string): { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } {
	const lower = modelId.toLowerCase();
	if (lower.includes("opus")) return { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
	if (lower.includes("sonnet") || lower.includes("composer")) return { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
	if (lower.includes("haiku")) return { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
	if (lower.includes("gpt-5")) return { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 };
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
