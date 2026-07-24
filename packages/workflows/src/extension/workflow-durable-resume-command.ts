import { store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import { openWorkflowResumeSelector } from "../tui/workflow-resume-selector.js";
import type { GraphOverlayPort } from "../tui/overlay-adapter.js";
import { formatResumableWorkflowList } from "../durable/resume-catalog.js";
import { getDurableBackend } from "../durable/factory.js";
import { listOpenableCompletedWorkflows } from "../durable/completed-catalog.js";
import { openCompletedDurableWorkflow } from "../durable/completed-inspection.js";
import {
  deleteDurableWorkflowIfSafe,
  type DurableWorkflowDeleteOutcome,
} from "../durable/retention-policy.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import type { ExtensionRuntime } from "./runtime.js";
import type { ExtensionAPI, PiCommandContext } from "./public-types.js";
import type { WorkflowCommandReporter } from "./workflow-command-utils.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import { formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";
import { overlaySurfaceFromContext } from "./workflow-targets.js";

export interface WorkflowRunControlDeps {
  pi: ExtensionAPI;
  overlay: GraphOverlayPort;
  runtimeForContext: (ctx?: PiCommandContext) => ExtensionRuntime;
  ensureWorkflowResourcesLoaded: () => Promise<void> | void;
  /** Seed lifecycle state before the direct completed-inspection fallback restores history. */
  beforeRestoreCompleted?: (snapshots: readonly RunSnapshot[]) => void;
}

export interface WorkflowResumeCatalog {
  readonly resumable: readonly ResumableWorkflowEntry[];
  readonly completed: readonly ResumableWorkflowEntry[];
}

export interface WorkflowResumeTarget {
  readonly kind: "live" | "durable" | "completed";
  readonly workflowId: string;
  readonly name: string;
}

export type WorkflowResumeTargetResolution = WorkflowResumeTarget
  | { readonly kind: "ambiguous"; readonly matches: readonly WorkflowResumeTarget[] }
  | { readonly kind: "not_found" };

export async function prepareWorkflowResumeCatalog(
  runtime: ExtensionRuntime,
  activeLiveIds: ReadonlySet<string>,
  target?: string,
): Promise<WorkflowResumeCatalog> {
  const shared = await runtime.prepareDurableCatalog?.();
  const prepared = shared?.resumable ?? await runtime.prepareDurableResumable(target);
  const backend = getDurableBackend();
  const isDisplayLoadable = (entry: ResumableWorkflowEntry): boolean =>
    shared !== undefined || backend.isWorkflowLoadable(entry.workflowId);
  const resumable = filterSelectorDurableEntries(runtime, prepared)
    .filter((entry) => !activeLiveIds.has(entry.workflowId) && isDisplayLoadable(entry));
  const completed = shared?.completed ?? (runtime.prepareCompletedDurable !== undefined
    ? await runtime.prepareCompletedDurable()
    : listOpenableCompletedWorkflows(backend));
  return {
    resumable,
    completed: completed.filter((entry) => !activeLiveIds.has(entry.workflowId) && isDisplayLoadable(entry)),
  };
}

export function deleteWorkflowResumeEntry(workflowId: string): Promise<DurableWorkflowDeleteOutcome> {
  return deleteDurableWorkflowIfSafe(getDurableBackend(), workflowId, (candidateId) => {
    const run = store.runs().find((candidate) => candidate.id === candidateId);
    return run !== undefined && run.status !== "completed"
      && (run.endedAt === undefined || run.status === "paused");
  });
}

export async function handleDurableResume(
  target: string | undefined,
  ctx: PiCommandContext,
  reporter: WorkflowCommandReporter,
  deps: WorkflowRunControlDeps,
  preparedCatalog?: WorkflowResumeCatalog,
): Promise<boolean> {
  const print = (message: string): void => reporter.info(message);
  const fail = (message: string): void => reporter.error(message);
  try {
    await deps.ensureWorkflowResourcesLoaded();
  } catch (error) {
    ctx.ui?.notify(formatWorkflowResourceLoadWarning(error), "warning");
  }
  const runtime = deps.runtimeForContext(ctx);
  const policy = workflowPolicyFromContext(ctx);
  const catalog = preparedCatalog ?? await prepareWorkflowResumeCatalog(runtime, new Set(), target);
  const allOpenable = [...catalog.resumable, ...catalog.completed];

  if (target !== undefined) {
    const resolved = resolveWorkflowResumeTarget(
      target,
      [],
      catalog.resumable,
      // Reuse the catalog prepared above instead of re-enumerating the durable
      // directory a second time for the same command invocation.
      catalog.completed,
    );
    if (resolved.kind === "ambiguous") {
      fail(`Ambiguous workflow prefix "${target}" matches: ${formatMatches(resolved.matches)}`);
      return true;
    }
    if (resolved.kind === "completed") {
      return openCompletedTarget(resolved.workflowId, catalog.completed, ctx, reporter, deps, runtime);
    }
    if (resolved.kind === "durable") {
      return await resumeDurableTarget(resolved.workflowId, ctx, reporter, deps, runtime);
    }

    const completedAttempt = openCompleted(runtime, target, catalog.completed, deps.beforeRestoreCompleted);
    if (!completedAttempt.ok && completedAttempt.reason !== "not_found") {
      fail(completedAttempt.message);
      return true;
    }
    const result = await runtime.resumeDurableWorkflow(target, { policy });
    fail(allOpenable.length === 0
      ? result.message
      : `${result.message}\n\n${formatResumableWorkflowList(allOpenable)}`);
    return true;
  }

  if (allOpenable.length === 0) {
    fail("No resumable or completed durable workflows found. Usage: /workflow resume <id> (or /resume for Atomic sessions).");
    return true;
  }
  if (!policy.allowInputPicker) {
    const instruction = catalog.completed.length === 0 ? "Resume with" : "Resume/open with";
    print(`${formatResumableWorkflowList(allOpenable)}\n\n${instruction}: /workflow resume <id>`);
    return true;
  }
  let picked: Awaited<ReturnType<typeof openWorkflowResumeSelector>>;
  try {
    picked = await openWorkflowResumeSelector(
      ctx.ui,
      [],
      // Catalog already prepared above; resolve it immediately with no rescan.
      () => Promise.resolve({ durable: catalog.resumable, completed: catalog.completed }),
      { deleteWorkflow: deleteWorkflowResumeEntry },
    );
  } catch (error) {
    // No fallback: a host without the session-picker capability fails the
    // resume command with one actionable message.
    fail(error instanceof Error ? error.message : String(error));
    return true;
  }
  if (picked.result.kind === "durable") {
    return resumeDurableTarget(picked.result.workflowId, ctx, reporter, deps, runtime);
  }
  if (picked.result.kind === "completed") {
    return openCompletedTarget(picked.result.workflowId, catalog.completed, ctx, reporter, deps, runtime);
  }
  return true;
}

function filterSelectorDurableEntries(
  runtime: ExtensionRuntime,
  entries: readonly ResumableWorkflowEntry[],
): readonly ResumableWorkflowEntry[] {
  const registry = runtime.registry as { has(name: string): boolean } | undefined;
  if (registry === undefined) return entries;
  return entries.filter((entry) => {
    const requiresDefinition = entry.status === "running" || entry.status === "failed" || entry.status === "blocked";
    return !requiresDefinition || registry.has(entry.name);
  });
}

export function resolveWorkflowResumeTarget(
  target: string,
  liveRuns: readonly RunSnapshot[],
  resumable: readonly ResumableWorkflowEntry[],
  completed: readonly ResumableWorkflowEntry[],
): WorkflowResumeTargetResolution {
  const targets = new Map<string, WorkflowResumeTarget>();
  for (const entry of resumable) {
    targets.set(entry.workflowId, { kind: "durable", workflowId: entry.workflowId, name: entry.name });
  }
  for (const entry of completed) {
    targets.set(entry.workflowId, { kind: "completed", workflowId: entry.workflowId, name: entry.name });
  }
  for (const run of liveRuns.filter(isExplicitResumeCandidate)) {
    targets.set(run.id, {
      kind: run.status === "completed" ? "completed" : "live",
      workflowId: run.id,
      name: run.name,
    });
  }
  const exact = targets.get(target);
  if (exact !== undefined) return exact;
  const matches = [...targets.values()].filter((candidate) => candidate.workflowId.startsWith(target));
  if (matches.length === 0) return { kind: "not_found" };
  if (matches.length === 1) return matches[0]!;
  return { kind: "ambiguous", matches };
}

function isExplicitResumeCandidate(run: RunSnapshot): boolean {
  if (run.status === "completed" || run.status === "paused" || run.exitReason === "quit") return true;
  if (run.stages.some((stage) => stage.status === "paused")) return true;
  if (run.status === "failed") return run.resumable !== false;
  if (run.endedAt !== undefined) return false;
  if (run.status === "running") return true;
  return run.resumable === true && run.failureRecoverability === "recoverable";
}

async function resumeDurableTarget(
  workflowId: string,
  ctx: PiCommandContext,
  reporter: WorkflowCommandReporter,
  deps: WorkflowRunControlDeps,
  runtime: ExtensionRuntime,
): Promise<boolean> {
  const result = await runtime.resumeDurableWorkflow(workflowId, { policy: workflowPolicyFromContext(ctx) });
  if (!result.ok) reporter.error(result.message);
  else {
    reporter.info(result.message);
    if (workflowPolicyFromContext(ctx).allowInputPicker) {
      deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
    }
  }
  return true;
}

function openCompletedTarget(
  workflowId: string,
  catalog: readonly ResumableWorkflowEntry[],
  ctx: PiCommandContext,
  reporter: WorkflowCommandReporter,
  deps: WorkflowRunControlDeps,
  runtime: ExtensionRuntime,
): boolean {
  const result = openCompleted(runtime, workflowId, catalog, deps.beforeRestoreCompleted);
  if (!result.ok) reporter.error(result.message);
  else {
    reporter.info(result.message);
    if (workflowPolicyFromContext(ctx).allowInputPicker) {
      deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
    }
  }
  return true;
}

function openCompleted(
  runtime: ExtensionRuntime,
  workflowIdOrPrefix: string,
  catalog: readonly ResumableWorkflowEntry[],
  beforeRestoreCompleted?: (snapshots: readonly RunSnapshot[]) => void,
) {
  return runtime.openCompletedDurableWorkflow?.(workflowIdOrPrefix, catalog)
    ?? openCompletedDurableWorkflow(workflowIdOrPrefix, {
      durableBackend: getDurableBackend(),
      store,
      beforeRestore: beforeRestoreCompleted,
    }, catalog);
}

function formatMatches(entries: readonly WorkflowResumeTarget[]): string {
  return entries.map((entry) => `${entry.name} (${entry.workflowId.slice(0, 8)})`).join(", ");
}
