import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import { createPostMortemStageHandle } from "../runs/foreground/postmortem-stage-chat.js";
import {
  stageControlRegistry as defaultStageControlRegistry,
  type StageControlHandle,
  type StageControlRegistry,
} from "../runs/foreground/stage-control-registry.js";
import type { DurableWorkflowBackend } from "./backend.js";
import {
  listOpenableCompletedWorkflows,
  completedWorkflowRunSnapshots,
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
  /** Seed lifecycle dedupe state before historical snapshots become observable. */
  readonly beforeRestore?: (snapshots: readonly RunSnapshot[]) => void;
}

interface CompletedChatRegistration {
  readonly handle: StageControlHandle;
  readonly unregister: () => void;
}

const completedChatRegistrations = new WeakMap<
  StageControlRegistry,
  Map<string, CompletedChatRegistration>
>();

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
  const snapshots = completedWorkflowRunSnapshots(deps.durableBackend, resolved.entry);
  const snapshot = snapshots.find((run) => run.id === resolved.snapshot.id) ?? resolved.snapshot;
  deps.beforeRestore?.(snapshots);
  for (const restored of snapshots) {
    const previous = deps.store.runs().find((run) => run.id === restored.id);
    if (previous !== undefined) deps.store.removeRun(previous.id);
    deps.store.recordRunStart(restored);
    registerCompletedChatHandles(restored, deps);
  }
  const hasReopenableStage = snapshots.some((run) =>
    run.stages.some((stage) => stage.sessionFile !== undefined)
  );
  return {
    ok: true,
    runId: snapshot.id,
    workflowId: snapshot.id,
    name: snapshot.name,
    message: `Opened completed durable workflow "${snapshot.name}" (${snapshot.id.slice(0, 8)}) for read-only inspection${hasReopenableStage ? " and follow-up chat" : ""}.`,
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
  const registrations = completedChatRegistrations.get(registry) ?? new Map();
  completedChatRegistrations.set(registry, registrations);
  const desiredKeys = new Set(
    snapshot.stages
      .filter((stage) => stage.sessionFile !== undefined)
      .map((stage) => completedChatKey(snapshot.id, stage.id)),
  );
  for (const [key, registration] of registrations) {
    if (!key.startsWith(`${snapshot.id}:`) || desiredKeys.has(key)) continue;
    removeCompletedChatRegistration(registrations, key, registration);
  }
  for (const stage of snapshot.stages) {
    if (stage.sessionFile === undefined) continue;
    const key = completedChatKey(snapshot.id, stage.id);
    const registration = registrations.get(key);
    const existing = registry.get(snapshot.id, stage.id);
    if (existing?.sessionFile === stage.sessionFile && !existing.isDisposed) continue;
    if (registration !== undefined) {
      removeCompletedChatRegistration(registrations, key, registration);
    } else if (existing !== undefined) {
      disposeCompletedChatHandle(existing);
    }
    const handle = createPostMortemStageHandle(snapshot.id, stage, stage.sessionFile, deps.adapters, deps.cwd, deps.defaultSessionDir);
    const unregister = registry.register(handle);
    registrations.set(key, { handle, unregister });
    registry.detachControl(snapshot.id, stage.id, handle);
  }
}

function completedChatKey(runId: string, stageId: string): string {
  return `${runId}:${stageId}`;
}

function removeCompletedChatRegistration(
  registrations: Map<string, CompletedChatRegistration>,
  key: string,
  registration: CompletedChatRegistration,
): void {
  registration.unregister();
  registrations.delete(key);
  disposeCompletedChatHandle(registration.handle);
}

function disposeCompletedChatHandle(handle: StageControlHandle): void {
  void Promise.resolve(handle.dispose?.()).catch((error: Error) => {
    console.warn("atomic-workflows: completed chat handle dispose failed", error);
  });
}
