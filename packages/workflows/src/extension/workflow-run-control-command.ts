import { cancellationRegistry } from "../runs/background/cancellation-registry.js";
import { interruptAllRuns, interruptRun, killAllRuns, killRun, pauseRun, resumeRun } from "../runs/background/status.js";
import type { WorkflowPersistencePort } from "../shared/types.js";
import { store } from "../shared/store.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import { renderSessionList } from "../tui/session-list.js";
import { openKillConfirm, openSessionPicker } from "../tui/session-overlays.js";
import { openWorkflowResumeSelector } from "../tui/workflow-resume-selector.js";
import { deriveGraphTheme } from "../tui/graph-theme.js";
import { emitChatSurface } from "../tui/chat-surface-message.js";
import type { GraphOverlayPort } from "../tui/overlay-adapter.js";
import type { ExtensionRuntime } from "./runtime.js";
import type { ExtensionAPI, PiCommandContext } from "./public-types.js";
import type { WorkflowCommandReporter } from "./workflow-command-utils.js";
import { stripYesFlag } from "./workflow-command-utils.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import { formatResumableWorkflowList } from "../durable/resume-catalog.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import {
  formatAlreadyEndedRetainedMessage,
  overlaySurfaceFromContext,
  resolveRunIdPrefix,
  resolveStageTarget,
} from "./workflow-targets.js";
import { formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";

export interface WorkflowRunControlDeps {
  pi: ExtensionAPI;
  overlay: GraphOverlayPort;
  getPersistence: () => WorkflowPersistencePort | undefined;
  runtimeForContext: (ctx?: PiCommandContext) => ExtensionRuntime;
  ensureWorkflowResourcesLoaded: () => Promise<void> | void;
}

function resolveAttachStageId(runId: string, stageTarget: string | undefined): string | undefined | false {
  if (!stageTarget) return undefined;
  const run = store.runs().find((r) => r.id === runId);
  if (!run) return undefined;
  const exact = run.stages.find((s) => s.id === stageTarget);
  const prefix = exact ?? run.stages.find((s) => s.id.startsWith(stageTarget));
  const byName = prefix ?? run.stages.find((s) => s.name === stageTarget);
  return byName?.id ?? false;
}

function filterSelectorDurableEntries(
  runtime: ExtensionRuntime,
  entries: readonly ResumableWorkflowEntry[],
): readonly ResumableWorkflowEntry[] {
  const registry = runtime.registry as { has(name: string): boolean } | undefined;
  if (registry === undefined) return entries;
  return entries.filter((entry) => {
    const requiresCurrentDefinition = entry.status === "running" || entry.status === "failed" || entry.status === "blocked";
    return !requiresCurrentDefinition || registry.has(entry.name);
  });
}


async function handleDurableResume(
  target: string | undefined,
  ctx: PiCommandContext,
  reporter: WorkflowCommandReporter,
  deps: WorkflowRunControlDeps,
): Promise<boolean> {
  const print = (msg: string): void => reporter.info(msg);
  const fail = (msg: string): void => reporter.error(msg);
  try {
    await deps.ensureWorkflowResourcesLoaded();
  } catch (error) {
    ctx.ui?.notify(formatWorkflowResourceLoadWarning(error), "warning");
  }
  const runtime = deps.runtimeForContext(ctx);
  const policy = workflowPolicyFromContext(ctx);
  // Hydrate the durable backend from DBOS (if configured) before listing so a
  // fresh process discovers workflows persisted by a prior session.
  const prepared = await runtime.prepareDurableResumable(target);
  const durable = filterSelectorDurableEntries(runtime, prepared);
  if (target !== undefined) {
    // Attempt resume by id/prefix against the durable catalog.
    const result = runtime.resumeDurableWorkflow(target, { policy });
    if (result.ok) {
      print(result.message);
      // Open/connect the overlay to the resumed run, analogous to live resume.
      if (policy.allowInputPicker) deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
      return true;
    }
    // Not a durable workflow either — surface the catalog for discovery.
    if (durable.length > 0) {
      fail(`${result.message}\n\n${formatResumableWorkflowList(durable)}`);
    } else {
      fail(result.message);
    }
    return true;
  }
  // No target: show the durable selector when interactive, otherwise print.
  if (durable.length === 0) {
    fail("No resumable durable workflows found. Usage: /workflow resume <id> (or /resume for Atomic sessions).");
    return true;
  }
  if (!policy.allowInputPicker) {
    print(`${formatResumableWorkflowList(durable)}\n\nResume with: /workflow resume <id>`);
    return true;
  }
  const picked = await openWorkflowResumeSelector(ctx.ui, [], durable);
  if (picked.kind === "durable") {
    const result = runtime.resumeDurableWorkflow(picked.workflowId, { policy });
    if (result.ok) {
      print(result.message);
      if (policy.allowInputPicker) deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
    } else {
      fail(result.message);
    }
  }
  if (picked.kind !== "durable") {
    print(`${formatResumableWorkflowList(durable)}\n\nResume with: /workflow resume <id>`);
  }
  return true;
}

export async function handleRunControlCommand(
  action: "connect" | "interrupt" | "kill" | "attach" | "pause" | "resume",
  rest: string[],
  ctx: PiCommandContext,
  reporter: WorkflowCommandReporter,
  deps: WorkflowRunControlDeps,
): Promise<boolean> {
  const policy = workflowPolicyFromContext(ctx);
  const print = (msg: string): void => reporter.info(msg);
  const fail = (msg: string): void => reporter.error(msg);
  const canOpenPicker = (ui: PiCommandContext["ui"] | undefined): boolean =>
    policy.allowInputPicker && typeof ui?.custom === "function";
  const ensureWorkflowResourcesVisible = async (): Promise<void> => {
    try {
      await deps.ensureWorkflowResourcesLoaded();
    } catch (error) {
      ctx.ui?.notify(formatWorkflowResourceLoadWarning(error), "warning");
    }
  };
  const confirmationPrompt = policy.allowHumanInput && typeof ctx.ui?.confirm === "function"
    ? ctx.ui.confirm.bind(ctx.ui)
    : undefined;
  const theme = deriveGraphTheme({});
  const failHeadlessAttachCommand = (targetAction: "connect" | "attach", runId: string, stageId?: string): boolean => {
    if (policy.allowInputPicker) return false;
    const displayTarget = stageId ? `${runId.slice(0, 8)} stage ${stageId.slice(0, 8)}` : runId.slice(0, 8);
    fail(
      `/workflow ${targetAction} requires an interactive UI surface and cannot attach in non-interactive mode. ` +
        `Target: ${displayTarget}. Use /workflow status ${runId.slice(0, 8)} or the workflow tool's status/stages/transcript actions for non-interactive inspection.`,
    );
    return true;
  };

  if (action === "connect") {
    const target = rest.find((t) => !t.startsWith("--"));
    if (!target) {
      const ui = ctx.ui;
      if (!canOpenPicker(ui)) {
        fail(`${renderSessionList(store.runs(), { theme, includeAll: true })}\n\nPicker requires an interactive UI surface. Pass a runId: /workflow connect <id>`);
        return true;
      }
      const result = await openSessionPicker(ui, store, theme, "connect");
      if (result.kind === "close") return true;
      if (result.kind === "connect") {
        deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
        return true;
      }
      if (result.kind === "kill") {
        const run = store.runs().find((r) => r.id === result.runId);
        if (!run) {
          fail(`Run not found: ${result.runId}`);
          return true;
        }
        if (run.endedAt !== undefined) {
          print(formatAlreadyEndedRetainedMessage(result.runId));
          return true;
        }
        const confirmed = await openKillConfirm(ui, run, theme);
        if (!confirmed) {
          print(`Cancelled. Run ${result.runId.slice(0, 8)} is still active.`);
          return true;
        }
        const killed = killRun(result.runId, { cancellation: cancellationRegistry, persistence: deps.getPersistence() });
        if (killed.ok) {
          emitChatSurface(deps.pi, { kind: "killed", run, previousStatus: killed.previousStatus });
          print(`Run ${killed.runId.slice(0, 8)} killed and retained for inspection.`);
        } else if (killed.reason === "already_ended") {
          print(formatAlreadyEndedRetainedMessage(killed.runId));
        } else {
          fail(`Run not found: ${result.runId.slice(0, 8)}.`);
        }
      }
      return true;
    }
    const resolved = resolveRunIdPrefix(target);
    if (resolved.kind === "not_found") {
      fail(`Run not found: ${target}\n\n${renderSessionList(store.runs(), { theme, includeAll: true })}`);
      return true;
    }
    if (resolved.kind === "ambiguous") {
      fail(`Ambiguous run prefix "${target}" matches: ${resolved.matches.map((id) => id.slice(0, 12)).join(", ")}`);
      return true;
    }
    if (failHeadlessAttachCommand("connect", resolved.runId)) return true;
    if (policy.allowInputPicker) deps.overlay.open(resolved.runId, overlaySurfaceFromContext(ctx));
    print(`Attached to ${resolved.runId.slice(0, 8)}. h/ctrl+d hide · q quit (resumable via /workflow resume) · esc close.`);
    return true;
  }

  if (action === "interrupt" || action === "kill") {
    const { tokens, yes } = stripYesFlag(rest);
    let target = tokens.find((t) => !t.startsWith("--"));
    const wantsAll = tokens.includes("--all");
    const noun = action === "kill" ? "kill" : "interrupt";
    if (!target && !wantsAll) {
      target = store.activeRunId() ?? undefined;
      if (!target) {
        fail(`No in-flight runs to ${noun}.`);
        return true;
      }
    }
    if (wantsAll) {
      const inFlight = topLevelWorkflowRuns(store.runs()).filter((r) => r.endedAt === undefined);
      if (inFlight.length === 0) {
        fail(`No in-flight runs to ${noun}.`);
        return true;
      }
      if (!yes && confirmationPrompt) {
        const title = action === "kill"
          ? `Kill ${inFlight.length} in-flight workflow runs? Killed runs are retained for inspection.`
          : `Interrupt all ${inFlight.length} in-flight workflow runs?`;
        const body = `${action === "kill" ? "Aborts" : "Pauses"}: ${inFlight.map((r) => `${r.name} (${r.id.slice(0, 8)})`).join(", ")}`;
        if (!(await confirmationPrompt(title, body))) {
          print("Cancelled.");
          return true;
        }
      }
      const results = action === "kill"
        ? killAllRuns({ cancellation: cancellationRegistry, persistence: deps.getPersistence() })
        : interruptAllRuns();
      const changed = results.filter((r) => r.ok).length;
      if (changed > 0) print(action === "kill" ? `Killed and retained ${changed} run(s) for inspection.` : `Interrupted ${changed} run(s).`);
      else fail(`No in-flight runs to ${noun}.`);
      return true;
    }
    const resolved = resolveRunIdPrefix(target!);
    if (resolved.kind === "not_found") {
      fail(`Run not found: ${target}`);
      return true;
    }
    if (resolved.kind === "ambiguous") {
      fail(`Ambiguous run prefix "${target}" matches multiple runs: ${resolved.matches.map((id) => id.slice(0, 12)).join(", ")}`);
      return true;
    }
    const run = store.runs().find((r) => r.id === resolved.runId);
    if (action === "kill" && run?.endedAt !== undefined) {
      print(formatAlreadyEndedRetainedMessage(resolved.runId));
      return true;
    }
    if (!yes && run && (action === "kill" || run.endedAt === undefined) && confirmationPrompt) {
      const confirmed = action === "kill"
        ? await openKillConfirm(ctx.ui, run, theme)
        : await confirmationPrompt(`Interrupt workflow run ${run.name} (${run.id.slice(0, 8)})?`, "Pauses live work so it can be resumed later.");
      if (!confirmed) {
        print(action === "kill"
          ? `Cancelled. Run ${resolved.runId.slice(0, 8)} is still in history/status.`
          : `Cancelled. Run ${resolved.runId.slice(0, 8)} is still active.`);
        return true;
      }
    }
    if (action === "kill") {
      const result = killRun(resolved.runId, { cancellation: cancellationRegistry, persistence: deps.getPersistence() });
      if (result.ok) {
        if (run) emitChatSurface(deps.pi, { kind: "killed", run, previousStatus: result.previousStatus });
        print(`Run ${result.runId.slice(0, 8)} killed and retained for inspection (was ${result.previousStatus}).`);
      } else if (result.reason === "already_ended") print(formatAlreadyEndedRetainedMessage(result.runId));
      else fail(`Run not found: ${target}`);
      return true;
    }
    const result = interruptRun(resolved.runId);
    if (result.ok) print(`Run ${result.runId.slice(0, 8)} interrupted and can be resumed.`);
    else fail(result.reason === "not_found" ? `Run not found: ${target}` : result.reason === "already_ended" ? `Run already ended: ${target}` : result.reason === "stage_not_found" ? `Stage not found for run ${resolved.runId.slice(0, 8)}.` : `No active stages to interrupt on run ${resolved.runId.slice(0, 8)}.`);
    return true;
  }

  if (action === "attach" || action === "pause" || action === "resume") {
    const target = rest[0];
    const stageTarget = rest[1];
    const message = action === "resume" ? rest.slice(2).join(" ").trim() || undefined : undefined;
    let runId: string;
    if (!target) {
      const ui = ctx.ui;
      if (!canOpenPicker(ui)) {
        if (action === "pause") {
          const active = topLevelWorkflowRuns(store.runs()).filter((r) => r.endedAt === undefined);
          fail(active.length === 0 ? "No active runs to pause." : `Picker requires an interactive UI surface. Active runs:\n${active.map((r) => `  ${r.id.slice(0, 8)}  ${r.name}`).join("\n")}\n\nUsage: /workflow pause <runId> [stageId]`);
        } else if (action === "attach") {
          fail(`${renderSessionList(store.runs(), { theme, includeAll: true })}\n\nPicker requires an interactive UI surface. Pass a runId: /workflow attach <id> [stageId]`);
        } else {
          // resume: show cross-session durable catalog in headless/print mode.
          return await handleDurableResume(undefined, ctx, reporter, deps);
        }
        return true;
      }
      if (action === "resume") {
        // Only inactive workflows belong in the resume selector. Live runs:
        // show paused (quit) or recoverably-failed runs; actively-running live
        // runs are hidden (resuming one that is executing would double-dispatch).
        const liveRuns = topLevelWorkflowRuns(store.runs()).filter((run) =>
          run.status === "paused" || (run.status === "failed" && run.resumable !== false),
        );
        // Durable entries: a `running` durable handle may be a crashed process
        // (cross-session crash recovery), so it stays selectable UNLESS it
        // matches an actively-executing live run in this session.
        const activeLiveIds = new Set(
          topLevelWorkflowRuns(store.runs())
            .filter((run) => run.endedAt === undefined && run.status === "running" && run.exitReason !== "quit")
            .map((run) => run.id),
        );
        let durableEntries: readonly ResumableWorkflowEntry[];
        await ensureWorkflowResourcesVisible();
        const runtime = deps.runtimeForContext(ctx);
        try {
          const prepared = await runtime.prepareDurableResumable(undefined);
          durableEntries = filterSelectorDurableEntries(runtime, prepared)
            .filter((entry) => !activeLiveIds.has(entry.workflowId));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          fail(`Failed to list resumable workflows: ${message}`);
          return true;
        }
        const picked = await openWorkflowResumeSelector(ctx.ui, liveRuns, durableEntries);
        if (picked.kind === "durable") return await handleDurableResume(picked.workflowId, ctx, reporter, deps);
        if (picked.kind === "live") {
          const resolved = resolveRunIdPrefix(picked.runId);
          if (resolved.kind !== "exact") {
            fail(`Run not found: ${picked.runId}`);
            return true;
          }
          const run = store.runs().find((r) => r.id === resolved.runId);
          const isPaused = run?.status === "paused" || (run?.stages.some((s) => s.status === "paused") ?? false);
          const isResumableContinuation = run !== undefined && !isPaused && ((run.status === "failed" && run.endedAt !== undefined && run.resumable !== false) || (run.endedAt === undefined && run.resumable === true && run.failureRecoverability === "recoverable"));
          if (isResumableContinuation) {
            await ensureWorkflowResourcesVisible();
            const continuation = deps.runtimeForContext(ctx).resumeFailedRun(resolved.runId, undefined, { policy });
            continuation.ok ? print(continuation.message) : fail(continuation.message);
          } else {
            const result = resumeRun(resolved.runId, {});
            if (result.ok && !isPaused && result.mode === "snapshot" && run?.exitReason === "quit") {
              return await handleDurableResume(resolved.runId, ctx, reporter, deps);
            }
            if (result.ok && policy.allowInputPicker) deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
            result.ok ? print(result.message ?? `Resumed ${result.runId.slice(0, 8)}`) : fail(`Run not found: ${picked.runId}`);
          }
        }
        return true;
      }
      const picked = await openSessionPicker(ui, store, theme, action === "attach" ? "connect" : action);
      if (action === "attach" && picked.kind === "kill") return handleRunControlCommand("kill", [picked.runId, "-y"], ctx, reporter, deps);
      if (picked.kind !== (action === "attach" ? "connect" : action)) return true;
      runId = picked.runId;
    } else {
      const resolved = resolveRunIdPrefix(target);
      if (resolved.kind === "not_found") {
        // Not a live run — fall back to the cross-session durable resume catalog.
        // cross-ref: issue #1498 — /workflow resume by top-level workflow id.
        if (action === "resume") {
          return await handleDurableResume(target, ctx, reporter, deps);
        }
        fail(`Run not found: ${target}`);
        return true;
      }
      if (resolved.kind === "ambiguous") {
        fail(`Ambiguous run prefix "${target}" matches: ${resolved.matches.map((id) => id.slice(0, 12)).join(", ")}`);
        return true;
      }
      runId = resolved.runId;
    }
    if (action === "attach") {
      const stageId = resolveAttachStageId(runId, stageTarget);
      if (stageId === false) {
        fail(`Stage not found in run ${runId.slice(0, 8)}: ${stageTarget}`);
        return true;
      }
      if (failHeadlessAttachCommand("attach", runId, stageId)) return true;
      if (policy.allowInputPicker) deps.overlay.open(runId, overlaySurfaceFromContext(ctx), stageId);
      print(stageId ? `Attached to ${runId.slice(0, 8)} stage ${stageId.slice(0, 8)}. ctrl+d return to graph · esc close.` : `Attached to ${runId.slice(0, 8)}. ↵ chat · ctrl+d detach.`);
      return true;
    }
    const resolvedStage = resolveStageTarget(runId, stageTarget);
    if (!resolvedStage.ok) {
      fail(resolvedStage.message);
      return true;
    }
    const stageId = resolvedStage.stageId;
    const stageRunId = resolvedStage.runId ?? runId;
    if (action === "pause") {
      const result = pauseRun(stageRunId, { stageId });
      if (!result.ok) {
        fail(result.reason === "not_found" ? `Run not found: ${stageRunId.slice(0, 8)}` : result.reason === "already_ended" ? `Run ${stageRunId.slice(0, 8)} already ended.` : result.reason === "no_active_stages" ? `No pausable stages on run ${stageRunId.slice(0, 8)}.` : `Stage not found: ${stageTarget ?? "(unknown)"}`);
        return true;
      }
      if (policy.allowInputPicker) deps.overlay.open(runId, overlaySurfaceFromContext(ctx), stageId);
      print(result.paused.length === 0 ? `No stages were paused on run ${stageRunId.slice(0, 8)}.` : `Paused ${result.paused.length} stage(s) on run ${stageRunId.slice(0, 8)}: ${result.paused.map((s) => s.name).join(", ")}`);
      return true;
    }
    const run = store.runs().find((r) => r.id === stageRunId);
    const hadPausedRunState = run?.status === "paused";
    const hadPausedStageState = run?.stages.some((s) => s.status === "paused") ?? false;
    const isPaused = hadPausedRunState || hadPausedStageState;
    const isResumableContinuation = run !== undefined && !isPaused && ((run.status === "failed" && run.endedAt !== undefined && run.resumable !== false) || (run.endedAt === undefined && run.resumable === true && run.failureRecoverability === "recoverable"));
    const isActivelyRunning = run !== undefined && run.endedAt === undefined && run.status === "running" && !isPaused && run.exitReason !== "quit";
    if (isActivelyRunning && action === "resume") {
      fail(`Workflow ${stageRunId.slice(0, 8)} is already running in this session. Attach with \`/workflow connect ${stageRunId.slice(0, 8)}\` instead of resuming.`);
      return true;
    }
    if (isResumableContinuation) {
      await ensureWorkflowResourcesVisible();
      const continuation = deps.runtimeForContext(ctx).resumeFailedRun(stageRunId, stageId, { policy });
      continuation.ok ? print(continuation.message) : fail(continuation.message);
      return true;
    }
    // A quit, non-paused durable run is a resume shadow rather than a live
    // stage-control pause. Routing directly to durable resume preserves the
    // previous snapshot-only diversion without reopening a stale local overlay.
    if (!isPaused && run?.exitReason === "quit" && action === "resume") {
      return await handleDurableResume(stageRunId, ctx, reporter, deps);
    }
    const result = resumeRun(stageRunId, { stageId, message });
    if (!result.ok) {
      fail(`Run not found: ${stageRunId.slice(0, 8)}`);
      return true;
    }
    if (!isPaused) {
      if (policy.allowInputPicker) deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
      print(result.message ?? `Snapshot available: run ${result.runId} (${result.snapshot.name}) — status: ${result.snapshot.status}, stages: ${result.snapshot.stages.length}`);
      return true;
    }
    if (!message && stageId && policy.allowInputPicker) deps.overlay.open(runId, overlaySurfaceFromContext(ctx), stageId);
    if (result.resumed.length === 0) {
      const runLevelResumed = hadPausedRunState && !hadPausedStageState && stageId === undefined && result.snapshot.status === "running";
      runLevelResumed ? print(`Resumed run ${stageRunId.slice(0, 8)}.`) : fail(`No paused stages on run ${stageRunId.slice(0, 8)}.`);
    } else {
      print(`Resumed ${result.resumed.length} stage(s) on run ${stageRunId.slice(0, 8)}${message ? ` with message: "${message}"` : ""}.`);
    }
    return true;
  }

  return false;
}
