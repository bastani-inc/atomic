/**
 * Input validation primitive.
 *
 * Wraps `validateAndResolve` from `worker-shared.ts` with a workflow-aware
 * signature so consumers don't need to reach into the SDK internals to
 * coerce, default, and validate raw user-supplied input maps.
 */

import type { WorkflowInput } from "../types.ts";
import { validateAndResolve } from "../worker-shared.ts";

/**
 * Validated, defaults-applied input map. The shape matches
 * `Record<string, string>` because the executor's tmux launcher serialises
 * inputs as JSON strings; integer coercion happens later, inside
 * `runOrchestrator`, against the same schema.
 */
export type ResolvedInputs = Record<string, string>;

/**
 * Structural shape `validateInputs` reads off a workflow definition.
 * Typed as a minimal interface (rather than `WorkflowDefinition`) so the
 * primitive accepts narrowly-typed compiled definitions without
 * triggering contravariance failures in the `run` method signature.
 */
export interface ValidatableWorkflow {
  readonly inputs: readonly WorkflowInput[];
}

/**
 * Validate raw user inputs against a workflow's declared schema.
 *
 * - Throws on unknown flags or missing required fields.
 * - Applies declared defaults and the first enum value when no value is given.
 * - Validates enum membership and integer parseability.
 * - For free-form workflows (no declared inputs), passes through every
 *   non-empty key as-is — this preserves the legacy
 *   `--prompt "<text>"` shape.
 */
export function validateInputs(
  workflow: ValidatableWorkflow,
  raw: Record<string, string>,
): ResolvedInputs {
  if (workflow.inputs.length === 0) {
    return { ...raw };
  }
  return validateAndResolve(raw, workflow.inputs);
}
