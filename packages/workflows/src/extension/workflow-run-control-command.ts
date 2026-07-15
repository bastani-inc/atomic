import { hasPendingDurableResumeTransition } from "../runs/background/durable-resume-transition.js";
import { interruptAllRuns, interruptRun, pauseRun, resumeRun } from "../runs/background/status.js";
import { quitAllRuns, quitRun } from "../runs/background/quit.js";
import { getDurableBackend } from "../durable/factory.js";
import { store } from "../shared/store.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import { renderSessionList } from "../tui/session-list.js";
import { openSessionPicker } from "../tui/session-overlays.js";
import { deriveGraphTheme } from "../tui/graph-theme.js";
import { openWorkflowResumeSelector } from "../tui/workflow-resume-selector.js";
import type { PiCommandContext } from "./public-types.js";
import type { WorkflowCommandReporter } from "./workflow-command-utils.js";
import { stripYesFlag } from "./workflow-command-utils.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import {
  overlaySurfaceFromContext,
  resolveRunIdPrefix,
  resolveStageTarget,
} from "./workflow-targets.js";
import { formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";
import { classifyDurableResumeShadow, reconcileDurableResumeShadow } from "./workflow-resume-shadow.js";
import { workflowHasPausedStages, workflowHasPausedState } from "../runs/background/workflow-lifecycle-aggregate.js";
import {
  handleDurableResume,
  prepareWorkflowResumeCatalog,
  resolveWorkflowResumeTarget,
  type WorkflowRunControlDeps,
} from "./workflow-durable-resume-command.js";

export type { WorkflowRunControlDeps } from "./workflow-durable-resume-command.js";



export async function handleRunControlCommand(
  action: "connect" | "interrupt" | "quit" | "attach" | "pause" | "resume",
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
    print(`Connected to ${resolved.runId.slice(0, 8)}. h hide · ctrl+d/q return to main chat · esc close.`);
    return true;
  }

  if (action === "interrupt" || action === "quit") {
    const { tokens, yes } = action === "interrupt"
      ? stripYesFlag(rest)
      : { tokens: rest, yes: false };
    const unsupportedTarget = action === "quit"
      ? tokens.find((token) => token === "-y" || token === "--yes")
      : undefined;
    let target = action === "quit"
      ? unsupportedTarget ?? tokens.find((token) => token !== "--all")
      : tokens.find((token) => !token.startsWith("--"));
    const wantsAll = unsupportedTarget === undefined && tokens.includes("--all");
    if (!target && !wantsAll) {
      target = store.activeRunId() ?? undefined;
      if (!target) {
        fail(`No in-flight runs to ${action}.`);
        return true;
      }
    }
    if (wantsAll) {
      const inFlight = topLevelWorkflowRuns(store.runs()).filter((run) => run.endedAt === undefined);
      if (inFlight.length === 0) {
        fail(`No in-flight runs to ${action}.`);
        return true;
      }
      if (action === "interrupt" && !yes && confirmationPrompt) {
        const title = `Interrupt all ${inFlight.length} in-flight workflow runs?`;
        const body = `Pauses: ${inFlight.map((run) => `${run.name} (${run.id.slice(0, 8)})`).join(", ")}`;
        if (!(await confirmationPrompt(title, body))) {
          print("Cancelled.");
          return true;
        }
      }
      const results = action === "quit" ? await quitAllRuns() : await interruptAllRuns();
      const successes = results.filter((result) => result.ok);
      const changed = successes.length;
      const failures = results.filter((result) => !result.ok);
      if (action === "quit" && failures.length > 0) {
        const outcomes = results.map((result) => result.ok
          ? `${result.runId}: quit`
          : `${result.runId}: ${result.reason}${"message" in result ? ` (${result.message})` : ""}`
        ).join(", ");
        const message = `${changed > 0 ? `Quit ${changed} run(s); ` : ""}failed to quit ${failures.length} run(s); outcomes: ${outcomes}.`;
        if (changed > 0) print(message);
        else fail(message);
      } else if (changed > 0) {
        print(action === "quit"
          ? `Quit ${changed} run(s); resume with /workflow resume.`
          : `Interrupted ${changed} run(s).`);
      } else {
        fail(`No in-flight runs to ${action}.`);
      }
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
    const run = store.runs().find((candidate) => candidate.id === resolved.runId);
    if (action === "quit") {
      if (run?.endedAt !== undefined) {
        print(`Run ${resolved.runId.slice(0, 8)} already ended.`);
        return true;
      }
      try {
        const result = await quitRun(resolved.runId);
        if (result.ok) print(`Run ${result.runId.slice(0, 8)} quit and can be resumed with /workflow resume.`);
        else if (result.reason === "already_ended") print(`Run ${result.runId.slice(0, 8)} already ended.`);
        else if (result.reason === "no_active_stages") {
          fail(`No controllable stages on run ${result.runId.slice(0, 8)}; the run remains active.`);
        } else fail(`Run not found: ${target}`);
      } catch (error) {
        fail(`Failed to quit run ${resolved.runId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return true;
    }
    if (!yes && run && run.endedAt === undefined && confirmationPrompt) {
      const confirmed = await confirmationPrompt(
        `Interrupt workflow run ${run.name} (${run.id.slice(0, 8)})?`,
        "Pauses live work so it can be resumed later.",
      );
      if (!confirmed) {
        print(`Cancelled. Run ${resolved.runId.slice(0, 8)} is still active.`);
        return true;
      }
    }
    try {
      const result = await interruptRun(resolved.runId);
      if (result.ok) print(`Run ${result.runId.slice(0, 8)} interrupted and can be resumed.`);
      else fail(result.reason === "not_found" ? `Run not found: ${target}` : result.reason === "already_ended" ? `Run already ended: ${target}` : result.reason === "stage_not_found" ? `Stage not found for run ${resolved.runId.slice(0, 8)}.` : `No active stages to interrupt on run ${resolved.runId.slice(0, 8)}.`);
    } catch (error) {
      fail(`Failed to interrupt run ${resolved.runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
        const durableResumeShadows = new Set(
          topLevelWorkflowRuns(store.runs())
            .filter((run) => reconcileDurableResumeShadow(run, store))
            .map((run) => run.id),
        );
        let liveRuns = topLevelWorkflowRuns(store.runs()).filter((run) =>
          !durableResumeShadows.has(run.id) &&
          (run.status === "paused" || (run.status === "failed" && run.resumable !== false)),
        );
        const activeLiveIds = new Set(
          topLevelWorkflowRuns(store.runs())
            .filter((run) =>
              !durableResumeShadows.has(run.id) &&
              run.endedAt === undefined &&
              run.status === "running" &&
              run.exitReason !== "quit"
            )
            .map((run) => run.id),
        );
        await ensureWorkflowResourcesVisible();
        const runtime = deps.runtimeForContext(ctx);
        let durableEntries: readonly ResumableWorkflowEntry[] = [];
        let completedEntries: readonly ResumableWorkflowEntry[] = [];
        try {
          const catalog = await prepareWorkflowResumeCatalog(runtime, activeLiveIds);
          durableEntries = catalog.resumable;
          completedEntries = catalog.completed;
        } catch (error) {
          liveRuns = liveRuns.filter((run) => getDurableBackend().isWorkflowLoadable(run.id));
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (liveRuns.length === 0) {
            fail(`Failed to list workflow resume targets: ${errorMessage}`);
            return true;
          }
        }
        liveRuns = liveRuns.filter((run) => getDurableBackend().isWorkflowLoadable(run.id));
        const picked = await openWorkflowResumeSelector(ctx.ui, liveRuns, durableEntries, completedEntries);
        if (picked.kind === "durable" || picked.kind === "completed") {
          return await handleDurableResume(picked.workflowId, ctx, reporter, deps);
        }
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
            try {
              const result = await resumeRun(resolved.runId, {});
              if (result.ok && !isPaused && result.mode === "snapshot" && run?.exitReason === "quit") {
                return await handleDurableResume(resolved.runId, ctx, reporter, deps);
              }
              if (result.ok && result.mode === "partial") {
                fail(result.message ?? ("Partially resumed " + result.runId + "."));
              } else {
                if (result.ok && policy.allowInputPicker) deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
                result.ok ? print(result.message ?? `Resumed ${result.runId.slice(0, 8)}`) : fail(`Run not found: ${picked.runId}`);
              }
            } catch (error) {
              fail(`Failed to resume run ${resolved.runId}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        return true;
      }
      const picked = await openSessionPicker(ui, store, theme, action === "attach" ? "connect" : action);
      if (picked.kind !== (action === "attach" ? "connect" : action)) return true;
      runId = picked.runId;
    } else if (action === "resume") {
      const backend = getDurableBackend();
      const localResolution = resolveRunIdPrefix(target);
      const exactBeforePreparation = localResolution.kind === "exact"
        ? store.runs().find((run) => run.id === localResolution.runId)
        : undefined;
      const shadow = exactBeforePreparation === undefined
        ? "not_shadow"
        : classifyDurableResumeShadow(exactBeforePreparation, store, { backend });
      if (shadow === "ineligible") {
        fail(`Workflow ${exactBeforePreparation!.id} has no durable checkpoint or pending prompt progress and is not resumable.`);
        return true;
      }
      const exactIsDurableResumeShadow = shadow === "eligible";
      const exactHasPausedState = exactBeforePreparation?.status === "paused" ||
        (exactBeforePreparation?.stages.some((stage) => stage.status === "paused") ?? false);
      const exactIsActivelyRunning = exactBeforePreparation !== undefined &&
        !exactIsDurableResumeShadow &&
        exactBeforePreparation.endedAt === undefined &&
        exactBeforePreparation.status === "running" &&
        !exactHasPausedState &&
        exactBeforePreparation.exitReason !== "quit";
      if (exactIsActivelyRunning) {
        fail(`Workflow ${exactBeforePreparation.id.slice(0, 8)} is already running in this session. Attach with \`/workflow connect ${exactBeforePreparation.id.slice(0, 8)}\` instead of resuming.`);
        return true;
      }
      if (exactBeforePreparation !== undefined &&
        exactBeforePreparation.parentRunId === undefined &&
        exactHasPausedState &&
        !exactIsDurableResumeShadow &&
        backend.isWorkflowLoadable(exactBeforePreparation.id)) {
        // Exact top-level live state is authoritative. Avoid scanning the
        // potentially large completed catalog while preserving the established
        // top-level target namespace and live-over-durable precedence.
        runId = exactBeforePreparation.id;
      } else {
        let durable: readonly ResumableWorkflowEntry[] = [];
        let preparationError: string | undefined;
        const needsDurablePreparation = exactBeforePreparation === undefined ||
          exactIsDurableResumeShadow ||
          (!backend.isWorkflowLoadable(exactBeforePreparation.id) &&
            (!exactHasPausedState || backend.hydrateResumableWorkflows !== undefined));
        if (needsDurablePreparation) {
          await ensureWorkflowResourcesVisible();
          const runtime = deps.runtimeForContext(ctx);
          try {
            durable = await runtime.prepareDurableResumable(target);
          } catch (error) {
            preparationError = error instanceof Error ? error.message : String(error);
          }
        }
        const loadableRuns = topLevelWorkflowRuns(store.runs()).filter((run) =>
          backend.isWorkflowLoadable(run.id) &&
          !reconcileDurableResumeShadow(run, store, { backend })
        );
        const combined = resolveWorkflowResumeTarget(
          target,
          loadableRuns,
          durable,
          backend.listCompletedWorkflows(),
        );
        if (combined.kind === "ambiguous") {
          fail(`Ambiguous workflow prefix "${target}" matches: ${combined.matches.map((match) => `${match.name} (${match.workflowId.slice(0, 8)})`).join(", ")}`);
          return true;
        }
        if (combined.kind === "completed" || combined.kind === "durable") {
          return await handleDurableResume(combined.workflowId, ctx, reporter, deps);
        }
        if (combined.kind === "live") runId = combined.workflowId;
        else {
          if (preparationError !== undefined) {
            fail(`Failed to resolve workflow resume target: ${preparationError}`);
            return true;
          }
          return await handleDurableResume(target, ctx, reporter, deps);
        }
      }
    } else {
      const resolved = resolveRunIdPrefix(target);
      if (resolved.kind === "not_found") {
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
      const resolvedStage = resolveStageTarget(runId, stageTarget);
      if (!resolvedStage.ok) {
        fail(resolvedStage.message);
        return true;
      }
      const stageId = resolvedStage.stageId;
      const stageRunId = resolvedStage.runId ?? runId;
      if (failHeadlessAttachCommand("attach", runId, stageId)) return true;
      if (policy.allowInputPicker) deps.overlay.open(runId, overlaySurfaceFromContext(ctx), stageId, stageRunId);
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
      try {
        const result = await pauseRun(stageRunId, { stageId });
        if (!result.ok) {
          fail(result.reason === "not_found" ? `Run not found: ${stageRunId.slice(0, 8)}` : result.reason === "already_ended" ? `Run ${stageRunId.slice(0, 8)} already ended.` : result.reason === "no_active_stages" ? `No pausable stages on run ${stageRunId.slice(0, 8)}.` : `Stage not found: ${stageTarget ?? "(unknown)"}`);
          return true;
        }
        if (policy.allowInputPicker) {
          deps.overlay.open(runId, overlaySurfaceFromContext(ctx), stageId, stageRunId);
        }
        print(result.paused.length === 0 ? `No stages were paused on run ${stageRunId.slice(0, 8)}.` : `Paused ${result.paused.length} stage(s) on run ${stageRunId.slice(0, 8)}: ${result.paused.map((stage) => stage.name).join(", ")}`);
      } catch (error) {
        fail(`Failed to pause run ${stageRunId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return true;
    }
    const run = store.runs().find((r) => r.id === stageRunId);
    const hadPausedRunState = run?.status === "paused";
    const hadPausedStageState = run !== undefined && workflowHasPausedStages(store, stageRunId);
    const isPaused = run !== undefined && workflowHasPausedState(store, stageRunId);
    const isResumableContinuation = run !== undefined && !isPaused && ((run.status === "failed" && run.endedAt !== undefined && run.resumable !== false) || (run.endedAt === undefined && run.resumable === true && run.failureRecoverability === "recoverable"));
    const isActivelyRunning = run !== undefined && run.endedAt === undefined && run.status === "running" && !isPaused && run.exitReason !== "quit";
    if (isActivelyRunning && action === "resume" && !hasPendingDurableResumeTransition(stageRunId)) {
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
    let result;
    try {
      result = await resumeRun(stageRunId, { stageId, message });
    } catch (error) {
      fail(`Failed to resume run ${stageRunId}: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
    if (!result.ok) {
      fail(`Run not found: ${stageRunId.slice(0, 8)}`);
      return true;
    }
    if (result.mode === "partial") {
      fail(result.message ?? ("Partially resumed " + result.runId + "."));
      return true;
    }
    if (result.snapshot.endedAt !== undefined && result.message !== undefined) {
      print(result.message);
      return true;
    }
    if (!isPaused) {
      if (policy.allowInputPicker) deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
      print(result.message ?? `Snapshot available: run ${result.runId} (${result.snapshot.name}) — status: ${result.snapshot.status}, stages: ${result.snapshot.stages.length}`);
      return true;
    }
    if (!message && stageId && policy.allowInputPicker) deps.overlay.open(runId, overlaySurfaceFromContext(ctx), stageId, stageRunId);
    if (result.resumed.length === 0) {
      const runLevelResumed = hadPausedRunState && !hadPausedStageState && stageId === undefined && result.snapshot.status === "running";
      if (result.message !== undefined) print(result.message);
      else if (runLevelResumed) print(`Resumed run ${stageRunId.slice(0, 8)}.`);
      else fail(`No paused stages on run ${stageRunId.slice(0, 8)}.`);
    } else {
      print(`Resumed ${result.resumed.length} stage(s) on run ${stageRunId.slice(0, 8)}${message ? ` with message: "${message}"` : ""}.`);
    }
    return true;
  }

  return false;
}
