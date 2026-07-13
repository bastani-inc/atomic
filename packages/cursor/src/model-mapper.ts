import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai/compat";
import { CURSOR_API, CURSOR_API_BASE_URL } from "./config.js";
import rawFallbackModels from "./cursor-models-raw.json" with { type: "json" };
import type { CursorParameterDefinitionMetadata } from "./model-display.js";
import { cursorModelAliases, groupCursorModels, selectDefaultVariant, titleCaseModelId } from "./model-groups.js";
import { positiveIntOrUndefined } from "./model-reference.js";

export type CursorCatalogSource = "live" | "estimated";
export type CursorEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "extra-high" | "max" | "default";
export type CursorMetadataProvenance = "available-models-reverse-engineered" | "get-usable-models" | "legacy-cache" | "static-fallback";

export interface CursorModelParameter { readonly id: string; readonly value: string }
export type { CursorParameterDefinitionMetadata, CursorParameterOptionMetadata } from "./model-display.js";
export interface CursorParameterizedVariant {
	readonly parameters: readonly CursorModelParameter[];
	readonly isMaxMode: boolean;
	readonly isDefaultMaxConfig?: boolean;
	readonly isDefaultNonMaxConfig?: boolean;
	readonly displayName?: string;
	readonly displayNameOutsidePicker?: string;
	readonly variantStringRepresentation?: string;
}

export interface CursorUsableModel {
	readonly id: string;
	readonly name?: string;
	readonly displayName?: string;
	readonly contextWindow?: number;
	readonly maxModeContextWindow?: number;
	readonly maxTokens?: number;
	readonly supportsReasoning?: boolean;
	readonly supportsThinking?: boolean;
	readonly supportsImages?: boolean;
	readonly supportsMaxMode?: boolean;
	readonly supportsNonMaxMode?: boolean;
	readonly serverModelName?: string;
	readonly variants?: readonly CursorParameterizedVariant[];
	readonly parameterDefinitions?: readonly CursorParameterDefinitionMetadata[];
	readonly metadataProvenance?: CursorMetadataProvenance;
	readonly effort?: CursorEffort;
	readonly requestedModelId?: string;
	readonly requestedMaxMode?: boolean;
	readonly isDefaultVariant?: boolean;
	readonly parameters?: readonly CursorModelParameter[];
	/** Internal identity retained while expanding one raw Cursor model into selectable rows. */
	readonly sourceModelId?: string;
}

export interface CursorModelCatalog {
	readonly source: CursorCatalogSource;
	readonly fetchedAt: number;
	readonly credentialScope?: string;
	readonly note?: string;
	readonly models: readonly CursorUsableModel[];
}

export type CursorModelInput = ["text"] | ["text", "image"];

export interface CursorModelRouting {
	readonly modelId: string;
	readonly maxMode?: boolean;
	readonly parameters?: readonly CursorModelParameter[];
}

export interface CursorProviderModelDefinition {
	readonly id: string;
	readonly name: string;
	readonly api?: string;
	readonly baseUrl?: string;
	readonly reasoning: boolean;
	readonly thinkingLevelMap?: ThinkingLevelMap;
	readonly input: CursorModelInput;
	readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
	readonly contextWindow: number;
	readonly contextWindowOptions?: readonly number[];
	readonly maxTokens: number;
	readonly metadataProvenance: { readonly catalog: CursorCatalogSource; readonly capabilities: string; readonly contextWindow: string; readonly maxTokens: string };
	readonly compat?: {
		readonly cursorRouting?: Readonly<Record<string, CursorModelRouting>>;
		readonly cursorModelAliases?: readonly string[];
		readonly cursorMetadataProvenance?: CursorProviderModelDefinition["metadataProvenance"];
	};
}

export interface CursorVariant {
	readonly id: string;
	readonly baseId: string;
	readonly sourceModelId: string;
	readonly displayName: string;
	readonly effort?: CursorEffort;
	readonly fast: boolean;
	readonly thinking: boolean;
	readonly contextWindow?: number;
	readonly maxModeContextWindow?: number;
	readonly maxTokens?: number;
	readonly supportsReasoning?: boolean;
	readonly supportsThinking?: boolean;
	readonly isDefaultVariant?: boolean;
	readonly supportsImages?: boolean;
	readonly metadataProvenance?: CursorMetadataProvenance;
	readonly routing: CursorModelRouting;
	readonly parameterized: boolean;
	readonly parameterDefinitions?: readonly CursorParameterDefinitionMetadata[];
}

export interface CursorVariantGroup {
	readonly baseId: string;
	readonly primaryId: string;
	readonly displayName: string;
	readonly variants: readonly CursorVariant[];
}

const CURSOR_FALLBACK_RAW_MODELS = rawFallbackModels satisfies readonly { readonly id: string; readonly name?: string }[];
const PARSEABLE_EFFORTS: readonly Exclude<CursorEffort, "default">[] = ["none", "minimal", "low", "medium", "high", "xhigh", "extra-high", "max"];
const ESTIMATED_CONTEXT_WINDOW = 200_000;
const ESTIMATED_MAX_TOKENS = 64_000;

export function createEstimatedCursorCatalog(now = Date.now()): CursorModelCatalog {
	return {
		source: "estimated",
		fetchedAt: now,
		note: "static compatibility fallback; IDs are a bundled snapshot, capabilities are conservative, and 200k/64k are operational budgets rather than asserted Cursor limits",
		models: CURSOR_FALLBACK_RAW_MODELS.map((model) => ({
			...model,
			metadataProvenance: "static-fallback" as const,
		})),
	};
}

export function mapCursorCatalogToProviderModels(catalog: CursorModelCatalog): CursorProviderModelDefinition[] {
	const expandedModels = expandParameterizedModels(catalog.models);
	const groupedModels = catalog.source === "estimated" ? annotateCompatibilityEffortSets(expandedModels) : expandedModels;
	const groups = groupCursorModels(groupedModels.map(parseCursorVariant));
	return groups.map((group) => {
		const effortVariants = collectEffortVariants(group.variants);
		const supportsReasoning = catalog.source === "live" && (effortVariants.size > 0 || group.variants.some((variant) => variant.supportsReasoning === true || variant.supportsThinking === true || variant.thinking));
		const limitVariant = selectDefaultVariant(group.variants);
		const explicitContext = positiveIntOrUndefined(limitVariant?.contextWindow);
		const explicitMaxContext = positiveIntOrUndefined(limitVariant?.maxModeContextWindow);
		const explicitOutput = positiveIntOrUndefined(limitVariant?.maxTokens);
		const contextWindow = positiveIntLimit(explicitContext, ESTIMATED_CONTEXT_WINDOW);
		const maxTokens = positiveIntLimit(explicitOutput, ESTIMATED_MAX_TOKENS);
		const thinkingLevelMap = supportsReasoning && effortVariants.size > 0
			? buildCursorThinkingLevelMap(effortVariants)
			: supportsReasoning ? unsupportedCursorThinkingLevelMap() : undefined;
		const capabilities = capabilityProvenance(group.variants, catalog.source);
		const contextProvenance = limitFieldProvenance(limitVariant, explicitContext, "context");
		const outputProvenance = limitFieldProvenance(limitVariant, explicitOutput, "output");
		return {
			id: group.primaryId,
			name: catalog.source === "estimated" ? `${group.displayName} (estimated fallback)` : group.displayName,
			api: CURSOR_API,
			baseUrl: CURSOR_API_BASE_URL,
			reasoning: supportsReasoning,
			thinkingLevelMap,
			input: group.variants.some((variant) => variant.supportsImages === true) ? ["text", "image"] : ["text"],
			cost: subscriptionCost(),
			contextWindow,
			...(explicitMaxContext && explicitMaxContext !== contextWindow ? { contextWindowOptions: [contextWindow, explicitMaxContext] } : {}),
			maxTokens,
			metadataProvenance: {
				catalog: catalog.source,
				capabilities,
				contextWindow: contextProvenance,
				maxTokens: outputProvenance,
			},
			compat: {
				cursorRouting: buildRoutingMap(group),
				cursorModelAliases: cursorModelAliases(group),
				cursorMetadataProvenance: {
					catalog: catalog.source,
					capabilities,
					contextWindow: contextProvenance,
					maxTokens: outputProvenance,
				},
			},
		};
	});
}

function positiveIntLimit(value: number | undefined, fallback: number): number {
	// Provider registration rejects non-positive/non-integer windows and would
	// drop the whole catalog; guarantee a valid positive integer here so limit
	// values can never affect which Cursor models are listed.
	return positiveIntOrUndefined(value) ?? fallback;
}

export function resolveCursorModelVariant(
	baseModelId: string,
	thinkingLevelMap: ThinkingLevelMap | undefined,
	thinkingLevel: ModelThinkingLevel | undefined,
	useProviderDefault = false,
): string {
	if (!thinkingLevelMap || (thinkingLevel === undefined && useProviderDefault)) return baseModelId;
	const requestedLevel = thinkingLevel ?? "off";
	const mapped = thinkingLevelMap[requestedLevel];
	if (typeof mapped === "string" && mapped !== "default") return mapped;
	throw new Error(`Cursor model ${baseModelId} does not support the requested ${requestedLevel} reasoning level.`);
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
	const effort = model.effort;
	if (effort) base = base.slice(0, -effort.length - 1);
	return {
		id: model.id,
		baseId: base,
		sourceModelId: model.sourceModelId ?? base,
		displayName: model.displayName ?? model.name ?? titleCaseModelId(base),
		effort,
		fast,
		thinking,
		contextWindow: model.contextWindow,
		maxModeContextWindow: model.maxModeContextWindow,
		maxTokens: model.maxTokens,
		supportsReasoning: model.supportsReasoning,
		supportsThinking: model.supportsThinking,
		supportsImages: model.supportsImages,
		metadataProvenance: model.metadataProvenance,
		parameterized: model.sourceModelId !== undefined && model.parameters !== undefined,
		parameterDefinitions: model.parameterDefinitions,
		isDefaultVariant: model.isDefaultVariant,
		routing: {
			modelId: cursorBackendModelId(model),
			...(model.requestedMaxMode !== undefined ? { maxMode: model.requestedMaxMode } : {}),
			...(model.parameters ? { parameters: model.parameters } : {}),
		},
	};
}

function collectEffortVariants(variants: readonly CursorVariant[]): ReadonlyMap<CursorEffort, string> {
	const byEffort = new Map<CursorEffort, string>();
	for (const variant of variants) if (variant.effort && !byEffort.has(variant.effort)) byEffort.set(variant.effort, variant.id);
	return byEffort;
}

function buildCursorThinkingLevelMap(effortVariants: ReadonlyMap<CursorEffort, string>): ThinkingLevelMap {
	return {
		off: effortVariants.get("none") ?? null,
		minimal: effortVariants.get("minimal") ?? null,
		low: effortVariants.get("low") ?? null,
		medium: effortVariants.get("medium") ?? null,
		high: effortVariants.get("high") ?? null,
		xhigh: effortVariants.get("xhigh") ?? effortVariants.get("extra-high") ?? null,
		max: effortVariants.get("max") ?? null,
	};
}

function unsupportedCursorThinkingLevelMap(): ThinkingLevelMap {
	return { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
}

function buildRoutingMap(group: CursorVariantGroup): Readonly<Record<string, CursorModelRouting>> {
	const routing: Record<string, CursorModelRouting> = {};
	for (const variant of group.variants) routing[variant.id] = variant.routing;
	if (group.variants.some((variant) => variant.parameterized)) routing[group.primaryId] = selectDefaultVariant(group.variants).routing;
	else routing[group.primaryId] ??= { modelId: group.primaryId };
	return routing;
}

function capabilityProvenance(variants: readonly CursorVariant[], source: CursorCatalogSource): string {
	if (variants.some((variant) => variant.metadataProvenance === "available-models-reverse-engineered")) return "Cursor AvailableModels (reverse-engineered, account snapshot)";
	if (variants.some((variant) => variant.metadataProvenance === "legacy-cache")) return "legacy cached live snapshot; original capability provenance unavailable";
	return source === "live" ? "Cursor GetUsableModels account snapshot" : "bundled static compatibility snapshot";
}

function limitFieldProvenance(variant: CursorVariant | undefined, value: number | undefined, field: "context" | "output"): string {
	if (value === undefined) return "conservative operational fallback; exact limit unknown";
	if (variant?.metadataProvenance === "available-models-reverse-engineered") {
		return field === "context" ? "Cursor AvailableModels model/mode field" : "Cursor AvailableModels model/mode output field";
	}
	if (variant?.metadataProvenance === "get-usable-models") return "Cursor GetUsableModels account snapshot field";
	if (variant?.metadataProvenance === "legacy-cache") return "legacy cached live snapshot field; original provenance unavailable";
	if (variant?.metadataProvenance === "static-fallback") return "bundled static compatibility value; exact Cursor limit not asserted";
	return "live catalog field; endpoint provenance unavailable";
}

function annotateCompatibilityEffortSets(models: readonly CursorUsableModel[]): CursorUsableModel[] {
	const candidates = models.map((model) => ({ model, parsed: compatibilityEffortCandidate(model.id) }));
	const effortsByGroup = new Map<string, Set<CursorEffort>>();
	for (const { parsed } of candidates) {
		if (!parsed) continue;
		const efforts = effortsByGroup.get(parsed.group) ?? new Set<CursorEffort>();
		efforts.add(parsed.effort);
		effortsByGroup.set(parsed.group, efforts);
	}
	return candidates.map(({ model, parsed }) => parsed && (effortsByGroup.get(parsed.group)?.size ?? 0) >= 2
		? { ...model, effort: parsed.effort }
		: model);
}

function compatibilityEffortCandidate(id: string): { readonly group: string; readonly effort: CursorEffort } | undefined {
	let base = id;
	let mode = "";
	for (const suffix of ["-fast", "-thinking"] as const) {
		if (!base.endsWith(suffix)) continue;
		base = base.slice(0, -suffix.length);
		mode = `${suffix}${mode}`;
	}
	const effort = PARSEABLE_EFFORTS.find((candidate) => base.endsWith(`-${candidate}`));
	if (!effort) return undefined;
	return { group: `${base.slice(0, -effort.length - 1)}${mode}`, effort };
}

function expandParameterizedModels(models: readonly CursorUsableModel[]): CursorUsableModel[] {
	return models.flatMap((model) => {
		if (!model.variants || model.variants.length === 0) {
			if (model.supportsMaxMode === true) return expandModelLevelMaxModes(model);
			return [model];
		}
		const rows = model.variants.flatMap((variant) => parameterizedVariantRow(model, variant));
		return rows.length > 0 ? rows : [{ ...model, supportsReasoning: false }];
	});
}

function expandModelLevelMaxModes(model: CursorUsableModel): CursorUsableModel[] {
	const maxRow: CursorUsableModel = {
		...model,
		id: `${model.id}-max-mode`,
		contextWindow: model.maxModeContextWindow ?? model.contextWindow,
		maxModeContextWindow: undefined,
		requestedModelId: cursorBackendModelId(model),
		requestedMaxMode: true,
	};
	if (model.supportsNonMaxMode === false) return [maxRow];
	return [{
		...model,
		maxModeContextWindow: undefined,
		requestedModelId: cursorBackendModelId(model),
		requestedMaxMode: false,
	}, maxRow];
}

function parameterizedVariantRow(model: CursorUsableModel, variant: CursorParameterizedVariant): CursorUsableModel[] {
	const parameters = variant.parameters.filter((parameter) => parameter.id.length > 0 && parameter.value.length > 0);
	const effortParameter = parameters.find((parameter) => parameter.id === "reasoning" || parameter.id === "effort");
	const effort = effortParameter ? cursorEffortFromValue(effortParameter.value) : undefined;
	// Unknown reasoning vocabularies remain part of a separately routed preset,
	// but are not mapped onto any Atomic reasoning level.
	const fast = parameters.some((parameter) => parameter.id === "fast" && parameter.value === "true");
	const thinking = parameters.some((parameter) => parameter.id === "thinking" && parameter.value === "true");
	const semanticParameters = parameters.filter((parameter) => {
		if (parameter.id === "fast" || parameter.id === "thinking") return false;
		return parameter !== effortParameter || effort === undefined;
	});
	const semanticBase = `${model.id}${semanticParameters.map(parameterIdPart).join("")}${variant.isMaxMode ? "-max-mode" : ""}`;
	const id = `${semanticBase}${effort ? `-${effort}` : ""}${thinking ? "-thinking" : ""}${fast ? "-fast" : ""}`;
	return [{
		...model,
		id,
		displayName: variant.displayNameOutsidePicker ?? variant.displayName ?? model.displayName,
		contextWindow: variant.isMaxMode ? model.maxModeContextWindow ?? model.contextWindow : model.contextWindow,
		maxModeContextWindow: undefined,
		supportsReasoning: Boolean(effortParameter || thinking),
		supportsThinking: thinking,
		effort,
		requestedModelId: cursorBackendModelId(model),
		isDefaultVariant: variant.isMaxMode ? variant.isDefaultMaxConfig === true : variant.isDefaultNonMaxConfig === true,
		requestedMaxMode: variant.isMaxMode,
		parameters,
		sourceModelId: model.id,
	}];
}

function cursorBackendModelId(model: CursorUsableModel): string {
	return model.requestedModelId ?? model.serverModelName ?? model.id;
}

function cursorEffortFromValue(value: string): CursorEffort | undefined {
	if (value === "extra-high") return "extra-high";
	return (PARSEABLE_EFFORTS as readonly string[]).includes(value) ? value as CursorEffort : undefined;
}

function parameterIdPart(parameter: CursorModelParameter): string {
	return `-${encodeParameterComponent(parameter.id)}-${encodeParameterComponent(parameter.value)}`;
}

function encodeParameterComponent(value: string): string {
	let encoded = "";
	for (const byte of new TextEncoder().encode(value)) {
		const isAsciiAlphaNumeric = (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
		encoded += isAsciiAlphaNumeric ? String.fromCharCode(byte) : `_${byte.toString(16).padStart(2, "0")}`;
	}
	return encoded;
}

function subscriptionCost(): { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
