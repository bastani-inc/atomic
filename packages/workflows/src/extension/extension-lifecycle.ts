import { killAllRuns } from "../runs/background/status.js";
import { quitAllRuns } from "../runs/background/quit.js";
import { cancellationRegistry } from "../runs/background/cancellation-registry.js";
import { stageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { store } from "../shared/store.js";
import { installCompactionHook } from "../shared/persistence-compaction-policy.js";
import { clearForms } from "../tui/inline-form-store.js";
import { installStoreWidget } from "../tui/store-widget-installer.js";
import { resetWorkflowLifecycleNotificationState } from "./lifecycle-notifications.js";
import { resetWorkflowHilAnswerNotificationState } from "./hil-answer-notifications.js";
import type { ExtensionAPI } from "./public-types.js";
import type { WorkflowExtensionRuntimeState } from "./extension-runtime-state.js";
import { deAdvertiseAskUserQuestionWhenHeadless, formatStartupDiagnostics } from "./workflow-command-surfaces.js";
import { inFlightRunCount } from "./workflow-targets.js";
import { shutdownDbos } from "../durable/dbos-lifecycle.js";

let processShutdownInstalled = false;

function installDbosProcessShutdown(): void {
  if (processShutdownInstalled) return;
  processShutdownInstalled = true;
  process.once("beforeExit", () => shutdownDbos());
}

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
  installDbosProcessShutdown();
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

  pi.on("session_start", async (_event, ctx) => {
    runtimeState.resetWorkflowDiscoveryForSession();
    deAdvertiseAskUserQuestionWhenHeadless(pi, ctx?.hasUI);
    await runtimeState.ensureWorkflowConfigLoaded();
    killAllRuns({ store, cancellation: cancellationRegistry, persistence: runtimeState.persistenceRef.current });
    store.clear();
    clearForms();
    resetWorkflowLifecycleNotificationState(runtimeState.lifecycleNotificationState);
    resetWorkflowHilAnswerNotificationState(runtimeState.hilAnswerNotificationState);
    stageControlRegistry.clear();
    // Named workflows publish lifecycle notices through the normal notification path.
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
    // Session JSONL contains chat transcripts only. Workflow state is loaded
    // from DBOS on the first workflow command or run, never during startup.
    runtimeState.updateHostStageSessionDir(ctx?.sessionManager ?? pi.sessionManager);
  });

  installCompactionHook(pi, store);
  pi.on("session_shutdown", async (event) => {
    const reason = typeof event === "object" && event !== null && "reason" in event
      ? (event as { readonly reason?: string }).reason
      : undefined;
    deps.intercomControlRef.current?.();
    deps.intercomControlRef.current = null;
    if (reason === "quit") {
      // CLI/orchestrator quit is a resumable process boundary, not destructive
      // cancellation. Durable-progress workflows stay available through
      // `/workflow resume`; stage handles are disposed after being paused.
      try {
        const results = await quitAllRuns({ store, stageControlRegistry });
        const failures = results.filter((result) => !result.ok);
        if (failures.length > 0) {
          console.error(
            "atomic-workflows: session shutdown could not gracefully quit every run:",
            failures.map((result) =>
              `${result.runId}: ${result.reason}${"message" in result ? ` (${result.message})` : ""}`
            ).join(", "),
          );
        }
      } finally {
        stageControlRegistry.clear();
      }
    } else {
      // Every non-quit host-session boundary invalidates detached lazy handles
      // synchronously, before they can attach to the replacement session.
      stageControlRegistry.clear();
    }
    deps.storeWidgetRef.current?.();
    deps.storeWidgetRef.current = null;
    runtimeState.resetWorkflowDiscoveryForSession();
    runtimeState.setNotificationsActive(false);
    await shutdownDbos();
  });
}
