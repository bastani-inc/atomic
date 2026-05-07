/**
 * Workflow metadata accessors.
 *
 * Function-style getters keep the public surface forward-compatible —
 * adding optional metadata fields to `WorkflowDefinition` doesn't force
 * every consumer to read directly off the object, so we can add lazy
 * derivation, deprecation warnings, or normalization in one place.
 *
 * All accessors accept both builtin (`WorkflowDefinition`) and external
 * (`ExternalWorkflow`) entries — they branch on `kind === "external"` and
 * return the corresponding field straight from the `ExternalWorkflow`.
 */

import type { AgentType, ExternalWorkflow, WorkflowInput } from "../types.ts";

/**
 * Structural shape for a builtin workflow that the metadata accessors read.
 * Typed as a minimal interface (rather than the full `WorkflowDefinition<A, I>`)
 * so accessors accept narrowly-typed compiled definitions without triggering
 * contravariance failures on the `run` method signature.
 */
export interface BuiltinMetadataWorkflow {
  readonly kind?: "builtin";
  readonly name: string;
  readonly description: string;
  readonly agent: AgentType;
  readonly inputs: readonly WorkflowInput[];
  readonly source: string;
  readonly minSDKVersion: string | null;
}

/**
 * The union type accepted by all metadata accessors — either a compiled
 * builtin workflow or a subprocess-dispatched external workflow.
 */
export type MetadataWorkflow = BuiltinMetadataWorkflow | ExternalWorkflow;

/** Workflow's unique name. */
export function getName(workflow: MetadataWorkflow): string {
  return workflow.name;
}

/** Human-readable description (empty string when none was declared). */
export function getDescription(workflow: MetadataWorkflow): string {
  if (workflow.kind === "external") return workflow.description ?? "";
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

/**
 * Source of the workflow:
 * - For builtins: the absolute file path (`import.meta.path`).
 * - For externals: a human-readable string representation of the command.
 */
export function getSource(workflow: MetadataWorkflow): string {
  if (workflow.kind === "external") {
    const { command, args } = workflow.source;
    return args.length > 0 ? `${command} ${args.join(" ")}` : command;
  }
  return workflow.source;
}

/**
 * Minimum SDK version this workflow declares (or `null` when none was
 * specified). External workflows have no version constraint — returns `null`.
 */
export function getMinSDKVersion(
  workflow: MetadataWorkflow,
): string | null {
  if (workflow.kind === "external") return null;
  return workflow.minSDKVersion;
}
