/**
 * Row sources for the `/workflow resume` picker.
 *
 * Only inactive workflows belong in the resume selector. Live runs contribute
 * paused (quit) or recoverably-failed rows; actively-running live runs are
 * hidden because resuming an executing workflow would double-dispatch it.
 * The same collection backs the picker's live refresh (store changes plus a
 * bounded cross-session poll), so state transitions appear while it is open.
 */

import { getDurableBackend } from "../durable/factory.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { WorkflowResumeRefresh } from "../tui/workflow-resume-selector.js";
import { reconcileDurableResumeShadow } from "./workflow-resume-shadow.js";
import type { ExtensionRuntime } from "./runtime.js";
import { prepareWorkflowResumeCatalog } from "./workflow-durable-resume-command.js";

export interface ResumePickerLiveSource {
  readonly liveRuns: readonly RunSnapshot[];
  readonly activeLiveIds: ReadonlySet<string>;
}

export function collectResumePickerLiveRuns(runStore: Store): ResumePickerLiveSource {
  const durableResumeShadows = new Set(
    topLevelWorkflowRuns(runStore.runs())
      .filter((run) => reconcileDurableResumeShadow(run, runStore))
      .map((run) => run.id),
  );
  const liveRuns = topLevelWorkflowRuns(runStore.runs()).filter((run) =>
    !durableResumeShadows.has(run.id) &&
    (run.status === "paused" || (run.status === "failed" && run.resumable !== false)) &&
    getDurableBackend().isWorkflowLoadable(run.id),
  );
  const activeLiveIds = new Set(
    topLevelWorkflowRuns(runStore.runs())
      .filter((run) =>
        !durableResumeShadows.has(run.id) &&
        run.endedAt === undefined &&
        run.status === "running" &&
        run.exitReason !== "quit")
      .map((run) => run.id),
  );
  return { liveRuns, activeLiveIds };
}

export interface ResumePickerLiveUpdateOptions {
  readonly watch: (onChange: () => void) => () => void;
  readonly refresh: WorkflowResumeRefresh;
}

export function resumePickerLiveUpdateOptions(
  runStore: Store,
  runtime: ExtensionRuntime,
): ResumePickerLiveUpdateOptions {
  return {
    watch: (onChange) => runStore.subscribe(() => onChange()),
    refresh: async () => {
      const current = collectResumePickerLiveRuns(runStore);
      const catalog = await prepareWorkflowResumeCatalog(runtime, current.activeLiveIds);
      return {
        liveRuns: current.liveRuns,
        catalog: { durable: catalog.resumable, completed: catalog.completed },
      };
    },
  };
}

export interface ResumePickerCatalogRows {
  readonly durable: readonly ResumableWorkflowEntry[];
  readonly completed: readonly ResumableWorkflowEntry[];
}
