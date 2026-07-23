import type { WorkflowReloadReport } from "./workflow-reload-report.js";

type ReloadBatch = {
  readonly discoveryGeneration: number;
  requestCount: number;
  readonly promise: Promise<WorkflowReloadReport>;
  readonly resolve: (report: WorkflowReloadReport) => void;
  readonly reject: (error: Error) => void;
};

export interface WorkflowReloadCoordinator {
  request(discoveryGeneration: number): Promise<WorkflowReloadReport>;
}

function createBatch(discoveryGeneration: number): ReloadBatch {
  let resolve: (report: WorkflowReloadReport) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<WorkflowReloadReport>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = (error) => rejectPromise(error);
  });
  return { discoveryGeneration, requestCount: 0, promise, resolve, reject };
}

/**
 * Runs one reload at a time. Requests coalesce only with the latest queued pass
 * from the same session generation; generation boundaries remain ordered.
 */
export function createWorkflowReloadCoordinator(
  reload: (discoveryGeneration: number, coalescedRequests: number) => Promise<WorkflowReloadReport>,
): WorkflowReloadCoordinator {
  const pending: ReloadBatch[] = [];
  let draining = false;

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const batch = pending.shift()!;
        try {
          const report = await reload(batch.discoveryGeneration, batch.requestCount);
          batch.resolve(report);
        } catch (error) {
          batch.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      draining = false;
      if (pending.length > 0) void drain();
    }
  };

  return {
    request(discoveryGeneration): Promise<WorkflowReloadReport> {
      let batch = pending.at(-1);
      if (batch?.discoveryGeneration !== discoveryGeneration) {
        batch = createBatch(discoveryGeneration);
        pending.push(batch);
      }
      batch.requestCount += 1;
      queueMicrotask(() => void drain());
      return batch.promise;
    },
  };
}
