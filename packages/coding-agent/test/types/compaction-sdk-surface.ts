import type {
	CompactionForm,
	CompactOptions,
	SessionBeforeCompactResult,
	SessionCompactOptions,
	VerbatimCompactionParameters,
	VerbatimCompactionResult,
} from "../../src/index.ts";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Expect<Value extends true> = Value;

export type CompactionForms = Expect<Equal<CompactionForm, "cleared" | "compacted">>;
export type CompactionParameters = Expect<Equal<VerbatimCompactionParameters, { query: string }>>;
export type ResultForm = Expect<Equal<VerbatimCompactionResult["form"], CompactionForm>>;
export type ResultBackend = Expect<Equal<VerbatimCompactionResult["backend"], "compactor" | "extension" | undefined>>;

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
