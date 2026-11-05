import type { WorkflowFutureStagePrediction, WorkflowSendPrediction } from "./types.js";

/** The classification a queued workflow send carries (#4359). */
export interface WorkflowSendPredictionFields {
	readonly prediction?: WorkflowSendPrediction;
	/** The decision model judged the target unlikely: probably a typo. */
	readonly unexpected?: true;
	/** The closest known stage path for an unexpected target. */
	readonly suggestion?: string;
}

interface UncheckedSendPredictionFields {
	readonly prediction?: unknown;
	readonly unexpected?: unknown;
	readonly suggestion?: unknown;
}

interface UncheckedFutureStagePredictionFields {
	readonly prediction?: unknown;
	readonly probability?: unknown;
}

const SEND_PREDICTIONS: ReadonlySet<unknown> = new Set<WorkflowSendPrediction>(["known", "predicted", "unknown"]);
const FUTURE_STAGE_PREDICTIONS: ReadonlySet<unknown> = new Set<WorkflowFutureStagePrediction>([
	"predicted",
	"confirmed",
	"unused",
]);
const MAX_SUGGESTION_LENGTH = 512;

/** Whether a wire frame's or result's prediction fields are well formed (absent fields are). */
export function isWorkflowSendPredictionFields(frame: object): boolean {
	const value = frame as UncheckedSendPredictionFields;
	return (
		(value.prediction === undefined || SEND_PREDICTIONS.has(value.prediction)) &&
		(value.unexpected === undefined || value.unexpected === true) &&
		(value.suggestion === undefined ||
			(typeof value.suggestion === "string" &&
				value.suggestion.length > 0 &&
				value.suggestion.length <= MAX_SUGGESTION_LENGTH))
	);
}

/** Only the prediction fields of a frame {@link isWorkflowSendPredictionFields} accepted. */
export function workflowSendPredictionFields(frame: object): WorkflowSendPredictionFields {
	const value = frame as UncheckedSendPredictionFields;
	return {
		...(SEND_PREDICTIONS.has(value.prediction) ? { prediction: value.prediction as WorkflowSendPrediction } : {}),
		...(value.unexpected === true ? { unexpected: true as const } : {}),
		...(typeof value.suggestion === "string" ? { suggestion: value.suggestion } : {}),
	};
}

/** Whether a possible-stage row's prediction fields are well formed (absent fields are). */
export function isWorkflowFutureStagePredictionFields(row: object): boolean {
	const value = row as UncheckedFutureStagePredictionFields;
	return (
		(value.prediction === undefined || FUTURE_STAGE_PREDICTIONS.has(value.prediction)) &&
		(value.probability === undefined ||
			(typeof value.probability === "number" &&
				Number.isFinite(value.probability) &&
				value.probability >= 0 &&
				value.probability <= 1))
	);
}
