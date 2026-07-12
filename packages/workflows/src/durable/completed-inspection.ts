import type { Store } from "../shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import { createStageContext, type StageAdapters } from "../runs/foreground/stage-runner.js";
import {
  stageControlRegistry as defaultStageControlRegistry,
  type AgentSessionEventListener,
  type StageControlHandle,
  type StageControlRegistry,
} from "../runs/foreground/stage-control-registry.js";
import type { DurableWorkflowBackend } from "./backend.js";
import {
  listOpenableCompletedWorkflows,
  resolveCompletedWorkflow,
} from "./completed-catalog.js";
import type { ResumableWorkflowEntry } from "./types.js";

export type OpenCompletedDurableResult =
  | { readonly ok: true; readonly runId: string; readonly workflowId: string; readonly name: string; readonly message: string }
  | { readonly ok: false; readonly reason: "not_found" | "ambiguous" | "stale" | "active"; readonly message: string };

export interface OpenCompletedDurableDeps {
  readonly durableBackend: DurableWorkflowBackend;
  readonly store: Store;
  readonly adapters?: StageAdapters;
  readonly stageControlRegistry?: StageControlRegistry;
  readonly cwd?: string;
  readonly defaultSessionDir?: string;
}

/**
 * Open a completed durable workflow as an immutable run snapshot. The only
 * mutable surface is a lazily reopened stage chat, which appends follow-up
 * conversation to its retained Atomic session without dispatching the workflow.
 */
export function openCompletedDurableWorkflow(
  workflowIdOrPrefix: string,
  deps: OpenCompletedDurableDeps,
  catalog: readonly ResumableWorkflowEntry[] = listOpenableCompletedWorkflows(deps.durableBackend),
): OpenCompletedDurableResult {
  const resolved = resolveCompletedWorkflow(workflowIdOrPrefix, deps.durableBackend, catalog);
  if (resolved.kind === "not_found") {
    return failure("not_found", `No completed durable workflow found for id/prefix: ${workflowIdOrPrefix}`);
  }
  if (resolved.kind === "ambiguous") {
    const matches = resolved.matches.map((entry) => `${entry.name} (${entry.workflowId.slice(0, 8)})`).join(", ");
    return failure("ambiguous", `Ambiguous completed workflow prefix "${workflowIdOrPrefix}" matches: ${matches}`);
  }
  if (resolved.kind === "stale") {
    return failure(
      "stale",
      `Completed workflow ${resolved.entry.workflowId.slice(0, 8)} is stale or missing durable checkpoint/session data and cannot be opened.`,
    );
  }

  const existing = deps.store.runs().find((run) => run.id === resolved.snapshot.id);
  if (existing !== undefined && existing.status !== "completed") {
    return failure(
      "active",
      `Workflow ${resolved.snapshot.id.slice(0, 8)} is already active in this session; attach with /workflow connect ${resolved.snapshot.id.slice(0, 8)} instead.`,
    );
  }
  const snapshot = resolved.snapshot;
  if (existing !== undefined) deps.store.removeRun(existing.id);
  deps.store.recordRunStart(snapshot);
  registerCompletedChatHandles(snapshot, deps);
  return {
    ok: true,
    runId: snapshot.id,
    workflowId: snapshot.id,
    name: snapshot.name,
    message: `Opened completed durable workflow "${snapshot.name}" (${snapshot.id.slice(0, 8)}) for read-only inspection and follow-up chat.`,
  };
}

function failure(
  reason: "not_found" | "ambiguous" | "stale" | "active",
  message: string,
): OpenCompletedDurableResult {
  return { ok: false, reason, message };
}

function registerCompletedChatHandles(
  snapshot: RunSnapshot,
  deps: OpenCompletedDurableDeps,
): void {
  if (deps.adapters?.agentSession === undefined) return;
  const registry = deps.stageControlRegistry ?? defaultStageControlRegistry;
  for (const stage of snapshot.stages) {
    if (stage.sessionFile === undefined || registry.get(snapshot.id, stage.id) !== undefined) continue;
    const handle = createCompletedChatHandle(snapshot, stage, stage.sessionFile, deps.adapters, deps.cwd, deps.defaultSessionDir);
    registry.register(handle);
    registry.detachControl(snapshot.id, stage.id, handle);
  }
}

function createCompletedChatHandle(
  run: RunSnapshot,
  stage: StageSnapshot,
  sessionFile: string,
  adapters: StageAdapters,
  cwd: string | undefined,
  defaultSessionDir: string | undefined,
): StageControlHandle {
  const context = createStageContext({
    runId: run.id,
    stageId: stage.id,
    stageName: stage.name,
    adapters,
    stageOptions: {
      resumeFromSessionFile: sessionFile,
      ...(cwd !== undefined ? { cwd } : {}),
    },
    ...(defaultSessionDir !== undefined ? { defaultSessionDir } : {}),
  });
  let disposed = false;
  const ensureAttached = async (): Promise<void> => {
    if (disposed) throw new Error(`Completed stage chat "${stage.name}" is closed.`);
    if (context.__sessionMeta().sessionFile === undefined) {
      await context.__ensureSessionFromFile(sessionFile);
    }
  };
  return {
    runId: run.id,
    stageId: stage.id,
    stageName: stage.name,
    status: "completed",
    get sessionId() { return context.__sessionMeta().sessionId ?? stage.sessionId; },
    get sessionFile() { return context.__sessionMeta().sessionFile ?? sessionFile; },
    get isStreaming() { return context.isStreaming; },
    get isDisposed() { return disposed; },
    get messages() { return context.messages; },
    get agentSession() { return context.__agentSession(); },
    async ensureAttached() { await ensureAttached(); },
    async prompt(text: string) {
      await ensureAttached();
      await context.prompt(text);
    },
    async steer(text: string) {
      await ensureAttached();
      await context.steer(text);
    },
    async followUp(text: string) {
      await ensureAttached();
      await context.followUp(text);
    },
    async pause() {
      throw new Error("Completed workflow snapshots cannot be paused or resumed.");
    },
    async resume(message?: string) {
      if (message !== undefined && message.trim().length > 0) {
        await ensureAttached();
        await context.prompt(message);
      }
    },
    subscribe(listener: AgentSessionEventListener) { return context.subscribe(listener); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await context.__dispose();
    },
  };
}
