/**
 * Foreground workflow executor public surface.
 *
 * The implementation is split by responsibility across sibling modules so raw
 * TypeScript distribution keeps every authored source under the file-length
 * gate while preserving this historical import path.
 */

export { raceAbort } from "./executor-abort.js";
export {
	askReadinessViaStageBroker,
	READINESS_GATE_ADVANCE_LABEL,
	READINESS_GATE_QUESTION_PARAMS,
	RESUME_CONTINUATION_PROMPT,
	readinessResultMeansAdvance,
	shouldInjectResumeContinuation,
	toolResultHasChatAnswer,
} from "./executor-hil.js";
export { resolveAndValidateInputs, resolveInputs } from "./executor-inputs.js";
export { run } from "./executor-run.js";
export type { ResolvedInputs, RunContinuationOpts, RunOpts, RunResult } from "./executor-types.js";
