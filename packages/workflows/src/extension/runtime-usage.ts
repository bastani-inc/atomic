import type { WorkflowExecutionPolicy, WorkflowUsageRollupPort } from "../shared/types.js";

export interface RuntimeDispatchOptions {
  readonly policy?: WorkflowExecutionPolicy;
  /** Parent session that launched this run; captured before asynchronous stage completion. */
  readonly rootSessionId?: string;
}

interface RuntimeRootContext {
  readonly sessionId?: string;
  readonly sessionManager?: { getSessionId?: () => string };
}

export function runtimeDispatchOptions(
  policy: WorkflowExecutionPolicy,
  context: RuntimeRootContext,
): RuntimeDispatchOptions {
  const rootSessionId = context.sessionId ?? context.sessionManager?.getSessionId?.();
  return { policy, ...(rootSessionId ? { rootSessionId } : {}) };
}

export function bindUsageRollupRoot(
  port: WorkflowUsageRollupPort | undefined,
  rootSessionId: string | undefined,
): WorkflowUsageRollupPort | undefined {
  if (!port || !rootSessionId) return port;
  return {
    emitStageRollup(stageId, usage, meta): void {
      port.emitStageRollup(stageId, usage, { ...meta, rootSessionId });
    },
  };
}
