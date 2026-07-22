/**
 * Durable root-run registration and startup admission.
 *
 * Root registration/status must be durably persisted before startup admission
 * or workflow code runs: a stopped or unhealthy backend fails here, before
 * any side effects execute (issue #1957).
 */

import type { DurableWorkflowBackend, WorkflowRegistrationInput } from "../durable/backend.js";
import type { WorkflowSerializableValue } from "../shared/types.js";

/** Build the root registration handle, or `undefined` when the run must not (re-)register. */
export function durableRootRegistrationForRun(args: {
  readonly runId: string;
  readonly name: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly hasPersistence: boolean;
  readonly isChildRun: boolean;
  readonly continuationSourceId: string | undefined;
}): WorkflowRegistrationInput | undefined {
  const shouldRegister = !args.isChildRun
    && (args.continuationSourceId === undefined || args.continuationSourceId !== args.runId);
  if (!shouldRegister) return undefined;
  return {
    workflowId: args.runId,
    name: args.name,
    inputs: args.inputs as Record<string, WorkflowSerializableValue>,
    createdAt: args.createdAt,
    status: "running" as const,
    rootWorkflowId: args.runId,
    resumable: true,
    ...(args.hasPersistence ? { sessionFile: undefined } : {}),
  };
}

/** Register/mark the root run and flush so admission requires healthy durable persistence. */
export async function admitDurableRootRun(args: {
  readonly backend: DurableWorkflowBackend;
  readonly runId: string;
  readonly isChildRun: boolean;
  readonly registration: WorkflowRegistrationInput | undefined;
}): Promise<void> {
  if (args.registration !== undefined) {
    args.backend.registerWorkflow(args.registration);
  } else if (!args.isChildRun) {
    args.backend.setWorkflowStatus(args.runId, "running");
  }
  if (!args.isChildRun) await args.backend.flush();
}
