import { killAllRuns } from "../runs/background/status.js";
import { quitAllRuns } from "../runs/background/quit.js";
import { cancellationRegistry } from "../runs/background/cancellation-registry.js";
import { stageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { store } from "../shared/store.js";
import { restoreOnSessionStart } from "../shared/persistence-restore.js";
import { findResumableWorkflowNotices } from "../shared/resumable-workflow-notices.js";
import { installCompactionHook } from "../shared/persistence-compaction-policy.js";
import { clearForms } from "../tui/inline-form-store.js";
import { installStoreWidget } from "../tui/store-widget-installer.js";
import { registerIntercomParentSession } from "../intercom/intercom-bridge.js";
import {
  resetWorkflowLifecycleNotificationState,
  seedWorkflowLifecycleNotificationState,
  withWorkflowLifecycleNotificationsSuppressed,
} from "./lifecycle-notifications.js";
import { resetWorkflowHilAnswerNotificationState } from "./hil-answer-notifications.js";
import type { ExtensionAPI } from "./public-types.js";
import type { WorkflowExtensionRuntimeState } from "./extension-runtime-state.js";
import { deAdvertiseAskUserQuestionWhenHeadless, formatStartupDiagnostics } from "./workflow-command-surfaces.js";
import { inFlightRunCount } from "./workflow-targets.js";

export interface WorkflowLifecycleRegistrationDeps {
  runtimeState: WorkflowExtensionRuntimeState;
  storeWidgetRef: { current: (() => void) | null };
  intercomControlRef: { current: (() => void) | null };
}

export function registerWorkflowLifecycleHandlers(
  pi: ExtensionAPI,
  deps: WorkflowLifecycleRegistrationDeps,
): void {
  if (typeof pi.on !== "function") return;
  const { runtimeState } = deps;
  pi.on("session_before_switch", async (event, ctx) => {
    const reason = typeof event === "object" && event !== null && "reason" in event
      ? (event as { readonly reason?: string }).reason
      : undefined;
    if (reason !== "new" && reason !== "resume") return undefined;
    const inFlightWorkflowCount = inFlightRunCount();
    if (inFlightWorkflowCount === 0) return undefined;
    const confirmSessionSwitch = ctx?.ui?.confirm;
    if (typeof confirmSessionSwitch !== "function") return undefined;
    const workflowNoun = inFlightWorkflowCount === 1 ? "workflow" : "workflows";
    const actionLabel = reason === "new" ? "Start a new session" : "Resume another session";
    const messageLabel = reason === "new" ? "Starting a new session" : "Resuming another session";
    try {
      const shouldSwitchSession = await confirmSessionSwitch(
        `${actionLabel} and stop ${inFlightWorkflowCount} in-flight ${workflowNoun}?`,
        `${messageLabel} will stop/kill ${inFlightWorkflowCount} in-flight ${workflowNoun} and clear workflow history tied to the current session.`,
      );
      if (shouldSwitchSession) return undefined;
    } catch {
      return undefined;
    }
    const cancelledLabel = reason === "new" ? "New session" : "Resume";
    ctx?.ui?.notify?.(`${cancelledLabel} cancelled; in-flight workflows were left unchanged.`, "info");
    return { cancel: true };
  });

  pi.on("session_start", async (event, ctx) => {
    runtimeState.resetWorkflowDiscoveryForSession();
    deAdvertiseAskUserQuestionWhenHeadless(pi, ctx?.hasUI);
    await runtimeState.ensureWorkflowConfigLoaded();
    killAllRuns({ store, cancellation: cancellationRegistry, persistence: runtimeState.persistenceRef.current });
    store.clear();
    clearForms();
    resetWorkflowLifecycleNotificationState(runtimeState.lifecycleNotificationState);
    resetWorkflowHilAnswerNotificationState(runtimeState.hilAnswerNotificationState);
    stageControlRegistry.clear();
    runtimeState.setIntercomParentSession(registerIntercomParentSession(pi));
    runtimeState.setNotificationsActive(true);
    runtimeState.startWorkflowDiscoveryWarmup(() => {
      if (!ctx?.ui) return;
      const diagnostics = formatStartupDiagnostics(null, runtimeState.discoveryRef.current);
      if (diagnostics !== null) ctx.ui.notify?.(diagnostics, "warning");
    });
    if (ctx?.ui) {
      const diagnostics = formatStartupDiagnostics(runtimeState.configLoadRef.current, null);
      if (diagnostics !== null) ctx.ui.notify?.(diagnostics, "warning");
      deps.storeWidgetRef.current?.();
      deps.storeWidgetRef.current = installStoreWidget({ ui: ctx.ui }, store);
    }
    const sessionManager = ctx?.sessionManager ?? pi.sessionManager;
    runtimeState.updateHostStageSessionDir(sessionManager);
    if (sessionManager) {
      const cfg = runtimeState.configLoadRef.current?.config;
      withWorkflowLifecycleNotificationsSuppressed(runtimeState.lifecycleNotificationState, () => {
        restoreOnSessionStart(
          sessionManager,
          {
            resumeInFlight: cfg?.resumeInFlight ?? "ask",
            persistRuns: cfg?.persistRuns ?? true,
          },
          store,
        );
        seedWorkflowLifecycleNotificationState(runtimeState.lifecycleNotificationState, store.snapshot());
      });
      const reason = typeof event === "object" && event !== null && "reason" in event
        ? (event as { readonly reason?: string }).reason
        : undefined;
      if (reason === "startup" || reason === "resume") {
        const getEntries = sessionManager.getEntries;
        if (typeof getEntries === "function") {
          const resumable = findResumableWorkflowNotices(getEntries.call(sessionManager));
          if (resumable.length > 0) {
            const commands = resumable
              .map((workflow) => `\`${workflow.name}\` (${workflow.workflowId.slice(0, 8)}): /workflow resume ${workflow.workflowId}`)
              .join("\n");
            ctx?.ui?.notify?.(`This session has resumable workflows:\n${commands}`, "info");
          }
        }
      }
    }
  });

  installCompactionHook(pi, store);
  pi.on("session_shutdown", (event) => {
    const reason = typeof event === "object" && event !== null && "reason" in event
      ? (event as { readonly reason?: string }).reason
      : undefined;
    deps.intercomControlRef.current?.();
    deps.intercomControlRef.current = null;
    if (reason === "quit") {
      // CLI/orchestrator quit is a resumable process boundary, not explicit
      // `/workflow kill`. Durable-progress workflows stay available through
      // `/workflow resume`; stage handles are disposed after being paused.
      quitAllRuns({ store, stageControlRegistry });
      stageControlRegistry.clear();
    }
    deps.storeWidgetRef.current?.();
    deps.storeWidgetRef.current = null;
    runtimeState.resetWorkflowDiscoveryForSession();
    runtimeState.setNotificationsActive(false);
  });
}
