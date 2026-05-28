import type { ProviderModelConfig } from "@bastani/atomic";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type CursorEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "thinking";
export type CursorSpeed = "fast";

export interface CursorModel {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	raw?: unknown;
	rawVariants?: CursorModel[];
}

export interface ParsedCursorEffortVariant {
	baseId: string;
	effort?: CursorEffort;
	speed?: CursorSpeed;
}

const EFFORT_ORDER: CursorEffort[] = ["none", "low", "medium", "high", "xhigh", "max", "thinking"];
const EFFORT_SUFFIXES = new Set<CursorEffort>(EFFORT_ORDER);
const CURSOR_THINKING_LEVEL_MAP = {
	minimal: "none",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
} satisfies Record<ThinkingLevel, CursorEffort>;

export function parseCursorEffortVariant(id: string): ParsedCursorEffortVariant {
	const parts = id.split("-");
	let speed: CursorSpeed | undefined;
	if (parts.at(-1) === "fast") {
		speed = "fast";
		parts.pop();
	}

	const last = parts.at(-1) as CursorEffort | undefined;
	if (last && EFFORT_SUFFIXES.has(last)) {
		parts.pop();
		return { baseId: parts.join("-"), effort: last, speed };
	}

	return { baseId: id, effort: undefined, speed: undefined };
}

function displayNameForBase(model: CursorModel, baseId: string): string {
	const parsed = parseCursorEffortVariant(model.id);
	let name = model.name.trim();
	if (parsed.effort) {
		name = name.replace(new RegExp(`\\s+${parsed.effort.replace("xhigh", "x high")}$`, "i"), "");
		name = name.replace(/\s+(low|medium|high|x\s*high|max|none|thinking)(\s+fast)?$/i, "");
	}
	name = name.replace(/\s+fast$/i, "").trim();
	return name || baseId;
}

function effortRank(parsed: ParsedCursorEffortVariant): number {
	return parsed.effort ? EFFORT_ORDER.indexOf(parsed.effort) : -1;
}

export function dedupeCursorModelVariants(models: CursorModel[]): CursorModel[] {
	const groups = new Map<string, CursorModel[]>();
	const order: string[] = [];
	for (const model of models) {
		const { baseId } = parseCursorEffortVariant(model.id);
		if (!groups.has(baseId)) {
			groups.set(baseId, []);
			order.push(baseId);
		}
		groups.get(baseId)!.push(model);
	}

	return order.map((baseId) => {
		const variants = groups.get(baseId)!;
		const parsedVariants = variants.map((variant) => ({ variant, parsed: parseCursorEffortVariant(variant.id) }));
		const representative = [...parsedVariants].sort((a, b) => {
			const rankDelta = effortRank(b.parsed) - effortRank(a.parsed);
			if (rankDelta !== 0) return rankDelta;
			return b.variant.contextWindow - a.variant.contextWindow || b.variant.maxTokens - a.variant.maxTokens;
		})[0]!.variant;
		const reasoning = parsedVariants.some(({ variant, parsed }) => variant.reasoning || parsed.effort !== undefined);
		return {
			id: baseId,
			name: displayNameForBase(representative, baseId),
			reasoning,
			contextWindow: Math.max(...variants.map((variant) => variant.contextWindow)),
			maxTokens: Math.max(...variants.map((variant) => variant.maxTokens)),
			rawVariants: variants,
		};
	});
}

export function mapAtomicThinkingLevelToCursorEffort(level: ThinkingLevel): CursorEffort {
	return CURSOR_THINKING_LEVEL_MAP[level];
}

function normalizeRequestedEffort(reasoningEffort: unknown): CursorEffort | undefined {
	if (typeof reasoningEffort !== "string") return undefined;
	if (EFFORT_SUFFIXES.has(reasoningEffort as CursorEffort)) return reasoningEffort as CursorEffort;
	return undefined;
}

function rankForEffort(effort: CursorEffort | undefined): number {
	return effort ? EFFORT_ORDER.indexOf(effort) : Number.POSITIVE_INFINITY;
}

interface ParsedCursorVariant {
	variant: CursorModel;
	parsed: ParsedCursorEffortVariant;
	order: number;
}

function parseCursorVariants(variants: CursorModel[]): ParsedCursorVariant[] {
	return variants.map((variant, order) => ({ variant, parsed: parseCursorEffortVariant(variant.id), order }));
}

function preferNonFast<T extends { parsed: ParsedCursorEffortVariant; order: number }>(a: T, b: T): number {
	const fastDelta = Number(a.parsed.speed === "fast") - Number(b.parsed.speed === "fast");
	return fastDelta || a.order - b.order;
}

function selectCursorVariant(requestedModelId: string, variants: CursorModel[], requestedEffort: CursorEffort | undefined): CursorModel {
	const requestedBaseId = parseCursorEffortVariant(requestedModelId).baseId;
	const parsedVariants = parseCursorVariants(variants);
	const matchingBaseVariants = parsedVariants.filter(({ parsed }) => parsed.baseId === requestedBaseId);
	const candidates = matchingBaseVariants.length > 0 ? matchingBaseVariants : parsedVariants;

	if (!requestedEffort) {
		const exact = candidates.find(({ variant }) => variant.id === requestedModelId);
		if (exact) return exact.variant;
		return [...candidates].sort((a, b) => {
			const rankDelta = rankForEffort(a.parsed.effort) - rankForEffort(b.parsed.effort);
			return rankDelta || preferNonFast(a, b);
		})[0]!.variant;
	}

	const requestedRank = EFFORT_ORDER.indexOf(requestedEffort);
	return [...candidates].sort((a, b) => {
		const aRank = rankForEffort(a.parsed.effort);
		const bRank = rankForEffort(b.parsed.effort);
		const distanceDelta = Math.abs(aRank - requestedRank) - Math.abs(bRank - requestedRank);
		return distanceDelta || aRank - bRank || preferNonFast(a, b);
	})[0]!.variant;
}

export function resolveCursorRequestModelId(
	models: CursorModel[],
	requestedModelId: string,
	reasoningEffort: unknown,
): string {
	const requested = models.find((model) => model.id === requestedModelId);
	if (!requested) return requestedModelId;
	if (!requested.rawVariants?.length) return requested.id;

	return selectCursorVariant(requestedModelId, requested.rawVariants, normalizeRequestedEffort(reasoningEffort)).id;
}

export function toProviderModels(models: CursorModel[]): ProviderModelConfig[] {
	return models.map((model) => ({
		id: model.id,
		name: model.name,
		api: "openai-completions",
		reasoning: model.reasoning,
		thinkingLevelMap: model.reasoning ? CURSOR_THINKING_LEVEL_MAP : undefined,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: model.reasoning,
			maxTokensField: "max_tokens",
			supportsStore: false,
			supportsUsageInStreaming: false,
		},
	}));
}
