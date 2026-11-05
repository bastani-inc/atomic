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
	for (const key of Object.keys(inputs).sort()) {
		const value = inputs[key];
		shape[key] = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	}
	return shape;
}

/** Whether the scan is uncertain enough to ask: a typed uncertainty, or a bare `*` stage pattern. */
export function scanNeedsPrediction(scan: Pick<PossibleStagesScanResult, "uncertainties" | "stages">): boolean {
	return scan.uncertainties.length > 0 || scan.stages.some((stage) => splitStagePathSegments(stage).includes("*"));
}

interface ScanQuestionPlan {
	readonly questions: Readonly<Record<string, StageDecisionQuestion>>;
	/** Per question key, each option key's candidate. */
	readonly options: ReadonlyMap<string, ReadonlyMap<string, PossibleStageCandidate>>;
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
	uncertainties
		.filter((uncertainty) => uncertainty.candidates.length > 0)
		.slice(0, MAX_UNCERTAIN_SITES)
		.forEach((uncertainty, site) => {
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
		});
	return { questions, options };
}

/** The state the decision model reads for the scan question: redacted call-site source and the scan's partial result. */
export function scanDecisionState(
	workflowName: string,
	scan: Pick<PossibleStagesScanResult, "uncertainties" | "stages">,
	inputs: WorkflowSerializableObject,
): WorkflowSerializableObject {
	return {
		workflow: workflowName,
		knownStages: scan.stages.slice(0, MAX_STATE_STAGES),
		inputsShape: inputsShape(inputs),
		uncertainCallSites: scan.uncertainties
			.filter((uncertainty) => uncertainty.candidates.length > 0)
			.slice(0, MAX_UNCERTAIN_SITES)
			.map((uncertainty, site) => ({
				site: `site${site}`,
				code: uncertainty.code,
				file: uncertainty.file,
				line: uncertainty.line,
				boundary: uncertainty.boundary,
				source: redactSensitiveText(uncertainty.excerpt),
			})),
	};
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Accept every candidate at or above the `predicted` threshold; any malformed answer refuses the whole result. */
export function decodeScanAnswers(plan: ScanQuestionPlan, result: StageDecisionResult): readonly RunStagePrediction[] {
	const accepted = new Map<string, number>();
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
		for (const [option, candidate] of siteOptions) {
			const probability = answer.probabilities[option] ?? 0;
			if (probability < POSSIBLE_STAGE_PREDICTION_THRESHOLDS.predicted) continue;
			for (const path of candidate.stages) accepted.set(path, Math.max(accepted.get(path) ?? 0, probability));
		}
	}
	return [...accepted].map(([path, probability]) => ({ path, probability, source: "scan" as const }));
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
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	let tied = false;
	for (const name of new Set(names)) {
		if (name === path || name.includes("*")) continue;
		const distance = editDistance(path, name);
		if (distance > limit) continue;
		if (distance < bestDistance) {
			best = name;
			bestDistance = distance;
			tied = false;
		} else if (distance === bestDistance) tied = true;
	}
	return tied ? undefined : best;
}

/**
 * The scan entries that decide whether a send is known. A wildcard-only entry (every segment `*` or `workflow:*`) is
 * the scan saying it could not read the names; once the decision model accepted scan candidates for the run, those
 * predictions stand in for it, so a misspelled target is no longer matched by the placeholder.
 */
export function knownScanEntries(run: Pick<RunSnapshot, "possibleStages" | "stagePredictions">): readonly string[] {
	const entries = run.possibleStages ?? [];
	if (run.stagePredictions?.entries.some((entry) => entry.source === "scan") !== true) return entries;
	return entries.filter(
		(entry) => !splitStagePathSegments(entry).every((segment) => segment === "*" || segment === "workflow:*"),
	);
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
	let boundaries = 0;
	let openBoundaries = 0;
	for (const run of invocationRuns) {
		const hops = hopsOf(run.id);
		if (hops === undefined) continue;
		for (const stage of run.stages) {
			const spellings = [stage.id, stage.name];
			if (stageMatchesPathPattern(segments, hops, spellings)) return "confirmed";
			if (boundary.length === 0 || !stageMatchesPathPattern(boundary, hops, spellings)) continue;
			boundaries += 1;
			if (!ENDED_STAGE_STATUSES.has(stage.status)) openBoundaries += 1;
		}
	}
	if (isTerminalRunStatus(rootRun.status)) return "unused";
	return boundaries > 0 && openBoundaries === 0 ? "unused" : "predicted";
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
export function formatStagePredictionStatus(status: StagePredictionStatus): string[] {
	const lines: string[] = [];
	if (status.entries.length > 0) {
		const shown = status.entries
			.slice(0, STATUS_PREDICTION_LIMIT)
			.map((entry) => `${entry.path} ${entry.outcome} ${entry.probability.toFixed(2)}`);
		const more = status.entries.length - STATUS_PREDICTION_LIMIT;
		lines.push(`stage predictions: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`);
	}
	// A decision model that cannot give probabilities (a chat model) is a setup choice, not a failure worth a line.
	if (status.fallback !== undefined && status.fallback.code !== "decision-unavailable") {
		lines.push(`stage predictions unavailable (${status.fallback.code}): ${status.fallback.hint}`);
	}
	return lines;
}
