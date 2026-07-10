import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import type { SubagentState } from "../shared/types.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "../shared/artifacts.ts";
import { cleanupOldChainDirs } from "../shared/settings.ts";
import { cleanupOldNestedRuntimeDirs } from "../runs/shared/nested-events.ts";
import { createResultWatcher } from "../runs/background/result-watcher.ts";

export interface SubagentStartupMaintenance {
  scheduleStartupCleanup(): void;
  startResultWatcherDeferred(): void;
  primeExistingResultsDeferred(): void;
  cleanupSessionArtifactsDeferred(ctx: ExtensionContext): void;
  stop(): void;
}

function scheduleMacrotask(task: () => void): () => void {
  let cancelled = false;
  const handle = setImmediate(() => {
    if (!cancelled) task();
  });
  handle.unref?.();
  return () => {
    cancelled = true;
    clearImmediate(handle);
  };
}

function swallowCleanup(task: () => void): void {
  try {
    task();
  } catch {
  }
}

export function createSubagentStartupMaintenance(
  pi: ExtensionAPI,
  state: SubagentState,
  options: {
    resultsDir: string;
    artifactCleanupDays: number;
    resultTtlMs: number;
  },
): SubagentStartupMaintenance {
  const { startResultWatcher, primeExistingResults, stopResultWatcher } = createResultWatcher(
    pi,
    state,
    options.resultsDir,
    options.resultTtlMs,
  );
  const cancelTasks = new Set<() => void>();
  const schedule = (task: () => void): void => {
    const cancel = scheduleMacrotask(() => {
      cancelTasks.delete(cancel);
      task();
    });
    cancelTasks.add(cancel);
  };

  return {
    scheduleStartupCleanup() {
      schedule(() => {
        swallowCleanup(cleanupOldChainDirs);
        swallowCleanup(() => cleanupAllArtifactDirs(options.artifactCleanupDays));
        swallowCleanup(() => cleanupOldNestedRuntimeDirs(options.artifactCleanupDays));
      });
    },
    startResultWatcherDeferred() {
      schedule(startResultWatcher);
    },
    primeExistingResultsDeferred() {
      schedule(primeExistingResults);
    },
    cleanupSessionArtifactsDeferred(ctx) {
      let sessionFile: string | null | undefined;
      try {
        sessionFile = ctx.sessionManager.getSessionFile();
      } catch {
        return;
      }
      if (!sessionFile) return;
      schedule(() => swallowCleanup(() => cleanupOldArtifacts(getArtifactsDir(sessionFile), options.artifactCleanupDays)));
    },
    stop() {
      for (const cancel of cancelTasks) cancel();
      cancelTasks.clear();
      stopResultWatcher();
    },
  };
}
