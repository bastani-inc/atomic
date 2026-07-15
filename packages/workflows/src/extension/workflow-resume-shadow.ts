import type { DurableWorkflowBackend } from "../durable/backend.js";
import { getDurableBackend } from "../durable/factory.js";
import { jobTracker, type JobTracker } from "../runs/background/job-tracker.js";
import {
  stageControlRegistry,
  type StageControlRegistry,
} from "../runs/foreground/stage-control-registry.js";
import { expandWorkflowGraph } from "../shared/expanded-workflow-graph.js";
import type { Store } from "../shared/store-public-types.js";
import type { RunSnapshot } from "../shared/store-types.js";

interface DurableResumeShadowDeps {
  readonly backend?: DurableWorkflowBackend;
  readonly jobs?: JobTracker;
  readonly stageControls?: StageControlRegistry;
}

/**
 * Reconcile a session-restored snapshot with an authoritative resumable
 * durable handle. Durable `paused` is an explicit graceful stop; durable
 * `running` without any local work is an orphan left by a stopped process.
 * A tracked background job or live stage control always wins and prevents
 * shadow classification.
 */
export function reconcileDurableResumeShadow(
  run: RunSnapshot,
  store: Store,
  deps: DurableResumeShadowDeps = {},
): boolean {
  const backend = deps.backend ?? getDurableBackend();
  const durableStatus = backend.getWorkflow(run.id)?.status;
  if (durableStatus !== "paused" && durableStatus !== "running") return false;
  const jobs = deps.jobs ?? jobTracker;
  if (jobs.has(run.id)) return false;
  const controls = deps.stageControls ?? stageControlRegistry;
  const graph = expandWorkflowGraph(store.snapshot(), run.id);
  const controlRunIds = new Set<string>([run.id]);
  for (const stage of graph.stages) controlRunIds.add(stage.workflowGraphTarget.runId);
  if ([...controlRunIds].some((runId) => controls.run(runId).stages().length > 0)) return false;
  if (run.status !== "paused" || run.exitReason !== "quit" || run.resumable !== true) {
    store.recordRunPaused(run.id, undefined, { exitReason: "quit", resumable: true });
  }
  return true;
}
