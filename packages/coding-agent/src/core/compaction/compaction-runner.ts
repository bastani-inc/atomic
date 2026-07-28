import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { fallbackKey } from "../fallback-models.js";
import { getKeptTailTokenEstimate } from "./compaction-boundary.js";
import { reconstructCompactedTranscript, validateDeletedRanges } from "./deleted-ranges.js";
import { borrowFallbackPlanner, type FallbackPlannerContext } from "./fallback-planner.js";
import type { TerminalPlannerOutcome } from "./planner-outcome.js";
import {
	MALFORMED_OUTPUT_MESSAGE,
	NO_USABLE_RANGES_MESSAGE,
	planDeletedLineRanges,
	RangePlanError,
	resolvePlannerRequest,
} from "./range-planner.js";
import {
	MAX_OVERFLOW_TRIM_ATTEMPTS,
	nextTrimOffset,
	rebaseTrimmedRanges,
	trimRegionHead,
} from "./region-trimming.js";
import type {
	BorrowedPlanner,
	CompactedTranscript,
	CompactionPlannerModel,
	CompactionUrgency,
	NumberedRegion,
	PlannerAuth,
	RawLineRange,
	VerbatimCompactionPreparation,
} from "./compaction-types.js";

export interface CompactionPlanOptions {
	streamFn: StreamFn;
	/** Absolute path of the persisted session file. Undefined for in-memory sessions. */
	sessionFilePath?: string;
	retry?: RetryPolicy;
	callbacks?: RetryCallbacks;
}

/** One compaction run's request. Urgency is required; there is no default. */
export interface CompactionRunRequest extends CompactionPlanOptions {
	/** Per-model credentials; a borrowed candidate uses its own, never the session model's. */
	resolveAuth: (model: Model<Api>) => Promise<PlannerAuth | undefined>;
	signal?: AbortSignal;
	/** Inherited by the planner and never modified across attempts. */
	thinkingLevel: ThinkingLevel | undefined;
	urgency: CompactionUrgency;
	/** Configured fallback candidates. Omitted means borrowing is impossible. */
	fallback?: FallbackPlannerContext;
}

export type CompactionRungResult = CompactedTranscript & {
	rung: "planned" | "fresh";
	/** Present only when a borrowed fallback model ranked the lines. */
	plannerModel?: CompactionPlannerModel;
	/** False only when the fresh rung had to drop the protected tail. */
	keptTail: boolean;
};

/** A fresh context window. Total: no provider, no failure mode. */
export type FreshContextWindow = CompactedTranscript & { readonly keptTail: boolean };

/** Calculate the single global line threshold directly from the prepared setting. */
export function targetKeepLines(preparation: VerbatimCompactionPreparation): number {
	return targetKeepLinesForRegion(preparation.region, preparation.parameters.compression_ratio);
}

function targetKeepLinesForRegion(region: NumberedRegion, compressionRatio: number): number {
	return Math.max(region.protectedLineNumbers?.size ?? 0, Math.round(region.lines.length * compressionRatio));
}

function hardInputLimitFor(model: Model<Api>): number {
	return model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
}

function withWholeContextStats(
	result: CompactedTranscript,
	preparation: VerbatimCompactionPreparation,
	keptTail: boolean,
): CompactedTranscript {
	const tokensAfter = result.stats.tokensAfter + (keptTail ? getKeptTailTokenEstimate(preparation) : 0);
	const percentReduction = preparation.tokensBefore === 0
		? 0
		: Math.round((1 - tokensAfter / preparation.tokensBefore) * 1000) / 10;
	return {
		...result,
		stats: { ...result.stats, tokensBefore: preparation.tokensBefore, tokensAfter, percentReduction },
	};
}

/**
 * Discard every compactable line and start a fresh context window.
 *
 * TOTAL. No provider, no credentials, no network, no signal, no failure mode,
 * no `Promise`. Port of codex `compact_token_budget` →
 * `Session::start_new_context_window`. Atomic's system prompt, context files,
 * and skills are rebuilt per request and were never in the transcript, so they
 * survive automatically.
 *
 * The whole region is emitted as one deletion range and handed to the unchanged
 * `validateDeletedRanges` → `reconstructCompactedTranscript` path, which splits
 * around protected spans and folds prior markers. `keptTail` reports whether the
 * `preserve_recent` protected tail is retained; it is dropped only when keeping
 * it would still exceed `hardInputLimit`.
 */
export function startNewContextWindow(
	preparation: VerbatimCompactionPreparation,
	hardInputLimit: number,
): FreshContextWindow {
	const region = preparation.region;
	const whole: RawLineRange[] = region.lines.length > 0 ? [{ start: 1, end: region.lines.length }] : [];
	const transcript = reconstructCompactedTranscript(region, validateDeletedRanges(whole, region));
	const limit = Number.isFinite(hardInputLimit) && hardInputLimit > 0 ? hardInputLimit : Number.POSITIVE_INFINITY;
	const keptTail = transcript.stats.tokensAfter + getKeptTailTokenEstimate(preparation) <= limit;
	return { ...transcript, keptTail };
}

function plannedResult(
	preparation: VerbatimCompactionPreparation,
	ranges: RawLineRange[],
	plannerModel: CompactionPlannerModel | undefined,
): CompactionRungResult {
	const reconstructed = reconstructCompactedTranscript(
		preparation.region,
		validateDeletedRanges(ranges, preparation.region),
	);
	return {
		...withWholeContextStats(reconstructed, preparation, true),
		rung: "planned",
		...(plannerModel ? { plannerModel } : {}),
		keptTail: true,
	};
}

function borrowedIdentity(planner: BorrowedPlanner): CompactionPlannerModel {
	return {
		provider: planner.model.provider,
		id: planner.model.id,
		...(planner.budget.reasoning ? { thinkingLevel: planner.budget.reasoning } : {}),
	};
}

function terminalError(outcome: TerminalPlannerOutcome | undefined): RangePlanError {
	if (!outcome) return new RangePlanError(MALFORMED_OUTPUT_MESSAGE, 1, "", false);
	if (outcome.kind === "rateLimited") {
		return new RangePlanError(outcome.message, 1, "", false, outcome.diagnosticPath, outcome);
	}
	if (outcome.kind === "overflowed") {
		return new RangePlanError(
			"Compaction range planning exceeded the model context window",
			1,
			"",
			true,
			outcome.diagnosticPath,
			outcome,
		);
	}
	if (outcome.kind === "providerError") {
		return new RangePlanError(outcome.message, 1, "", false, outcome.diagnosticPath, outcome);
	}
	const message = outcome.category === "malformed_output" ? MALFORMED_OUTPUT_MESSAGE : NO_USABLE_RANGES_MESSAGE;
	return new RangePlanError(message, 1, outcome.excerpt, false, outcome.diagnosticPath, outcome);
}

type PlannerAttempt =
	| { kind: "planned"; ranges: RawLineRange[] }
	| { kind: "terminal"; outcome: TerminalPlannerOutcome };

/**
 * Run one planner model, retrying the same model after oldest-first input
 * trimming when the request itself overflows the context window.
 */
async function planWithTrimming(
	preparation: VerbatimCompactionPreparation,
	planner: BorrowedPlanner,
	options: CompactionPlanOptions & { signal?: AbortSignal },
): Promise<PlannerAttempt> {
	let offset = 0;
	for (let attempt = 0; ; attempt++) {
		const region = offset === 0 ? preparation.region : trimRegionHead(preparation.region, offset);
		if (!region) return { kind: "terminal", outcome: { kind: "overflowed" } };
		const outcome = await planDeletedLineRanges(
			region,
			preparation.parameters,
			planner,
			targetKeepLinesForRegion(region, preparation.parameters.compression_ratio),
			options,
		);
		if (outcome.kind === "ranked" || outcome.kind === "recovered") {
			if (offset === 0) return { kind: "planned", ranges: outcome.ranges };
			const validated = validateDeletedRanges(outcome.ranges, region);
			return { kind: "planned", ranges: rebaseTrimmedRanges(validated, offset) };
		}
		if (outcome.kind !== "overflowed" || attempt >= MAX_OVERFLOW_TRIM_ATTEMPTS) {
			return { kind: "terminal", outcome };
		}
		const next = nextTrimOffset(preparation.region, offset);
		if (next === undefined) return { kind: "terminal", outcome };
		offset = next;
	}
}

/**
 * Produce one compacted transcript, tagged with the rung that produced it.
 *
 * The ladder is: the session model, then each configured fallback model
 * borrowed for one planner request, then — only under `load_bearing` urgency —
 * a fresh context window. A manual `/compact` runs at `recoverable` urgency and
 * therefore cannot reach the context-destroying rung; it fails honestly instead.
 */
export async function runVerbatimCompaction(
	preparation: VerbatimCompactionPreparation,
	model: Model<Api>,
	request: CompactionRunRequest,
): Promise<CompactionRungResult> {
	const signal = request.signal;
	if (signal?.aborted) throw new Error("Compaction cancelled");
	const plannerOptions = {
		streamFn: request.streamFn,
		sessionFilePath: request.sessionFilePath,
		retry: request.retry,
		callbacks: request.callbacks,
		signal,
	};
	const hardInputLimit = hardInputLimitFor(model);
	const sessionAuth = await request.resolveAuth(model);
	if (!sessionAuth) throw new Error("Compaction provider authentication is unavailable");

	const attempted = new Set<string>();
	let planner: BorrowedPlanner | undefined = {
		model,
		budget: resolvePlannerRequest(model, request.thinkingLevel),
		auth: sessionAuth,
		key: fallbackKey(model, request.thinkingLevel),
	};
	let borrowed = false;
	let lastTerminal: TerminalPlannerOutcome | undefined;

	while (planner) {
		const attempt = await planWithTrimming(preparation, planner, plannerOptions);
		if (signal?.aborted) throw new Error("Compaction cancelled");
		if (attempt.kind === "planned") {
			return plannedResult(preparation, attempt.ranges, borrowed ? borrowedIdentity(planner) : undefined);
		}
		lastTerminal = attempt.outcome;
		attempted.add(planner.key);
		planner = request.fallback
			? await borrowFallbackPlanner(request.fallback, attempted, request.resolveAuth)
			: undefined;
		borrowed = planner !== undefined;
		if (signal?.aborted) throw new Error("Compaction cancelled");
	}

	if (request.urgency !== "load_bearing") throw terminalError(lastTerminal);
	const fresh = startNewContextWindow(preparation, hardInputLimit);
	return {
		...withWholeContextStats(fresh, preparation, fresh.keptTail),
		rung: "fresh",
		keptTail: fresh.keptTail,
	};
}
