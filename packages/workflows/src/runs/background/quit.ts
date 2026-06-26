import { pauseRun, type PauseResult } from "./status.js";
import { store as defaultStore } from "../../shared/store.js";
import type { Store } from "../../shared/store-public-types.js";
import { topLevelWorkflowRuns } from "../../shared/run-visibility.js";
import type { StageControlRegistry } from "../foreground/stage-control-registry.js";
import { getDurableBackend } from "../../durable/factory.js";

export type QuitRunResult = PauseResult;

/**
 * Quit/detach a workflow UI without authoritatively killing the workflow.
 *
 * This is the graph-panel/orchestrator close affordance: it pauses any live
 * stage handles when possible, annotates the run as resumable via
 * `/workflow resume`, and deliberately does NOT abort through the cancellation
 * registry or append a terminal `workflow.run.end` entry. `/workflow kill`
 * remains the only explicit non-resumable manual kill path.
 */
export function quitRun(
  runId: string,
  opts?: {
    store?: Store;
    stageControlRegistry?: StageControlRegistry;
  },
): QuitRunResult {
  const activeStore = opts?.store ?? defaultStore;
  const run = activeStore.runs().find((candidate) => candidate.id === runId);
  if (!run) return { ok: false, runId, reason: "not_found" };
  if (run.endedAt !== undefined) return { ok: false, runId, reason: "already_ended" };

  const paused = pauseRun(runId, opts);
  if (!paused.ok && paused.reason !== "no_active_stages") return paused;
  activeStore.recordRunPaused(runId, undefined, { exitReason: "quit", resumable: true });
  // Mark the durable handle inactive so `/workflow resume` in this or another
  // session can discover it again. While the run stays `running` in the store
  // and (after a fresh dispatch) in the durable backend, it is hidden from the
  // resume selector and refused on resume; quitting flips durable to `paused`.
  markDurableQuit(runId);
  return paused.ok ? paused : { ok: true, runId, paused: [] };
}

function markDurableQuit(runId: string): void {
  let backend;
  try {
    backend = getDurableBackend();
  } catch {
    return;
  }
  if (backend.getWorkflow(runId) !== undefined) {
    backend.setWorkflowStatus(runId, "paused", undefined, true);
  }
}

export function quitAllRuns(opts?: {
  store?: Store;
  stageControlRegistry?: StageControlRegistry;
}): QuitRunResult[] {
  const activeStore = opts?.store ?? defaultStore;
  const inFlight = topLevelWorkflowRuns(activeStore.runs()).filter((r) => r.endedAt === undefined);
  return inFlight.map((r) => quitRun(r.id, { store: activeStore, stageControlRegistry: opts?.stageControlRegistry }));
}
