import { durableHash } from "../durable/durable-hash.js";
import {
	createWorkflowBoundaryHopsResolver,
	stageMatchesPathPattern,
	type WorkflowBoundaryHop,
} from "./pending-stage-status.js";
import {
	POSSIBLE_STAGE_PREDICTION_THRESHOLDS,
	StageDecisionAnswerError,
	type StageDecisionQuestion,
	type StageDecisionResult,
} from "./possible-stage-prediction-errors.js";
import type { PossibleStageCandidate, PossibleStagesScanResult, PossibleStageUncertainty } from "./possible-stages.js";
import { isTerminalRunStatus } from "./store-internal.js";
import type { RunSnapshot, RunStagePrediction, RunStagePredictionFallback } from "./store-types.js";
import type { WorkflowSerializableObject } from "./types.js";
import { redactSensitiveText } from "./workflow-failures-signals.js";
import { reciprocalWorkflowRootRunId } from "./workflow-run-ownership.js";
import { matchStagePathSegments, splitStagePathSegments } from "./workflow-stage-path-matching.js";

// ---------------------------------------------------------------------------
// Questions and answers
// ---------------------------------------------------------------------------

/** Bumped whenever the questions or state change meaning, so cached answers are not reused across versions. */
const QUESTION_VERSION = 1;
const MAX_UNCERTAIN_SITES = 12;
const MAX_STATE_STAGES = 64;
const NONE_OPTION = "none";

/** The definition a prediction is about: its source digests, nesting bound and inputs shape. */
export function stagePredictionDefinitionHash(
	scan: Pick<PossibleStagesScanResult, "sources">,
	maxDepth: number | undefined,
	inputs: WorkflowSerializableObject,
): string {
	return durableHash({
		version: QUESTION_VERSION,
		sources: scan.sources.map((source) => [source.file, source.sha256]),
		maxDepth: maxDepth ?? null,
		inputsShape: inputsShape(inputs),
	});
}

/** Each input's type, never its value. */
export function inputsShape(inputs: WorkflowSerializableObject): WorkflowSerializableObject {
	const shape: Record<string, string> = {};
	for (const key of Object.keys(inputs)) {
		const value = inputs[key];
		shape[key] = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	}
	return shape;
}

interface ScanQuestionPlan {
	readonly questions: Readonly<Record<string, StageDecisionQuestion>>;
	/** Per question key, each option key's candidate. */
	readonly options: ReadonlyMap<string, ReadonlyMap<string, PossibleStageCandidate>>;
	/** Per question key, the wildcard entry its call site added, if any. */
	readonly placeholders: ReadonlyMap<string, string | undefined>;
	/** Wildcard entries also added by a call site no question asks about, so no answer can stand in for them. */
	readonly unaskedPlaceholders: ReadonlySet<string | undefined>;
}

function askedSites(uncertainties: readonly PossibleStageUncertainty[]): readonly PossibleStageUncertainty[] {
	return uncertainties.filter((uncertainty) => uncertainty.candidates.length > 0).slice(0, MAX_UNCERTAIN_SITES);
}

function describeCandidate(candidate: PossibleStageCandidate): string {
	const [first, ...rest] = candidate.stages;
	if (candidate.source === "child-definition") {
		return `child workflow ${first}${rest.length === 0 ? "" : ` with stages ${rest.join(", ")}`}`;
	}
	if (rest.length > 0) return `every one of ${candidate.stages.join(", ")}`;
	return `stage ${first}`;
}

/** One choice question per uncertain call site that has candidates; option keys never carry names. */
export function scanQuestionPlan(uncertainties: readonly PossibleStageUncertainty[]): ScanQuestionPlan {
	const questions: Record<string, StageDecisionQuestion> = {};
	const options = new Map<string, ReadonlyMap<string, PossibleStageCandidate>>();
	const placeholders = new Map<string, string | undefined>();
	const asked = askedSites(uncertainties);
	asked.forEach((uncertainty, site) => {
		const key = `site${site}`;
		const siteOptions = new Map<string, PossibleStageCandidate>();
		const criteria: Record<string, string> = {};
		uncertainty.candidates.forEach((candidate, index) => {
			siteOptions.set(`c${index}`, candidate);
			criteria[`c${index}`] = describeCandidate(candidate);
		});
		criteria[NONE_OPTION] = "none of these candidates";
		questions[key] = {
			type: "choice",
			instructions: `Which candidate will the call site ${key} (${uncertainty.file}:${uncertainty.line}) produce when this workflow runs? Choose only from the listed candidates; choose none when no candidate fits.`,
			criteria,
		};
		options.set(key, siteOptions);
		placeholders.set(key, uncertainty.placeholder);
	});
	const unaskedPlaceholders = new Set(
		uncertainties.filter((uncertainty) => !asked.includes(uncertainty)).map((uncertainty) => uncertainty.placeholder),
	);
	return { questions, options, placeholders, unaskedPlaceholders };
}

function describeSite(uncertainty: PossibleStageUncertainty): WorkflowSerializableObject {
	return {
		code: uncertainty.code,
		file: uncertainty.file,
		line: uncertainty.line,
		boundary: uncertainty.boundary,
		source: redactSensitiveText(uncertainty.excerpt),
	};
}

/**
 * The state the decision model reads: the redacted source of every call site the scan could not read, those with
 * candidates keyed by their question, and the scan's partial result.
 */
export function scanDecisionState(
	workflowName: string,
	scan: Pick<PossibleStagesScanResult, "uncertainties" | "stages">,
	inputs: WorkflowSerializableObject,
): WorkflowSerializableObject {
	const asked = askedSites(scan.uncertainties);
	return {
		workflow: workflowName,
		knownStages: scan.stages.slice(0, MAX_STATE_STAGES),
		inputsShape: inputsShape(inputs),
		uncertainCallSites: asked.map((uncertainty, site) => ({ site: `site${site}`, ...describeSite(uncertainty) })),
		otherUnreadCallSites: scan.uncertainties
			.filter((uncertainty) => !asked.includes(uncertainty))
			.slice(0, MAX_UNCERTAIN_SITES)
			.map(describeSite),
	};
}

function isProbability(value: unknown): value is number {
	return Number.isFinite(value) && (value as number) >= 0 && (value as number) <= 1;
}

/** A scan answer: the accepted candidates' stage paths, and the wildcard entries they stand in for. */
export interface ScanPredictions {
	readonly entries: readonly RunStagePrediction[];
	readonly resolvedPlaceholders: readonly string[];
}

/**
 * Accept every candidate at or above the `predicted` threshold; any malformed answer refuses the whole result. A
 * wildcard entry is resolved only when every call site that added it was asked and accepted a candidate.
 */
export function decodeScanAnswers(plan: ScanQuestionPlan, result: StageDecisionResult): ScanPredictions {
	const accepted = new Map<string, number>();
	const resolved = new Set<string>();
	const unresolved = new Set(plan.unaskedPlaceholders);
	for (const [key, siteOptions] of plan.options) {
		const answer = result.answers[key];
		if (answer === undefined) throw new StageDecisionAnswerError("scan", key, "missing");
		if (answer.type !== "choice" || typeof answer.probabilities !== "object" || answer.probabilities === null) {
			throw new StageDecisionAnswerError("scan", key, "wrong-type");
		}
		for (const [option, probability] of Object.entries(answer.probabilities)) {
			if (option !== NONE_OPTION && !siteOptions.has(option)) {
				throw new StageDecisionAnswerError("scan", key, "unknown-option");
			}
			if (!isProbability(probability)) throw new StageDecisionAnswerError("scan", key, "not-a-probability");
		}
		let siteAccepted = false;
		for (const [option, candidate] of siteOptions) {
			const probability = answer.probabilities[option] ?? 0;
			if (probability < POSSIBLE_STAGE_PREDICTION_THRESHOLDS.predicted) continue;
			siteAccepted = true;
			for (const path of candidate.stages) accepted.set(path, Math.max(accepted.get(path) ?? 0, probability));
		}
		const placeholder = plan.placeholders.get(key);
		if (placeholder !== undefined) (siteAccepted ? resolved : unresolved).add(placeholder);
	}
	return {
		entries: [...accepted].map(([path, probability]) => ({ path, probability, source: "scan" as const })),
		resolvedPlaceholders: [...resolved].filter((placeholder) => !unresolved.has(placeholder)),
	};
}

export const TARGET_QUESTION_KEY = "target";

/** The yes/no question for one send outside the known set. */
export function targetQuestion(path: string): StageDecisionQuestion {
	return {
		type: "bool",
		instructions: `Will this workflow run start a stage whose path matches ${path}? Paths are "/"-separated stage names; "*" matches one segment and "**" any depth.`,
		criteria: {
			true: "Yes: a stage this run starts will match the path.",
			false: "No: no stage will match; the path is likely a typo or a stale name.",
		},
	};
}

/** The yes-probability of the target question; a malformed answer is refused. */
export function decodeTargetAnswer(result: StageDecisionResult): number {
	const answer = result.answers[TARGET_QUESTION_KEY];
	if (answer === undefined) throw new StageDecisionAnswerError("target", TARGET_QUESTION_KEY, "missing");
	if (answer.type !== "bool") throw new StageDecisionAnswerError("target", TARGET_QUESTION_KEY, "wrong-type");
	if (!isProbability(answer.probability)) {
		throw new StageDecisionAnswerError("target", TARGET_QUESTION_KEY, "not-a-probability");
	}
	return answer.probability;
}

// ---------------------------------------------------------------------------
// Closest name
// ---------------------------------------------------------------------------

function editDistance(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row++) {
		const current = [row];
		for (let column = 1; column <= right.length; column++) {
			const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
			current.push(Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution));
		}
		previous = current;
	}
	return previous[right.length]!;
}

/**
 * The single closest literal stage path to `path`, within an edit distance of two fifths of its length (TypeScript's
 * spelling-suggestion bound); `undefined` when nothing is that close or two paths tie.
 */
export function closestStagePath(path: string, names: readonly string[]): string | undefined {
	const limit = Math.floor(path.length * 0.4);
	const near = [...new Set(names)]
		.filter((name) => name !== path && !name.includes("*"))
		.map((name) => ({ name, distance: editDistance(path, name) }))
		.filter((entry) => entry.distance <= limit);
	const best = Math.min(...near.map((entry) => entry.distance));
	const closest = near.filter((entry) => entry.distance === best);
	return closest.length === 1 ? closest[0]!.name : undefined;
}

/**
 * The scan entries that decide whether a send is known: every entry but the wildcards the decision model's accepted
 * candidates stand in for, so a misspelled target is no longer matched by a placeholder that is no longer needed.
 */
export function knownScanEntries(run: Pick<RunSnapshot, "possibleStages" | "stagePredictions">): readonly string[] {
	const resolved = new Set(run.stagePredictions?.resolvedPlaceholders);
	return (run.possibleStages ?? []).filter((entry) => !resolved.has(entry));
}

/** Whether a target's segments and a stage path match in either direction (D4 membership). */
export function stagePathsOverlap(targetSegments: readonly string[], path: string): boolean {
	const segments = splitStagePathSegments(path);
	return matchStagePathSegments(segments, targetSegments) || matchStagePathSegments(targetSegments, segments);
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** `confirmed`: a stage matching the prediction started; `unused`: none did and none can any more. */
export type StagePredictionOutcome = "predicted" | "confirmed" | "unused";

const ENDED_STAGE_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "skipped"]);

/**
 * Whether a predicted path came true. A prediction is `unused` once the root run ended without a matching stage, or
 * once every materialized child boundary it nests under ended without one.
 */
export function stagePredictionOutcome(
	path: string,
	rootRun: Pick<RunSnapshot, "status">,
	invocationRuns: readonly RunSnapshot[],
	hopsOf: (runId: string) => readonly WorkflowBoundaryHop[] | undefined,
): StagePredictionOutcome {
	const segments = splitStagePathSegments(path);
	const boundary = segments.slice(0, -1);
	let boundaryStarted = false;
	let boundaryOpen = false;
	for (const run of invocationRuns) {
		const hops = hopsOf(run.id);
		if (hops === undefined) continue;
		for (const stage of run.stages) {
			const spellings = [stage.id, stage.name];
			if (stageMatchesPathPattern(segments, hops, spellings)) return "confirmed";
			if (!stageMatchesPathPattern(boundary, hops, spellings)) continue;
			boundaryStarted = true;
			if (!ENDED_STAGE_STATUSES.has(stage.status)) boundaryOpen = true;
		}
	}
	if (isTerminalRunStatus(rootRun.status)) return "unused";
	return boundaryStarted && !boundaryOpen ? "unused" : "predicted";
}

/** A root run's predictions with what became of each, as workflow status reports them. */
export interface StagePredictionStatus {
	readonly entries: readonly (RunStagePrediction & { readonly outcome: StagePredictionOutcome })[];
	readonly fallback?: RunStagePredictionFallback;
}

/** `undefined` when the run has no predictions and no recorded fallback. */
export function stagePredictionStatus(
	rootRun: RunSnapshot,
	allRuns: readonly RunSnapshot[],
): StagePredictionStatus | undefined {
	const predictions = rootRun.stagePredictions;
	if (predictions === undefined || (predictions.entries.length === 0 && predictions.fallback === undefined)) {
		return undefined;
	}
	const runById = new Map(allRuns.map((run) => [run.id, run]));
	const invocationRuns = allRuns.filter((run) => reciprocalWorkflowRootRunId(runById, run.id) === rootRun.id);
	const hopsOf = createWorkflowBoundaryHopsResolver(allRuns);
	return {
		entries: predictions.entries.map((entry) => ({
			...entry,
			outcome: stagePredictionOutcome(entry.path, rootRun, invocationRuns, hopsOf),
		})),
		...(predictions.fallback === undefined ? {} : { fallback: predictions.fallback }),
	};
}

const STATUS_PREDICTION_LIMIT = 5;

/**
 * Status lines for a root's predictions, such as `stage predictions: review-1 confirmed 0.95, lint predicted 0.91`,
 * and one `stage predictions unavailable (<code>): <hint>` line when prediction failed. `decision-unavailable` stays
 * in the structured status only.
 */
export function formatStagePredictionStatus(status: StagePredictionStatus | undefined): string[] {
	const { predicted, unavailable } = describeStagePredictions(status);
	return [
		...(predicted === undefined ? [] : [`stage predictions: ${predicted}`]),
		...(unavailable === undefined ? [] : [`stage predictions ${unavailable}`]),
	];
}

/**
 * The text of a root's predictions, such as `review-1 confirmed 0.95, lint predicted 0.91`, and of a failed
 * prediction, such as `unavailable (decision-timeout): <hint>`. A decision model that cannot give probabilities (a chat
 * model) is a setup choice, not a failure, so `decision-unavailable` has no text.
 */
export function describeStagePredictions(status: StagePredictionStatus | undefined): {
	readonly predicted?: string;
	readonly unavailable?: string;
} {
	if (status === undefined) return {};
	const shown = status.entries
		.slice(0, STATUS_PREDICTION_LIMIT)
		.map((entry) => `${entry.path} ${entry.outcome} ${entry.probability.toFixed(2)}`);
	const more = status.entries.length - STATUS_PREDICTION_LIMIT;
	const fallback = status.fallback;
	return {
		...(shown.length === 0 ? {} : { predicted: `${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}` }),
		...(fallback === undefined || fallback.code === "decision-unavailable"
			? {}
			: { unavailable: `unavailable (${fallback.code}): ${fallback.hint}` }),
	};
}
