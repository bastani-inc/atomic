import type { DurableWorkflowBackend } from "../durable/backend.js";
import { getDurableBackend } from "../durable/factory.js";
import { isDurableWorkflowResumable } from "../durable/resume-eligibility.js";
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

export type DurableResumeShadowClassification = "eligible" | "ineligible" | "not_shadow";

/** Classify restored metadata without manufacturing progress the durable backend rejects. */
export function classifyDurableResumeShadow(
  run: RunSnapshot,
  store: Store,
  deps: DurableResumeShadowDeps = {},
): DurableResumeShadowClassification {
  const backend = deps.backend ?? getDurableBackend();
  const handle = backend.getWorkflow(run.id);
  if (handle?.status !== "paused" && handle?.status !== "running") return "not_shadow";
  const jobs = deps.jobs ?? jobTracker;
  if (jobs.has(run.id)) return "not_shadow";
  const controls = deps.stageControls ?? stageControlRegistry;
  const graph = expandWorkflowGraph(store.snapshot(), run.id);
  const controlRunIds = new Set<string>([run.id]);
  for (const stage of graph.stages) controlRunIds.add(stage.workflowGraphTarget.runId);
  if ([...controlRunIds].some((runId) => controls.run(runId).stages().length > 0)) return "not_shadow";
  if (!backend.isWorkflowLoadable(run.id) || !isDurableWorkflowResumable(handle)) return "ineligible";
  if (run.status !== "paused" || run.exitReason !== "quit" || run.resumable !== true) {
    store.recordRunPaused(run.id, undefined, { exitReason: "quit", resumable: true });
  }
  return "eligible";
}

/**
 * Reconcile a session-restored snapshot with an authoritative resumable
 * durable handle. Live jobs/controls win; zero-progress orphans remain intact.
 */
export function reconcileDurableResumeShadow(
  run: RunSnapshot,
  store: Store,
  deps: DurableResumeShadowDeps = {},
): boolean {
  return classifyDurableResumeShadow(run, store, deps) === "eligible";
}
