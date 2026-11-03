/** Shared Atomic model-failure classification for workflow stages. */

export type {
	ModelFallbackFailureKind,
	ModelFallbackFailureOptions,
	ModelFallbackFailureSignal,
	ModelFallbackFailureSource,
} from "@bastani/atomic";
export {
	errorMessage,
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	isUnrecognizedModelFailure,
	modelFailureMessage,
	normalizeModelFailureSignal,
} from "@bastani/atomic";
