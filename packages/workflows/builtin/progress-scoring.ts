/**
 * Observation-grounded trajectory scoring and pure trend evidence.
 *
 * Progress is a monitoring magnitude only. The prompt asks about the supplied
 * current state, and the trend result carries evidence without an action.
 */
import { Type } from "typebox";
import type { WorkflowRunContext, WorkflowSerializableObject, WorkflowSerializableValue } from "../src/shared/types.js";
import { VERIFICATION_SCALE } from "./verification-criteria.js";

export const DEFAULT_TREND_WINDOW = 3;
export const DEFAULT_RISE_DELTA = 1.5;
export const DEFAULT_FALL_DELTA = -1.5;

const DEFAULT_REPEATS = 1;
const CALIBRATION_RULES = [
	"Trust observed output, not the agent's narration.",
	"Effort and step count are NOT progress.",
	'Agent declarations of success ("done!", "all tests pass") are ZERO evidence.',
	"Scores may plateau or fall; wrong approaches plateau, and regressions decrease.",
] as const;
const PROGRESS_SCALE_ORIENTATION = `${VERIFICATION_SCALE.min} = certainly would not satisfy the acceptance criteria … ${VERIFICATION_SCALE.max} = verified satisfaction with observed output`;

export interface ProgressPromptInput {
	readonly problem: string;
	readonly steps: readonly string[];
	readonly checkpoints: readonly number[];
}

export interface ProgressScoreInput {
	readonly problem: string;
	readonly steps: readonly string[];
	readonly checkpoints?: readonly number[];
	readonly repeats?: number;
}

export type ProgressScoringContext = Pick<WorkflowRunContext, "task">;

export type ProgressCurve = {
	checkpoints: number[];
	scores: (number | null)[];
	perRepeat: (number | null)[][];
};

export type TrendConfig = {
	window?: number;
	riseDelta?: number;
	fallDelta?: number;
};

export type Trend = "rising" | "flat" | "regressing";

export type TrendResult = {
	trend: Trend;
	evidence: {
		series: readonly number[];
		window: number;
		delta: number;
	};
};

const progressSchema = Type.Object({
	scores: Type.Array(Type.Object({
		checkpoint: Type.Integer({ minimum: 1 }),
		score: VERIFICATION_SCALE.schema,
	}, { additionalProperties: false })),
}, { additionalProperties: false });

type ProgressStructuredOutput = {
	readonly scores: readonly WorkflowSerializableValue[];
};

function isRecord(value: WorkflowSerializableValue | undefined): value is WorkflowSerializableObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProgressStructuredOutput(value: WorkflowSerializableValue | undefined): value is ProgressStructuredOutput {
	if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "scores")) return false;
	return Array.isArray(value.scores);
}

function nullScores(checkpointCount: number): (number | null)[] {
	return Array.from({ length: checkpointCount }, () => null);
}

function defaultCheckpoints(stepCount: number): number[] {
	const result: number[] = [];
	for (let checkpoint = 2; checkpoint <= stepCount - 1; checkpoint += 1) result.push(checkpoint);
	return result;
}

function validateCheckpoints(checkpoints: readonly number[], stepCount: number): void {
	for (const checkpoint of checkpoints) {
		if (!Number.isInteger(checkpoint) || checkpoint < 1 || checkpoint > stepCount) {
			throw new RangeError(`Progress checkpoint ${checkpoint} is outside the step range 1..${stepCount}.`);
		}
	}
}

function scoresFromStructured(
	value: WorkflowSerializableValue | undefined,
	checkpoints: readonly number[],
): (number | null)[] {
	if (!isProgressStructuredOutput(value)) return nullScores(checkpoints.length);
	const requested = new Set(checkpoints);
	const seen = new Set<number>();
	const scoresByCheckpoint = new Map<number, number>();
	for (const candidate of value.scores) {
		if (!isRecord(candidate) || Object.keys(candidate).length !== 2 ||
			!Object.hasOwn(candidate, "checkpoint") || !Object.hasOwn(candidate, "score")) continue;
		const checkpoint = candidate.checkpoint;
		const score = candidate.score;
		if (typeof checkpoint !== "number" || !Number.isInteger(checkpoint) || seen.has(checkpoint)) continue;
		if (!requested.has(checkpoint) || typeof score !== "number" || !Number.isInteger(score) ||
			score < VERIFICATION_SCALE.min || score > VERIFICATION_SCALE.max) continue;
		seen.add(checkpoint);
		scoresByCheckpoint.set(checkpoint, score);
	}
	return checkpoints.map((checkpoint) => scoresByCheckpoint.get(checkpoint) ?? null);
}

/**
 * Score all requested checkpoints in one structured stage call for one repeat.
 * A failed or malformed call is an invalid repeat and leaves every checkpoint
 * in that repeat null.
 */
async function scoreRepeat(
	ctx: ProgressScoringContext,
	input: ProgressScoreInput,
	checkpoints: readonly number[],
	repeat: number,
): Promise<(number | null)[]> {
	try {
		const result = await ctx.task(`progress-score-${repeat + 1}`, {
			prompt: build_progress_prompt({ ...input, checkpoints }),
			context: "fresh",
			schema: progressSchema,
		});
		return scoresFromStructured(result.structured, checkpoints);
	} catch {
		return nullScores(checkpoints.length);
	}
}

/** Score every requested checkpoint once per repeat, returning null-safe means. */
export async function score_progress(
	ctx: ProgressScoringContext,
	input: ProgressScoreInput,
): Promise<ProgressCurve> {
	if (input.steps.length === 0) throw new RangeError("Progress scoring requires a non-empty step prefix.");
	const checkpoints = Array.from(input.checkpoints ?? defaultCheckpoints(input.steps.length));
	validateCheckpoints(checkpoints, input.steps.length);
	const repeats = input.repeats ?? DEFAULT_REPEATS;
	const perRepeat: (number | null)[][] = [];
	for (let repeat = 0; repeat < repeats; repeat += 1) {
		perRepeat.push(await scoreRepeat(ctx, input, checkpoints, repeat));
	}
	const scores = checkpoints.map((_, checkpointIndex) => {
		const valid = perRepeat
			.map((repeat) => repeat[checkpointIndex])
			.filter((score): score is number => score !== null);
		if (valid.length === 0) return null;
		return valid.reduce((total, score) => total + score, 0) / valid.length;
	});
	return { checkpoints, scores, perRepeat };
}

/**
 * Build a progress prompt with V3's shared-head/varying-tail layout. Steps are
 * part of the cacheable head; only the requested checkpoint list varies at the
 * tail.
 */
export function build_progress_prompt(input: ProgressPromptInput): string {
	const numberedSteps = input.steps.map((step, index) => `${index + 1}. ${step}`);
	const sharedHead = [
		"<progress_head>",
		"<problem>",
		input.problem,
		"</problem>",
		"<steps>",
		...numberedSteps,
		"</steps>",
		"<calibration>",
		...CALIBRATION_RULES,
		"</calibration>",
		"<scale>",
		`Use VERIFICATION_SCALE ${VERIFICATION_SCALE.min}..${VERIFICATION_SCALE.max} to answer: would the CURRENT state satisfy the acceptance criteria?`,
		PROGRESS_SCALE_ORIENTATION,
		"Score only the supplied current state from observed output.",
		"</scale>",
		"</progress_head>",
	].join("\n");
	const checkpointTail = [
		"<checkpoints>",
		"Score each listed 1-indexed checkpoint.",
		...input.checkpoints.map((checkpoint) => `- ${checkpoint}`),
		"</checkpoints>",
		"<output_format>",
		`Report scores: [{ checkpoint, score }], using integer scores from ${VERIFICATION_SCALE.min} through ${VERIFICATION_SCALE.max}.`,
		"</output_format>",
	].join("\n");
	return `${sharedHead}\n\n${checkpointTail}`;
}

function mean(values: readonly number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Classify a score series using a deterministic hysteresis delta. The trailing
 * 2*window values are split into equal leading/trailing halves; an odd sample
 * drops its middle value. Thresholds are inclusive at +riseDelta and -fallDelta.
 */
export function classify_trend(series: readonly number[], config: TrendConfig = {}): TrendResult {
	const window = config.window ?? DEFAULT_TREND_WINDOW;
	const riseDelta = config.riseDelta ?? DEFAULT_RISE_DELTA;
	const fallDelta = config.fallDelta ?? DEFAULT_FALL_DELTA;
	if (series.length < window + 1) {
		return { trend: "flat", evidence: { series, window, delta: 0 } };
	}
	const sample = series.slice(-2 * window);
	const usableLength = sample.length % 2 === 1 ? sample.length - 1 : sample.length;
	const halfLength = usableLength / 2;
	const leading = sample.slice(0, halfLength);
	const trailing = sample.slice(sample.length - halfLength);
	const delta = halfLength === 0 ? 0 : mean(trailing) - mean(leading);
	const trend: Trend = delta >= riseDelta ? "rising" : delta <= fallDelta ? "regressing" : "flat";
	return { trend, evidence: { series, window, delta } };
}
