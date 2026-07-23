/**
 * Foreground workflow executor public surface.
 *
 * The implementation is split by responsibility across sibling modules so raw
 * TypeScript distribution keeps every authored source under the file-length
 * gate while preserving this historical import path.
 */

export type { ResolvedInputs, RunContinuationOpts, RunOpts, RunResult } from "./executor-types.js";
export { run } from "./executor-run.js";
export { resolveInputs, resolveAndValidateInputs } from "./executor-inputs.js";
export { raceAbort } from "./executor-abort.js";
export {
  READINESS_GATE_ADVANCE_LABEL,
  READINESS_GATE_QUESTION_PARAMS,
  RESUME_CONTINUATION_PROMPT,
  askReadinessViaStageBroker,
  readinessResultMeansAdvance,
  shouldInjectResumeContinuation,
  toolResultHasChatAnswer,
} from "./executor-hil.js";
