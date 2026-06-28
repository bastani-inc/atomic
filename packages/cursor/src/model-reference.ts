import { getModels, getProviders } from "@earendil-works/pi-ai";

export interface CursorModelReferenceCandidate {
	readonly id: string;
	readonly displayName?: string;
}

export interface CursorModelReferenceLimits {
	readonly contextWindow?: number;
	readonly maxTokens?: number;
}

export interface CursorModelReferenceCatalogEntry {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly maxTokens: number;
}

interface ReferenceModelLimits {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly priority: number;
}

const ONE_MILLION_MODEL_NAME_CONTEXT_WINDOW = 1_000_000;
const UNRANKED_PROVIDER_PRIORITY = 10_000;
const CURSOR_EFFORT_SUFFIXES = ["none", "low", "medium", "high", "xhigh", "max", "default"] as const;
const CLAUDE_FAMILY_NAMES = new Set(["fable", "haiku", "opus", "sonnet"]);

const REFERENCE_PROVIDER_PRIORITY = new Map<string, number>([
	["opencode", 0],
	["opencode-go", 1],
	["anthropic", 10],
	["google", 20],
	["google-vertex", 21],
	["openai", 30],
	["openai-codex", 31],
	["azure-openai-responses", 32],
	["xai", 40],
	["moonshotai", 50],
	["moonshotai-cn", 51],
	["kimi-coding", 52],
	["zai", 60],
	["zai-coding-cn", 61],
	["openrouter", 100],
	["vercel-ai-gateway", 101],
	["cloudflare-ai-gateway", 102],
	["cloudflare-workers-ai", 103],
	["github-copilot", 200],
]);

const EMPTY_REFERENCE_MODEL_INDEX: ReadonlyMap<string, readonly ReferenceModelLimits[]> = new Map();
let referenceModelIndex: ReadonlyMap<string, readonly ReferenceModelLimits[]> | undefined;
let referenceModelCatalogOverride: readonly CursorModelReferenceCatalogEntry[] | undefined;

export function setCursorModelReferenceCatalogForTesting(models: readonly CursorModelReferenceCatalogEntry[] | undefined): void {
	referenceModelCatalogOverride = models;
	resetCursorModelReferenceIndex();
}

export function resetCursorModelReferenceIndex(): void {
	referenceModelIndex = undefined;
}

export function resolveCursorModelReferenceLimits(candidates: readonly CursorModelReferenceCandidate[]): CursorModelReferenceLimits {
	// Limit resolution must never affect which Cursor models register. Any failure
	// (e.g. an unexpected pi-ai catalog shape at runtime) degrades to "no reference
	// limits" so the caller keeps the model with its estimate.
	try {
		const explicitOneMillion = candidates.some((candidate) => hasOneMillionMarker(candidate.id) || hasOneMillionMarker(candidate.displayName ?? ""));
		const match = findReferenceModel(cursorCandidateAliases(candidates), explicitOneMillion);
		if (!match) {
			return explicitOneMillion ? { contextWindow: ONE_MILLION_MODEL_NAME_CONTEXT_WINDOW } : {};
		}
		const contextWindow = positiveIntOrUndefined(match.contextWindow);
		return {
			contextWindow: explicitOneMillion && contextWindow !== undefined
				? Math.max(contextWindow, ONE_MILLION_MODEL_NAME_CONTEXT_WINDOW)
				: contextWindow,
			maxTokens: positiveIntOrUndefined(match.maxTokens),
		};
	} catch {
		return {};
	}
}

export function positiveIntOrUndefined(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function findReferenceModel(aliases: readonly string[], preferOneMillion: boolean): ReferenceModelLimits | undefined {
	const index = getReferenceModelIndex();
	for (const alias of aliases) {
		const matches = index.get(alias);
		if (!matches?.[0]) continue;
		if (preferOneMillion) {
			const oneMillionMatch = matches.find((candidate) => candidate.contextWindow >= ONE_MILLION_MODEL_NAME_CONTEXT_WINDOW);
			if (oneMillionMatch) return oneMillionMatch;
		}
		return matches[0];
	}
	return undefined;
}

function getReferenceModelIndex(): ReadonlyMap<string, readonly ReferenceModelLimits[]> {
	if (referenceModelIndex) return referenceModelIndex;
	try {
		const mutableIndex = new Map<string, ReferenceModelLimits[]>();
		for (const model of getReferenceModels()) {
			for (const alias of referenceModelAliases(model)) {
				const existing = mutableIndex.get(alias) ?? [];
				existing.push(model);
				mutableIndex.set(alias, existing);
			}
		}
		for (const matches of mutableIndex.values()) {
			matches.sort(compareReferenceModels);
		}
		referenceModelIndex = mutableIndex;
	} catch {
		referenceModelIndex = EMPTY_REFERENCE_MODEL_INDEX;
	}
	return referenceModelIndex;
}

function getReferenceModels(): ReferenceModelLimits[] {
	return referenceModelCatalogOverride
		? referenceModelCatalogOverride.map((model) => toReferenceModelLimits(model, referenceProviderPriority(model.provider)))
		: getPiAiReferenceModels();
}

function getPiAiReferenceModels(): ReferenceModelLimits[] {
	const models: ReferenceModelLimits[] = [];
	for (const provider of getProviders()) {
		const priority = referenceProviderPriority(provider);
		for (const model of getModels(provider)) {
			if (!isPositiveFiniteNumber(model.contextWindow) || !isPositiveFiniteNumber(model.maxTokens)) continue;
			models.push(toReferenceModelLimits(model, priority));
		}
	}
	return models;
}

function referenceProviderPriority(provider: string): number {
	return REFERENCE_PROVIDER_PRIORITY.get(provider) ?? UNRANKED_PROVIDER_PRIORITY;
}

function toReferenceModelLimits(model: CursorModelReferenceCatalogEntry, priority: number): ReferenceModelLimits {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		priority,
	};
}

function compareReferenceModels(left: ReferenceModelLimits, right: ReferenceModelLimits): number {
	return left.priority - right.priority
		|| left.provider.localeCompare(right.provider)
		|| left.id.localeCompare(right.id)
		|| left.name.localeCompare(right.name);
}

function referenceModelAliases(model: ReferenceModelLimits): string[] {
	const aliases = new Set<string>();
	addNormalizedAlias(aliases, model.id);
	addNormalizedAlias(aliases, lastPathSegment(model.id));
	addNormalizedAlias(aliases, model.name);
	addNormalizedAlias(aliases, displayNameTail(model.name));
	return [...aliases];
}

function cursorCandidateAliases(candidates: readonly CursorModelReferenceCandidate[]): string[] {
	// Match strictly on Cursor model IDs, which already carry the family and
	// version (e.g. `gpt-5.5-high`, `claude-4.6-sonnet-medium`). Cursor display
	// names are short and generic ("Auto", "Sonnet 4") and would produce false
	// matches against unrelated pi-ai models, so they are not used as match keys.
	const aliases = new Set<string>();
	for (const candidate of candidates) {
		for (const alias of cursorIdAliases(candidate.id)) {
			addNormalizedAlias(aliases, alias);
		}
	}
	return [...aliases];
}

function cursorIdAliases(id: string): string[] {
	const aliases = new Set<string>([id]);
	for (const baseAlias of cursorBaseIdAliases(id)) {
		aliases.add(baseAlias);
		for (const claudeAlias of cursorClaudeIdAliases(baseAlias)) {
			aliases.add(claudeAlias);
		}
	}
	return [...aliases];
}

function cursorBaseIdAliases(id: string): string[] {
	const aliases = new Set<string>([id]);
	const withoutModes = stripTrailingCursorModes(id);
	aliases.add(withoutModes);
	const withoutEffort = stripTrailingEffort(withoutModes);
	aliases.add(withoutEffort);
	for (const alias of [...aliases]) {
		if (alias.endsWith("-1m")) aliases.add(alias.slice(0, -"-1m".length));
	}
	return [...aliases];
}

function stripTrailingCursorModes(id: string): string {
	let result = id;
	let changed = true;
	while (changed) {
		changed = false;
		if (result.endsWith("-fast")) {
			result = result.slice(0, -"-fast".length);
			changed = true;
		}
		if (result.endsWith("-thinking")) {
			result = result.slice(0, -"-thinking".length);
			changed = true;
		}
	}
	return result;
}

function stripTrailingEffort(id: string): string {
	for (const effort of CURSOR_EFFORT_SUFFIXES) {
		const suffix = `-${effort}`;
		if (id.endsWith(suffix)) return id.slice(0, -suffix.length);
	}
	return id;
}

function cursorClaudeIdAliases(id: string): string[] {
	const match = /^claude-(\d+(?:[.-]\d+)*)-([a-z]+)(?:$|-)/iu.exec(id);
	if (!match) return [];
	const [, version, family] = match;
	if (!version || !family || !CLAUDE_FAMILY_NAMES.has(family.toLowerCase())) return [];
	return [`claude-${family.toLowerCase()}-${version.replace(/[.-]/gu, "-")}`];
}

function addNormalizedAlias(aliases: Set<string>, value: string): void {
	const normalized = normalizeReferenceKey(value);
	if (normalized) aliases.add(normalized);
}

function normalizeReferenceKey(value: string): string | undefined {
	const normalized = value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/gu, "")
		.toLowerCase()
		.replace(/&/gu, " and ")
		.replace(/[^a-z0-9]+/gu, " ")
		.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function lastPathSegment(id: string): string {
	const parts = id.split("/");
	return parts[parts.length - 1] ?? id;
}

function displayNameTail(name: string): string {
	const parts = name.split(":");
	return parts[parts.length - 1]?.trim() ?? name;
}

function hasOneMillionMarker(value: string): boolean {
	return /(?:^|[^a-z0-9])1\s*m(?:$|[^a-z0-9])/iu.test(value);
}

function isPositiveFiniteNumber(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}
