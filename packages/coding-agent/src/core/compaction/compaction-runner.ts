import type { RetryCallbacks, RetryPolicy } from "@bastani/pi-ai";
import type { Api, Model } from "@bastani/pi-ai/compat";
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getKeptTailTokenEstimate } from "./compaction-boundary.js";
import type {
	BorrowedPlanner,
	CompactedTranscript,
	CompactionPlannerModel,
	CompactionUrgency,
	NumberedRegion,
	PlannerAuth,
	RawLineRange,
	VerbatimCompactionPreparation,
	VerbatimCompactionStats,
} from "./compaction-types.js";
import { MIN_COMPACTABLE_REGION_LINES } from "./compaction-types.js";
import { reconstructCompactedTranscript, validateDeletedRanges } from "./deleted-ranges.js";
import {
	type BorrowFallbackPlanner,
	createFallbackPlannerBorrower,
	type FallbackPlannerContext,
	plannerAttemptKey,
} from "./fallback-planner.js";
import type { TerminalPlannerOutcome } from "./planner-outcome.js";
import {
	MALFORMED_OUTPUT_MESSAGE,
	NO_USABLE_RANGES_MESSAGE,
	planDeletedLineRanges,
	RangePlanError,
	resolvePlannerRequest,
} from "./range-planner.js";
import { writeSuccessDiagnosticSidecar } from "./range-planner-diagnostics.js";
import { nextTrimOffset, rebaseTrimmedRanges, trimRegionHead } from "./region-trimming.js";

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

/** Runner-internal fresh-window build: the transcript plus the tail decision. */
interface FreshWindowBuild {
	transcript: CompactedTranscript;
	keptTail: boolean;
}

/**
 * Calculate the single global line threshold from the prepared setting.
 *
 * Protected lines count *against* this target rather than raising it: keeping 40% under a 0.5
 * ratio leaves the remaining 60% to compress harder to hit the same total. That keeps the
 * compression ratio a real bound on output size, so protection can never enlarge the result.
 *
 * This is the untrimmed target. Overflow trimming does NOT reuse it:
 * `planWithTrimming` recomputes the threshold against each trimmed view, so the
 * planner is always asked to keep a proportion of the lines it actually
 * received rather than a proportion of a region it never saw.
 *
 * Retained as an exported helper for tests and consumers that need the
 * pre-trim target; production planning goes through `planWithTrimming`.
 */
export function targetKeepLines(preparation: VerbatimCompactionPreparation): number {
	const region = preparation.region;
	return Math.round(region.lines.length * preparation.parameters.compression_ratio);
}

function hardInputLimitFor(model: Model<Api>): number {
	return model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
}

/**
 * Widen region-scoped stats to a whole-context symmetric heuristic pair.
 *
 * Both `tokensBefore` and `tokensAfter` are computed with the same estimator:
 * a region term (char/4 heuristic from `region.tokenEstimate` and the compacted
 * text) plus an explicit tail estimate from the same heuristic family.
 *
 * `tokensBefore` always includes the tail estimate because the tail was present
 * in the original context regardless of whether it survives compaction. When the
 * tail survives it appears on both sides and cancels in the ratio; when the
 * fresh rung drops the tail it correctly does not cancel, because the tail
 * really is gone from the after side.
 *
 * This does **not** clamp the percentage: a genuine expansion may still be
 * negative.
 *
 * Centralized here so planned, fresh, and extension results all use one
 * widening/ratio path.
 */
export function computeWholeContextStats(
	regionStats: VerbatimCompactionStats,
	region: NumberedRegion,
	tailEstimate: number,
	keptTail: boolean,
): VerbatimCompactionStats {
	const tokensBefore = region.tokenEstimate + tailEstimate;
	const tokensAfter = regionStats.tokensAfter + (keptTail ? tailEstimate : 0);
	const percentReduction = tokensBefore === 0 ? 0 : Math.round((1 - tokensAfter / tokensBefore) * 1000) / 10;
	return {
		...regionStats,
		tokensBefore,
		tokensAfter,
		percentReduction,
	};
}

/**
 * Build a fresh context window and the tail decision that goes with it.
 *
 * Private on purpose: `keptTail` is runner bookkeeping that persistence needs in
 * order to write `firstKeptEntryId: null` when the protected tail is dropped. It
 * is deliberately absent from the public door's return value, which is exactly a
 * `CompactedTranscript`.
 */
function buildFreshTranscript(preparation: VerbatimCompactionPreparation): CompactedTranscript {
	const region = preparation.region;
	const whole: RawLineRange[] = region.lines.length > 0 ? [{ start: 1, end: region.lines.length }] : [];
	return reconstructCompactedTranscript(region, validateDeletedRanges(whole, region));
}

function buildFreshContextWindow(preparation: VerbatimCompactionPreparation, hardInputLimit: number): FreshWindowBuild {
	const limit = Number.isFinite(hardInputLimit) && hardInputLimit > 0 ? hardInputLimit : Number.POSITIVE_INFINITY;
	// The rule is "tail under the limit ⇒ tail kept", so the comparison is the
	// tail alone. Explicit protected lines are a hard floor that survives either
	// way, and counting the reconstructed protected/marker text here would drop a
	// tail that fits. A rebuilt context that still cannot be sent is the post-tool
	// gate's problem, not a reason for this rung to discard more.
	return { transcript: buildFreshTranscript(preparation), keptTail: getKeptTailTokenEstimate(preparation) <= limit };
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
 * around protected spans and folds prior markers.
 *
 * Returns exactly a `CompactedTranscript` — `text`, `ranges`, `stats` and
 * nothing else. Whether the `preserve_recent` tail survives is a persistence
 * concern and travels on `CompactionRungResult.keptTail`, not on this door.
 */
export function startNewContextWindow(preparation: VerbatimCompactionPreparation): CompactedTranscript {
	return buildFreshTranscript(preparation);
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
	const tailEstimate = getKeptTailTokenEstimate(preparation);
	return {
		text: reconstructed.text,
		ranges: reconstructed.ranges,
		keptRanges: reconstructed.keptRanges,
		stats: computeWholeContextStats(reconstructed.stats, preparation.region, tailEstimate, true),
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
 *
 * Trimming continues until no strictly smaller view exists; `nextTrimOffset`
 * halves the remaining suffix, so the walk is finite. Only then is `overflowed`
 * terminal and the ladder advances.
 *
 * Each view gets its own keep target from `compression_ratio`. Reusing the
 * original whole-preparation target is what asked a halved 20-line region to
 * keep 10 of its 10 visible lines — a request for zero deletions, whose obedient
 * empty answer then hits the non-negotiable zero-range rejection. Extra
 * reduction still comes only from the head the runner withheld.
 */
async function planWithTrimming(
	preparation: VerbatimCompactionPreparation,
	planner: BorrowedPlanner,
	options: CompactionPlanOptions & { signal?: AbortSignal },
): Promise<PlannerAttempt> {
	let offset = 0;
	for (;;) {
		const region = offset === 0 ? preparation.region : trimRegionHead(preparation.region, offset);
		if (!region) return { kind: "terminal", outcome: { kind: "overflowed" } };
		const keepTarget = Math.max(
			region.protectedLineNumbers?.size ?? 0,
			Math.round(region.lines.length * preparation.parameters.compression_ratio),
		);
		const outcome = await planDeletedLineRanges(region, preparation.parameters, planner, keepTarget, options);
		if (outcome.kind === "ranked" || outcome.kind === "recovered") {
			if (offset === 0) return { kind: "planned", ranges: outcome.ranges };
			const validated = validateDeletedRanges(outcome.ranges, region);
			return { kind: "planned", ranges: rebaseTrimmedRanges(validated, offset) };
		}
		if (outcome.kind !== "overflowed") return { kind: "terminal", outcome };
		if (options.signal?.aborted) throw new Error("Compaction cancelled");
		const next = nextTrimOffset(preparation.region, offset);
		if (next === undefined) return { kind: "terminal", outcome };
		offset = next;
	}
}

const MISSING_AUTH_MESSAGE = "Compaction provider authentication is unavailable";

/**
 * A runner-local terminal cause with no provider attempt behind it.
 *
 * Missing credentials are not a provider outcome — no request was made — so no
 * synthetic response is fabricated and no diagnostic sidecar is written. It is
 * carried as `providerError` purely so the ladder can advance past it.
 */
function authFailureOutcome(error: unknown): TerminalPlannerOutcome {
	const message = error instanceof Error ? error.message : error === undefined ? MISSING_AUTH_MESSAGE : String(error);
	return { kind: "providerError", message: message || MISSING_AUTH_MESSAGE };
}

/** Resolve one model's credentials, normalizing a rejection and `undefined` alike. */
async function resolvePlannerAuth(
	resolveAuth: CompactionRunRequest["resolveAuth"],
	model: Model<Api>,
): Promise<{ auth: PlannerAuth } | { failure: TerminalPlannerOutcome }> {
	try {
		const auth = await resolveAuth(model);
		return auth ? { auth } : { failure: authFailureOutcome(undefined) };
	} catch (error) {
		return { failure: authFailureOutcome(error) };
	}
}

function freshResult(preparation: VerbatimCompactionPreparation, hardInputLimit: number): CompactionRungResult {
	const fresh = buildFreshContextWindow(preparation, hardInputLimit);
	const tailEstimate = getKeptTailTokenEstimate(preparation);
	return {
		text: fresh.transcript.text,
		ranges: fresh.transcript.ranges,
		keptRanges: fresh.transcript.keptRanges,
		stats: computeWholeContextStats(fresh.transcript.stats, preparation.region, tailEstimate, fresh.keptTail),
		rung: "fresh",
		keptTail: fresh.keptTail,
	};
}

/**
 * Produce one compacted transcript, tagged with the rung that produced it.
 *
 * The ladder is: the session model, then each configured fallback model
 * borrowed for one planner request, then — only under `load_bearing` urgency —
 * a fresh context window. A manual `/compact` runs at `recoverable` urgency and
 * therefore cannot reach the context-destroying rung; it fails honestly instead.
 *
 * Unavailable credentials are ladder control flow, not an early throw: a
 * borrowed candidate with its own working credentials can still rank the lines,
 * and a load-bearing caller still reaches the credential-free fresh rung.
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

	// A region below the planner minimum cannot be made rankable by changing
	// models, so no planner is invoked. Only a load-bearing caller can reach a
	// preparation this small; recoverable callers were refused before the runner.
	if (preparation.region.lines.length < MIN_COMPACTABLE_REGION_LINES) {
		if (request.urgency !== "load_bearing") throw new RangePlanError(NO_USABLE_RANGES_MESSAGE, 0, "", false);
		return freshResult(preparation, hardInputLimit);
	}

	const attempted = new Set<string>();
	// One borrower per run owns the monotonic cursor, so the configured list is
	// walked exactly once no matter how many terminal outcomes occur.
	const borrow: BorrowFallbackPlanner | undefined = request.fallback
		? createFallbackPlannerBorrower(request.fallback)
		: undefined;
	const primaryBudget = resolvePlannerRequest(model, request.thinkingLevel);
	const primaryAuth = await resolvePlannerAuth(request.resolveAuth, model);
	let lastTerminal: TerminalPlannerOutcome | undefined = "failure" in primaryAuth ? primaryAuth.failure : undefined;
	let borrowed = false;
	let planner: BorrowedPlanner | undefined;

	if ("auth" in primaryAuth) {
		planner = { model, budget: primaryBudget, auth: primaryAuth.auth };
	} else {
		// No request was made, but this candidate must not be retried.
		attempted.add(plannerAttemptKey({ model, budget: primaryBudget, auth: {} }));
		planner = borrow ? await borrow(attempted, request.resolveAuth) : undefined;
		borrowed = planner !== undefined;
	}

	while (planner) {
		const attempt = await planWithTrimming(preparation, planner, plannerOptions);
		if (signal?.aborted) throw new Error("Compaction cancelled");
		if (attempt.kind === "planned") {
			const plannerModel = borrowed ? borrowedIdentity(planner) : undefined;
			if (plannerModel) {
				// Best-effort: the durable entry already records the borrowed model;
				// a sidecar write failure never affects compaction success.
				writeSuccessDiagnosticSidecar({
					sessionFilePath: request.sessionFilePath,
					model: planner.model,
					successCategory: "borrowed_planner",
					...(plannerModel.thinkingLevel === undefined ? {} : { thinkingLevel: plannerModel.thinkingLevel }),
				});
			}
			return plannedResult(preparation, attempt.ranges, plannerModel);
		}
		lastTerminal = attempt.outcome;
		attempted.add(plannerAttemptKey(planner));
		planner = borrow ? await borrow(attempted, request.resolveAuth) : undefined;
		borrowed = planner !== undefined;
		if (signal?.aborted) throw new Error("Compaction cancelled");
	}

	if (request.urgency !== "load_bearing") throw terminalError(lastTerminal);
	return freshResult(preparation, hardInputLimit);
}
