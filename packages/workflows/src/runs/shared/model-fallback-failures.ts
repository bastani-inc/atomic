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
	modelFailureMessage,
	normalizeModelFailureSignal,
} from "@bastani/atomic";
