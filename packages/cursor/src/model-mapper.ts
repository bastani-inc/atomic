import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { CURSOR_API, CURSOR_API_BASE_URL } from "./config.js";
import rawFallbackModels from "./cursor-models-raw.json" with { type: "json" };

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
	readonly primaryId: string;
	readonly displayName: string;
	readonly variants: readonly CursorVariant[];
}

const CURSOR_FALLBACK_RAW_MODELS = rawFallbackModels satisfies readonly CursorUsableModel[];
const PARSEABLE_EFFORTS: readonly Exclude<CursorEffort, "default">[] = ["none", "low", "medium", "high", "xhigh", "max"];
const EFFORT_ORDER: readonly CursorEffort[] = ["none", "low", "default", "medium", "high", "xhigh", "max"];
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
		note: "static fallback; Cursor private API metadata and limits are estimated; token costs are reported as zero for subscription usage",
		models: CURSOR_FALLBACK_RAW_MODELS.map((model) => ({
			...model,
			supportsReasoning: supportsReasoningModelId(model.id),
			...(model.id.endsWith("-thinking") || model.id.includes("-thinking-") ? { supportsThinking: true } : {}),
		})),
	};
}

export function mapCursorCatalogToProviderModels(catalog: CursorModelCatalog): CursorProviderModelDefinition[] {
	return groupCursorModels(catalog.models).map((group) => {
		const effortVariants = collectEffortVariants(group.variants, group.primaryId);
		const supportsEffort = group.variants.some((variant) => Boolean(variant.effort)) || effortVariants.size >= 2;
		const supportsReasoning = supportsReasoningModelId(group.primaryId);
		const name = catalog.source === "estimated" ? `${group.displayName} (estimated)` : group.displayName;
		return {
			id: group.primaryId,
			name,
			api: CURSOR_API,
			baseUrl: CURSOR_API_BASE_URL,
			reasoning: supportsReasoning,
			thinkingLevelMap: supportsEffort ? buildThinkingLevelMap(effortVariants, group.primaryId) : undefined,
			input: ["text"],
			cost: subscriptionCost(),
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
	const mapped = thinkingLevelMap[thinkingLevel];
	if (!mapped || mapped === "default") return baseModelId;
	if (isCursorEffort(mapped)) return replaceEffortBeforeCursorSuffix(baseModelId, mapped);
	return mapped;
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

function replaceEffortBeforeCursorSuffix(modelId: string, effort: CursorEffort): string {
	if (effort === "default") return modelId;
	const variant = parseCursorVariant({ id: modelId });
	return `${variant.baseId}-${effort}${variant.thinking ? "-thinking" : ""}${variant.fast ? "-fast" : ""}`;
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
	const effort = PARSEABLE_EFFORTS.find((candidate) => base.endsWith(`-${candidate}`));
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
		const key = cursorVariantGroupKey(variant);
		const existing = groups.get(key) ?? [];
		existing.push(variant);
		groups.set(key, existing);
	}
	return [...groups.values()]
		.map((variants) => {
			const baseId = variants[0]?.baseId ?? "cursor";
			const primaryId = choosePrimaryId(variants, baseId);
			return {
				baseId,
				primaryId,
				displayName: chooseDisplayName(variants, baseId, primaryId),
				variants,
			};
		})
		.sort((left, right) => left.primaryId.localeCompare(right.primaryId));
}

function cursorVariantGroupKey(variant: CursorVariant): string {
	return `${variant.baseId}|fast=${variant.fast ? "1" : "0"}|thinking=${variant.thinking ? "1" : "0"}`;
}

function collectEffortVariants(variants: readonly CursorVariant[], primaryId: string): ReadonlyMap<CursorEffort, string> {
	const byEffort = new Map<CursorEffort, string>();
	for (const variant of variants) {
		const effort = variant.effort ?? (variant.id === primaryId || variant.supportsReasoning || variant.supportsThinking || variant.thinking ? "default" : undefined);
		if (effort && !byEffort.has(effort)) byEffort.set(effort, variant.id);
	}
	return byEffort;
}

function buildThinkingLevelMap(effortVariants: ReadonlyMap<CursorEffort, string>, primaryId: string): ThinkingLevelMap {
	return {
		minimal: chooseEffortVariant(effortVariants, THINKING_LEVEL_EFFORT_PREFERENCES.minimal, primaryId),
		low: chooseEffortVariant(effortVariants, THINKING_LEVEL_EFFORT_PREFERENCES.low, primaryId),
		medium: chooseEffortVariant(effortVariants, THINKING_LEVEL_EFFORT_PREFERENCES.medium, primaryId),
		high: chooseEffortVariant(effortVariants, THINKING_LEVEL_EFFORT_PREFERENCES.high, primaryId),
		xhigh: chooseEffortVariant(effortVariants, THINKING_LEVEL_EFFORT_PREFERENCES.xhigh, primaryId),
	};
}

function chooseEffortVariant(effortVariants: ReadonlyMap<CursorEffort, string>, preferences: readonly CursorEffort[], _primaryId: string): string | null {
	for (const effort of preferences) {
		const variantId = effortVariants.get(effort);
		if (variantId) return variantId;
	}
	for (const effort of EFFORT_ORDER) {
		const variantId = effortVariants.get(effort);
		if (variantId) return variantId;
	}
	return null;
}

function isCursorEffort(value: string): value is CursorEffort {
	return value === "default" || (PARSEABLE_EFFORTS as readonly string[]).includes(value);
}

function chooseLargestNumber(values: readonly (number | undefined)[]): number | undefined {
	const finiteValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	return finiteValues.length > 0 ? Math.max(...finiteValues) : undefined;
}

function choosePrimaryId(variants: readonly CursorVariant[], baseId: string): string {
	if (variants.some((variant) => variant.effort)) {
		const representative = variants[0];
		return `${baseId}${representative?.thinking ? "-thinking" : ""}${representative?.fast ? "-fast" : ""}`;
	}
	return variants.find((variant) => variant.id === baseId)?.id ?? variants[0]?.id ?? baseId;
}

function chooseDisplayName(variants: readonly CursorVariant[], baseId: string, primaryId: string): string {
	return variants.find((variant) => variant.id === primaryId)?.displayName
		?? variants.find((variant) => variant.effort === "medium")?.displayName
		?? variants.find((variant) => !variant.effort)?.displayName
		?? variants[0]?.displayName
		?? titleCaseModelId(baseId);
}

function supportsReasoningModelId(id: string): boolean {
	const variant = parseCursorVariant({ id });
	if (variant.effort || variant.thinking) return true;
	if (variant.baseId === "default") return true;
	return /^(claude|composer|gemini|gpt|grok|kimi)(-|$)/iu.test(variant.baseId);
}

function titleCaseModelId(id: string): string {
	return id
		.split(/[-_/]+/u)
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function subscriptionCost(): { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
