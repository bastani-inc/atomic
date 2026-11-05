import type { WorkflowSerializableObject } from "./authoring-contract-stage.js";

/**
 * Probability policy for decision-model stage-name predictions. These are tunable policy values, not calibrated
 * accuracy: a candidate at or above `predicted` joins the run's predicted stages, a send whose yes-probability is at
 * or above `known` counts as an expected target, and one at or below `unlikely` gets the likely-typo line.
 */
export const POSSIBLE_STAGE_PREDICTION_THRESHOLDS = Object.freeze({
	predicted: 0.8,
	known: 0.8,
	unlikely: 0.2,
} as const);

/** One judgment the decision model makes: a choice over closed options, or a yes/no question. */
export type StageDecisionQuestion =
	| {
			readonly type: "choice";
			readonly instructions: string;
			readonly criteria: Readonly<Record<string, string>>;
	  }
	| {
			readonly type: "bool";
			readonly instructions: string;
			readonly criteria: { readonly true: string; readonly false: string };
	  };

export interface StageDecisionRequest {
	readonly state: WorkflowSerializableObject;
	readonly questions: Readonly<Record<string, StageDecisionQuestion>>;
	/** Context shared by every question. */
	readonly instructions: string;
	/** Wall-clock limit in milliseconds for the whole decision. */
	readonly deadline: number;
	/** Aborts when the run ends, the extension is disposed, or the prediction deadline passes. */
	readonly signal: AbortSignal;
}

/** A choice answer's probability per option key, or a yes/no answer's probability of yes. */
export type StageDecisionAnswer =
	| { readonly type: "choice"; readonly probabilities: Readonly<Record<string, number>> }
	| { readonly type: "bool"; readonly probability: number };

export interface StageDecisionResult {
	readonly answers: Readonly<Record<string, StageDecisionAnswer | undefined>>;
}

/** The decision service stage prediction asks: the host's `decide()`, which must answer with probabilities. */
export interface StageDecisionPort {
	decide(request: StageDecisionRequest): Promise<StageDecisionResult>;
}

/** Every code of the {@link PossibleStagePredictionError} family. */
export type PossibleStagePredictionErrorCode =
	| "decision-unavailable"
	| "decision-failed"
	| "decision-timeout"
	| "invalid-answer";

/** Which prediction was running: the launch-time scan question or one send's yes/no question. */
export type PossibleStagePredictionPhase = "scan" | "target";

const MAX_CAUSE_DEPTH = 8;

/**
 * The family of stage-prediction errors. Stage prediction is advisory, so every member falls back to the static
 * known-set classification; catch the family or a concrete class and branch on `code`.
 */
export class PossibleStagePredictionError extends Error {
	override readonly name: string = "PossibleStagePredictionError";
	readonly code: PossibleStagePredictionErrorCode;
	/** What to do about it, without the rest of the message. */
	readonly hint: string;
	readonly retryable: boolean = false;
	readonly phase: PossibleStagePredictionPhase;
	constructor(
		code: PossibleStagePredictionErrorCode,
		phase: PossibleStagePredictionPhase,
		message: string,
		hint: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.code = code;
		this.phase = phase;
		this.hint = hint;
	}
}

/** No decision model can answer. Not retryable until a decision model is configured. */
export class StageDecisionUnavailableError extends PossibleStagePredictionError {
	override readonly name = "StageDecisionUnavailableError" as const;
	declare readonly code: "decision-unavailable";
	override readonly retryable = false as const;
	constructor(phase: PossibleStagePredictionPhase, options?: ErrorOptions) {
		const hint =
			"Set decisionModel to a classifier model to predict dynamic stage names; the static scan still applies.";
		super(
			"decision-unavailable",
			phase,
			`Stage-name prediction is unavailable: no decision model answered (decision-unavailable). ${hint}`,
			hint,
			options,
		);
	}
}

/** The decision model failed. Retryable when the underlying failure says so (for example a rate limit). */
export class StageDecisionFailedError extends PossibleStagePredictionError {
	override readonly name = "StageDecisionFailedError" as const;
	declare readonly code: "decision-failed";
	override readonly retryable: boolean;
	constructor(phase: PossibleStagePredictionPhase, cause: unknown) {
		const hint = "Check the decision model's provider status; the static scan still applies.";
		super(
			"decision-failed",
			phase,
			`Stage-name prediction failed in the decision model (decision-failed). ${hint}`,
			hint,
			{ cause },
		);
		this.retryable = (cause as { readonly retryable?: unknown } | null)?.retryable === true;
	}
}

/** The decision model did not answer before the prediction deadline. Retryable. */
export class StageDecisionTimeoutError extends PossibleStagePredictionError {
	override readonly name = "StageDecisionTimeoutError" as const;
	declare readonly code: "decision-timeout";
	override readonly retryable = true as const;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	constructor(phase: PossibleStagePredictionPhase, timeoutMs: number, elapsedMs: number, options?: ErrorOptions) {
		const hint = "The decision model was slow; a later run of the same workflow asks again.";
		super(
			"decision-timeout",
			phase,
			`Stage-name prediction timed out after ${elapsedMs} ms of ${timeoutMs} ms (decision-timeout). ${hint}`,
			hint,
			options,
		);
		this.timeoutMs = timeoutMs;
		this.elapsedMs = elapsedMs;
	}
}

/** Why an answer was refused. */
export type StageDecisionAnswerErrorReason = "missing" | "wrong-type" | "unknown-option" | "not-a-probability";

/** The decision model's answer did not fit the question; nothing from it was used. Not retryable. */
export class StageDecisionAnswerError extends PossibleStagePredictionError {
	override readonly name = "StageDecisionAnswerError" as const;
	declare readonly code: "invalid-answer";
	override readonly retryable = false as const;
	/** The question key whose answer was refused. */
	readonly question: string;
	readonly reason: StageDecisionAnswerErrorReason;
	constructor(phase: PossibleStagePredictionPhase, question: string, reason: StageDecisionAnswerErrorReason) {
		const hint = "The answer was discarded; the static scan still applies.";
		super(
			"invalid-answer",
			phase,
			`Stage-name prediction refused the answer to ${question}: ${reason} (invalid-answer). ${hint}`,
			hint,
		);
		this.question = question;
		this.reason = reason;
	}
}

const FAMILY_NAMES: ReadonlySet<unknown> = new Set([
	"PossibleStagePredictionError",
	"StageDecisionUnavailableError",
	"StageDecisionFailedError",
	"StageDecisionTimeoutError",
	"StageDecisionAnswerError",
]);

function hasStructure(value: unknown, names: ReadonlySet<unknown>): boolean {
	if (typeof value !== "object" || value === null) return false;
	const { name, code } = value as { readonly name?: unknown; readonly code?: unknown };
	return names.has(name) && typeof code === "string";
}

function guard<T extends PossibleStagePredictionError>(
	type: abstract new (...args: never[]) => T,
	name: string,
): (value: unknown) => value is T {
	const names: ReadonlySet<unknown> = new Set([name]);
	return (value: unknown): value is T => value instanceof type || hasStructure(value, names);
}

/** Whether `value` is a {@link PossibleStagePredictionError}, also one that crossed a realm boundary. */
export function isPossibleStagePredictionError(value: unknown): value is PossibleStagePredictionError {
	return value instanceof PossibleStagePredictionError || hasStructure(value, FAMILY_NAMES);
}
export const isStageDecisionUnavailableError = guard(StageDecisionUnavailableError, "StageDecisionUnavailableError");
export const isStageDecisionFailedError = guard(StageDecisionFailedError, "StageDecisionFailedError");
export const isStageDecisionTimeoutError = guard(StageDecisionTimeoutError, "StageDecisionTimeoutError");
export const isStageDecisionAnswerError = guard(StageDecisionAnswerError, "StageDecisionAnswerError");

/** The first {@link PossibleStagePredictionError} in `error`'s cause chain, looking at most eight errors deep. */
export function findPossibleStagePredictionError(error: unknown): PossibleStagePredictionError | undefined {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		if (isPossibleStagePredictionError(current)) return current;
		current = (current as { readonly cause?: unknown }).cause;
	}
	return undefined;
}
