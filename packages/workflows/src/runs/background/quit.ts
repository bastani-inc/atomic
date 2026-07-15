import type { PauseResult } from "./status.js";
import { store as defaultStore } from "../../shared/store.js";
import type { Store } from "../../shared/store-public-types.js";
import type { StageSnapshot } from "../../shared/store-types.js";
import { expandWorkflowGraph } from "../../shared/expanded-workflow-graph.js";
import { topLevelWorkflowRuns } from "../../shared/run-visibility.js";
import {
  stageControlRegistry as defaultStageControlRegistry,
  type StageControlHandle,
  type StageControlRegistry,
} from "../foreground/stage-control-registry.js";
import { getDurableBackend } from "../../durable/factory.js";

export type QuitRunResult = PauseResult;
type QuitAllRunResult = QuitRunResult | {
  readonly ok: false;
  readonly runId: string;
  readonly reason: "pause_failed";
  readonly message: string;
};

/**
 * Gracefully quit workflow work without destructive cancellation.
 *
 * This is the graceful public quit primitive: it waits for every currently
 * controllable stage to acknowledge its pause, then annotates the run as
 * resumable via `/workflow resume`. It deliberately does NOT abort through the
 * cancellation registry or append a terminal `workflow.run.end` entry.
 * Destructive cancellation remains an internal lifecycle mechanism.
 */
export async function quitRun(
  runId: string,
  opts?: {
    store?: Store;
    stageControlRegistry?: StageControlRegistry;
  },
): Promise<QuitRunResult> {
  const activeStore = opts?.store ?? defaultStore;
  const registry = opts?.stageControlRegistry ?? defaultStageControlRegistry;
  const run = activeStore.runs().find((candidate) => candidate.id === runId);
  if (!run) return { ok: false, runId, reason: "not_found" };
  if (run.endedAt !== undefined) return { ok: false, runId, reason: "already_ended" };

  const handles = controllableHandles(activeStore, registry, runId);
  if (handles.length === 0) return { ok: false, runId, reason: "no_active_stages" };

  const paused: StageSnapshot[] = [];
  const pausedRunIds = new Set<string>();
  const pauseFailures: string[] = [];
  for (const { controlRunId, handle } of handles) {
    try {
      await handle.pause();
      pausedRunIds.add(controlRunId);
      const controlRun = activeStore.runs().find((candidate) => candidate.id === controlRunId);
      const stage = controlRun?.stages.find((candidate) => candidate.id === handle.stageId);
      if (stage !== undefined) paused.push(structuredClone(stage));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pauseFailures.push(`${controlRunId}/${handle.stageId}: ${message}`);
    }
  }
  if (pauseFailures.length > 0) {
    throw new Error(`Failed to pause workflow stages: ${pauseFailures.join("; ")}`);
  }

  const current = activeStore.runs().find((candidate) => candidate.id === runId);
  if (current === undefined) return { ok: false, runId, reason: "not_found" };
  if (current.endedAt !== undefined) return { ok: false, runId, reason: "already_ended" };
  for (const pausedRunId of pausedRunIds) activeStore.recordRunPaused(pausedRunId);
  activeStore.recordRunPaused(runId, undefined, { exitReason: "quit", resumable: true });
  markDurableQuit(runId);
  return { ok: true, runId, paused };
}

function controllableHandles(
  activeStore: Store,
  registry: StageControlRegistry,
  runId: string,
): Array<{ controlRunId: string; handle: StageControlHandle }> {
  const graph = expandWorkflowGraph(activeStore.snapshot(), runId);
  const controlRunIds = new Set<string>([runId]);
  for (const stage of graph.stages) controlRunIds.add(stage.workflowGraphTarget.runId);
  return [...controlRunIds].flatMap((controlRunId) =>
    registry.run(controlRunId).stages()
      .filter((handle) => handle.status === "running" || handle.status === "pending")
      .map((handle) => ({ controlRunId, handle })),
  );
}

function markDurableQuit(runId: string): void {
  try {
    const backend = getDurableBackend();
    if (backend.getWorkflow(runId) !== undefined) {
      backend.setWorkflowStatus(runId, "paused", undefined, true);
    }
  } catch {
    // Durable status is best-effort for custom backends; the store snapshot
    // remains the authoritative local resumability signal.
  }
}

export async function quitAllRuns(opts?: {
  store?: Store;
  stageControlRegistry?: StageControlRegistry;
}): Promise<QuitAllRunResult[]> {
  const activeStore = opts?.store ?? defaultStore;
  const inFlight = topLevelWorkflowRuns(activeStore.runs()).filter((run) => run.endedAt === undefined);
  const attempts = inFlight.map((run) =>
    quitRun(run.id, { store: activeStore, stageControlRegistry: opts?.stageControlRegistry })
  );
  const settled = await Promise.allSettled(attempts);
  return settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const runId = inFlight[index]!.id;
    return {
      ok: false,
      runId,
      reason: "pause_failed",
      message: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
  });
}
