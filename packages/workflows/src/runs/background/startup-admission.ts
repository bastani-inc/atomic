import type { RunResult } from "../foreground/executor-types.js";
import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../../shared/types.js";
import { runDetached, type DetachedAccepted, type DetachedRunOpts } from "./runner.js";

export type WorkflowStartupAdmission =
  | { readonly started: true }
  | {
      readonly started: false;
      readonly resultError: string | undefined;
      readonly error: unknown | undefined;
    };

export interface WorkflowStartupObserver {
  readonly wait: Promise<WorkflowStartupAdmission>;
  readonly onWorkflowStartReady: () => void;
  readonly onRawSettled: (
    ok: boolean,
    result: RunResult | undefined,
    error: unknown | undefined,
  ) => void;
}

/** Resolve startup readiness separately from later workflow-body settlement. */
export function createWorkflowStartupObserver(
  beforeReady?: () => void,
): WorkflowStartupObserver {
  const startup = Promise.withResolvers<WorkflowStartupAdmission>();
  return {
    wait: startup.promise,
    onWorkflowStartReady: () => {
      beforeReady?.();
      startup.resolve({ started: true });
    },
    onRawSettled: (_ok, result, error) => {
      startup.resolve({ started: false, resultError: result?.error, error });
    },
  };
}
export function launchDetachedUntilStartup<
  TInputs extends WorkflowInputValues,
  TRunInputs extends WorkflowInputValues = TInputs,
>(
  def: WorkflowDefinition<TInputs, WorkflowOutputValues, TRunInputs>,
  inputs: Readonly<Record<string, unknown>>,
  opts: DetachedRunOpts = {},
): { readonly accepted: DetachedAccepted; readonly wait: Promise<WorkflowStartupAdmission> } {
  const priorReady = opts.onWorkflowStartReady;
  const priorSettled = opts.onRawSettled;
  const startup = createWorkflowStartupObserver(priorReady);
  const accepted = runDetached(def, inputs, {
    ...opts,
    onWorkflowStartReady: startup.onWorkflowStartReady,
    onRawSettled: (ok, result, error) => {
      try {
        priorSettled?.(ok, result, error);
      } finally {
        startup.onRawSettled(ok, result, error);
      }
    },
  });
  return { accepted, wait: startup.wait };
}

export function workflowStartupFailureMessage(
  admission: Extract<WorkflowStartupAdmission, { started: false }>,
  snapshotError: string | undefined,
  fallback: string,
): string {
  return admission.resultError
    ?? snapshotError
    ?? (admission.error instanceof Error
      ? admission.error.message
      : admission.error === undefined
        ? undefined
        : String(admission.error))
    ?? fallback;
}
