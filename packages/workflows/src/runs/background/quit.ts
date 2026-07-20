import type { PauseResult } from "./status.js";
import { store as defaultStore } from "../../shared/store.js";
import type { Store } from "../../shared/store-public-types.js";
import type { RunSnapshot, StageSnapshot } from "../../shared/store-types.js";
import { expandWorkflowGraph } from "../../shared/expanded-workflow-graph.js";
import { topLevelWorkflowRuns } from "../../shared/run-visibility.js";
import {
  stageControlRegistry as defaultStageControlRegistry,
  type StageControlHandle,
  type StageControlRegistry,
} from "../foreground/stage-control-registry.js";
import { getDurableBackend } from "../../durable/factory.js";
import type { DurableWorkflowBackend } from "../../durable/backend.js";
import { recordRunTimingCheckpoint } from "../../durable/run-timing.js";
import {
  getLoadableDurableWorkflow,
  transitionDurableWorkflowStatus,
} from "../../durable/workflow-status-transition.js";

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

  const graph = expandWorkflowGraph(activeStore.snapshot(), runId);
  const handles = controllableHandles(activeStore, registry, runId);
  const promptStages = graph.stages.filter((stage) =>
    stage.pendingPrompt !== undefined || stage.inputRequest !== undefined || stage.status === "awaiting_input"
  );
  const hasPausedState = run.status === "paused" || graph.stages.some((stage) => stage.status === "paused");
  if (handles.length === 0 && promptStages.length === 0 && !hasPausedState) {
    return { ok: false, runId, reason: "no_active_stages" };
  }

  const paused: StageSnapshot[] = [];
  const pausedRunIds = new Set<string>();
  const pausable = handles.filter(({ handle }) => handle.status !== "paused");
  const settled = await Promise.allSettled(pausable.map(({ handle }) => handle.pause()));
  const pauseFailures: string[] = [];
  settled.forEach((result, index) => {
    const target = pausable[index]!;
    if (result.status === "rejected") {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      pauseFailures.push(`${target.controlRunId}/${target.handle.stageId}: ${message}`);
      return;
    }
    const controlRun = activeStore.runs().find((candidate) => candidate.id === target.controlRunId);
    if (controlRun?.endedAt !== undefined) return;
    activeStore.recordStagePaused(target.controlRunId, target.handle.stageId);
    const stage = activeStore.runs().find((candidate) => candidate.id === target.controlRunId)
      ?.stages.find((candidate) => candidate.id === target.handle.stageId);
    if (stage?.status === "paused") {
      pausedRunIds.add(target.controlRunId);
      paused.push(structuredClone(stage));
    }
  });
  if (pauseFailures.length > 0) {
    throw new Error(`Failed to pause workflow stages: ${pauseFailures.join("; ")}`);
  }

  for (const promptStage of promptStages) {
    const target = promptStage.workflowGraphTarget;
    activeStore.recordStagePaused(target.runId, target.stageId);
    pausedRunIds.add(target.runId);
  }
  const current = activeStore.runs().find((candidate) => candidate.id === runId);
  if (current === undefined) return { ok: false, runId, reason: "not_found" };
  if (current.endedAt !== undefined) return { ok: false, runId, reason: "already_ended" };
  const durableTransition = await markDurableQuit(runId, current);
  if (durableTransition === "refused") return { ok: false, runId, reason: "already_ended" };
  for (const pausedRunId of pausedRunIds) activeStore.recordRunPaused(pausedRunId);
  activeStore.recordRunPaused(runId, undefined, { exitReason: "quit", resumable: true });
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
      .filter((handle) =>
        handle.status === "running" || handle.status === "pending" ||
        handle.status === "awaiting_input" || handle.status === "paused"
      )
      .map((handle) => ({ controlRunId, handle })),
  );
}

async function markDurableQuit(runId: string, run: RunSnapshot): Promise<"transitioned" | "not_needed" | "refused"> {
  const backend = discoverDurableQuitBackend(runId);
  if (backend === undefined) return "not_needed";
  // The workflow is durably tracked, so a failure to persist the paused
  // transition or flush it must surface. Swallowing it here would let quitRun
  // record a resumable pause that no future process could actually resume from.
  const transitioned = await transitionDurableWorkflowStatus(
    backend, runId, ["running", "paused"], "paused", undefined, true,
  );
  if (!transitioned) return "refused";
  // Persist the exact accumulated run elapsed at quit time so a later durable
  // resume seeds the total workflow duration with prior-session time.
  recordRunTimingCheckpoint(backend, run);
  await backend.flush();
  return "transitioned";
}

/**
 * Resolve the durable backend only when `runId` is durably tracked. Discovery
 * stays best-effort for custom backends that throw on unsupported inspection;
 * the persistence writes performed after a positive match are intentionally
 * left to propagate so genuine durable failures are not masked.
 */
function discoverDurableQuitBackend(runId: string): DurableWorkflowBackend | undefined {
  try {
    const backend = getDurableBackend();
    return getLoadableDurableWorkflow(backend, runId) === undefined ? undefined : backend;
  } catch {
    return undefined;
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
