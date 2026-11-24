import type {
	CompactionForm,
	CompactionModelKind,
	CompactOptions,
	CompactorApi,
	CompactorModel,
	CompactorRequest,
	KnownCompactorApi,
	ProviderCompactorModelConfig,
	SessionBeforeCompactResult,
	SessionCompactOptions,
	VerbatimCompactionParameters,
	VerbatimCompactionResult,
} from "../../src/index.ts";
import {
	COMPACTED_OUTPUT_MAX_TRIGGER_SHARE,
	COMPACTOR_LINE_WIDTH,
	classifyCompactionModel,
	compactedOutputTokenCap,
	estimateTextTokens,
	wrapLongLines,
} from "../../src/index.ts";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Expect<Value extends true> = Value;

export type CompactionForms = Expect<Equal<CompactionForm, "cleared" | "compacted">>;
export type CompactionParameters = Expect<Equal<VerbatimCompactionParameters, { query: string }>>;
export type ResultForm = Expect<Equal<VerbatimCompactionResult["form"], CompactionForm>>;
export type ResultBackend = Expect<Equal<VerbatimCompactionResult["backend"], "compactor" | "extension" | undefined>>;
export type CompactionModelKinds = Expect<
	Equal<CompactionModelKind, "auto" | "compactor" | "chat" | "classifier" | "unknown">
>;
export type KnownCompactorApis = Expect<Equal<KnownCompactorApi, "morph-compact">>;

export const customCompactorModel: CompactorModel = {
	id: "compact-v2",
	name: "Internal Compactor v2",
	type: "compactor",
	api: "custom-compact" as CompactorApi,
	provider: "my-compactor",
	baseUrl: "https://compact.example.com/v1",
	endpointPath: "/compress",
	compactionParams: { target_ratio: 0.4, preserve_recent: 2 },
	timeoutMs: 180_000,
	maxTokens: 48_000,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export const providerCompactorConfig: ProviderCompactorModelConfig = {
	id: "compact-v2",
	name: "Internal Compactor v2",
	type: "compactor",
	api: "custom-compact",
	endpointPath: "/compress",
	compactionParams: { target_ratio: 0.4 },
	timeoutMs: 180_000,
	maxTokens: 48_000,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export const compactorRequestShape: CompactorRequest = {
	apiKey: "key",
	api: "custom-compact",
	modelId: "compact-v2",
	baseUrl: "https://compact.example.com/v1",
	endpointPath: "/compress",
	params: { target_ratio: 0.4 },
	headers: { "X-Team": "platform" },
	messages: [],
	query: "focus",
	signal: new AbortController().signal,
	timeoutMs: 180_000,
};

export const compactorHelpers = {
	COMPACTED_OUTPUT_MAX_TRIGGER_SHARE,
	COMPACTOR_LINE_WIDTH,
	classifyCompactionModel,
	compactedOutputTokenCap,
	estimateTextTokens,
	wrapLongLines,
};

export const sessionOptions: SessionCompactOptions = { query: "keep the parser decisions", compactionModel: "auto" };
export const extensionOptions: CompactOptions = { query: "focus", compactionModel: "morph/morph-compactor" };
export const replacement: SessionBeforeCompactResult = { compactedText: "replacement context" };
export const cancel: SessionBeforeCompactResult = { cancel: true };

// @ts-expect-error compression_ratio was removed; it is accepted and ignored at runtime only
export const removedRatio: SessionCompactOptions = { compression_ratio: 0.5 };
// @ts-expect-error preserve_recent was removed; it is accepted and ignored at runtime only
export const removedTail: CompactOptions = { preserve_recent: 2 };
// @ts-expect-error the planner rung no longer exists
export const removedRung: VerbatimCompactionResult["rung"] = "fresh";
