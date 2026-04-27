/**
 * Workflow metadata accessors.
 *
 * Function-style getters keep the public surface forward-compatible —
 * adding optional metadata fields to `WorkflowDefinition` doesn't force
 * every consumer to read directly off the object, so we can add lazy
 * derivation, deprecation warnings, or normalization in one place.
 */

import type { AgentType, WorkflowInput } from "../types.ts";

/**
 * Structural shape the metadata accessors read off a workflow
 * definition. Typed as a minimal interface (rather than the full
 * `WorkflowDefinition<A, I>`) so the accessors accept narrowly-typed
 * compiled definitions without triggering contravariance failures on
 * the `run` method signature.
 */
export interface MetadataWorkflow {
  readonly name: string;
  readonly description: string;
  readonly agent: AgentType;
  readonly inputs: readonly WorkflowInput[];
  readonly source: string;
  readonly minSDKVersion: string | null;
}

/** Workflow's unique name. */
export function getName(workflow: MetadataWorkflow): string {
  return workflow.name;
}

/** Human-readable description (empty string when none was declared). */
export function getDescription(workflow: MetadataWorkflow): string {
  return workflow.description;
}

/** Agent backend the workflow targets. */
export function getAgent(workflow: MetadataWorkflow): AgentType {
  return workflow.agent;
}

/** Frozen copy of the declared input schema (empty for free-form workflows). */
export function getInputSchema(
  workflow: MetadataWorkflow,
): readonly WorkflowInput[] {
  return workflow.inputs;
}

/** Absolute path of the workflow's source file (`import.meta.path`). */
export function getSource(workflow: MetadataWorkflow): string {
  return workflow.source;
}

/**
 * Minimum SDK version this workflow declares (or `null` when none was
 * specified). Atomic uses this to gate stale workflows on older installs.
 */
export function getMinSDKVersion(
  workflow: MetadataWorkflow,
): string | null {
  return workflow.minSDKVersion;
}
