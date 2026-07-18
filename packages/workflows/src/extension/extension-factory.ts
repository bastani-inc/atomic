import { store } from "../shared/store.js";
import { subscribeIntercomControl } from "../intercom/result-intercom.js";
import { buildIntercomCallbacks } from "../intercom/intercom-routing.js";
import { installStoreWidget, installToolExecutionHooks } from "../tui/store-widget-installer.js";
import { buildGraphOverlayAdapter } from "../tui/overlay-adapter.js";
import type { GraphOverlayPort } from "../tui/overlay-adapter.js";
import { registerInlineFormRenderer } from "../tui/inline-form-overlay.js";
import { registerChatSurfaceRenderer } from "../tui/chat-surface-message.js";
import { deriveGraphTheme } from "../tui/graph-theme.js";
import { renderRunBanner, renderRunSummary, type RunEndPayload, type RunStartPayload } from "./renderers.js";
import { buildRuntimeAdapters } from "./wiring.js";
import type { ExtensionAPI, PiCommandContext } from "./public-types.js";
import { createWorkflowExtensionRuntimeState } from "./extension-runtime-state.js";
import { registerWorkflowLifecycleHandlers } from "./extension-lifecycle.js";
import { dynamicTextRenderComponent } from "./render-component.js";
import { makeExecuteWorkflowTool } from "./workflow-tool.js";
import { createPostMortemHandleResolver, postMortemDepsForRun } from "./postmortem-deps.js";
import { registerCompletedStageIntercomAskRouter } from "./completed-stage-intercom-ask.js";
import type { PostMortemHandleResolution } from "../tui/workflow-attach-pane-types.js";
import { registerWorkflowTool } from "./workflow-tool-registration.js";
import { registerWorkflowSlashCommand } from "./workflow-command-registration.js";
import { installInputInterceptor, type WorkflowCommandHandler } from "./workflow-command-utils.js";
import { overlaySurfaceFromContext } from "./workflow-targets.js";

function registerWorkflowMessageRenderers(pi: ExtensionAPI): void {
  if (typeof pi.registerMessageRenderer !== "function") return;
  pi.registerMessageRenderer("workflow.run.start", (payload) =>
    dynamicTextRenderComponent(() => renderRunBanner(payload as RunStartPayload)),
  );
  pi.registerMessageRenderer("workflow.run.end", (payload) =>
    dynamicTextRenderComponent(() => renderRunSummary(payload as RunEndPayload)),
  );
  registerInlineFormRenderer(pi, deriveGraphTheme({}));
  registerChatSurfaceRenderer(pi, deriveGraphTheme({}));
}

function buildWorkflowOverlay(
  pi: ExtensionAPI,
  resolvePostMortemHandle: (runId: string, stageId: string) => PostMortemHandleResolution,
): GraphOverlayPort {
  return buildGraphOverlayAdapter(pi, store, { resolvePostMortemHandle });
}

function registerWorkflowShortcut(pi: ExtensionAPI, overlay: GraphOverlayPort): void {
  if (typeof pi.registerShortcut !== "function") return;
  const openPane = (ctx?: PiCommandContext): void => {
    const activeRunId = store.activeRunId();
    const fallback = activeRunId ?? store.runs().at(-1)?.id ?? null;
    overlay.open(fallback, overlaySurfaceFromContext(ctx));
  };
  pi.registerShortcut("F2", {
    description: "Open workflow orchestrator pane",
    handler: openPane,
  });
}

function registerIntercomControl(
  pi: ExtensionAPI,
  intercomControlRef: { current: (() => void) | null },
): void {
  intercomControlRef.current = subscribeIntercomControl(
    pi,
    buildIntercomCallbacks({
      store,
      emit: typeof pi.events?.emit === "function"
        ? (event, payload) => pi.events!.emit!(event, payload)
        : undefined,
      confirm: typeof pi.ui?.confirm === "function"
        ? (title, message) => pi.ui!.confirm!(title, message)
        : undefined,
    }),
  );
}

function factory(pi: ExtensionAPI): void {
  const adapters = buildRuntimeAdapters(pi);
  const runtimeState = createWorkflowExtensionRuntimeState(pi, adapters);
  const postMortemResolverDeps = {
    adapters,
    resolveDefaultStageSessionDir: runtimeState.resolveDefaultStageSessionDir,
  };
  const postMortemHandleResolver = createPostMortemHandleResolver(postMortemResolverDeps);
  const overlay = buildWorkflowOverlay(pi, postMortemHandleResolver);
  registerCompletedStageIntercomAskRouter(pi, postMortemHandleResolver);
  const workflowCommands = new Map<string, WorkflowCommandHandler>();
  const storeWidgetRef: { current: (() => void) | null } = { current: null };
  const intercomControlRef: { current: (() => void) | null } = { current: null };
  const executeWorkflowTool = makeExecuteWorkflowTool(
    (ctx) => runtimeState.runtimeForContext(ctx),
    runtimeState.reloadWorkflowResources,
    runtimeState.ensureWorkflowResourcesLoaded,
    { resolvePostMortemDeps: (runId) => postMortemDepsForRun(runId, postMortemResolverDeps) },
  );

  registerWorkflowTool(pi, executeWorkflowTool, runtimeState.runWithLifecycleSuppressedForPolicy);
  registerWorkflowSlashCommand(pi, workflowCommands, {
    runtimeProxy: runtimeState.runtimeProxy,
    runtimeForContext: runtimeState.runtimeForContext,
    overlay,
    reloadWorkflowResources: runtimeState.reloadWorkflowResources,
    ensureWorkflowResourcesLoaded: runtimeState.ensureWorkflowResourcesLoaded,
    runWithLifecycleSuppressedForPolicy: runtimeState.runWithLifecycleSuppressedForPolicy,
    runControl: {
      pi,
      overlay,
      runtimeForContext: runtimeState.runtimeForContext,
      ensureWorkflowResourcesLoaded: runtimeState.ensureWorkflowResourcesLoaded,
    },
  });
  registerWorkflowMessageRenderers(pi);
  registerWorkflowLifecycleHandlers(pi, { runtimeState, storeWidgetRef, intercomControlRef });

  storeWidgetRef.current = installStoreWidget(pi, store);
  installToolExecutionHooks(pi, store);
  registerWorkflowShortcut(pi, overlay);
  registerIntercomControl(pi, intercomControlRef);
  installInputInterceptor(pi, workflowCommands);
}

export default factory;
