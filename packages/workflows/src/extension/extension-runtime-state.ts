import type { CreateAgentSessionOptions } from "@bastani/atomic";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import type { SessionManager } from "../shared/persistence-restore.js";
import type {
  WorkflowExecutionPolicy,
  WorkflowMcpPort,
  WorkflowModelCatalogPort,
  WorkflowModelInfo,
  WorkflowPersistencePort,
  WorkflowRuntimeConfig,
} from "../shared/types.js";
import { stageUiBroker } from "../shared/stage-ui-broker.js";
import { store } from "../shared/store.js";
import { cancellationRegistry } from "../runs/background/cancellation-registry.js";
import { createExtensionRuntime, type ExtensionRuntime } from "./runtime.js";
import { discoverStartupWorkflowsSync, discoverWorkflows, type DiscoveryResult } from "./discovery.js";
import {
  loadWorkflowConfig,
  toScopedDiscoveryConfig,
  withWorkflowDefaults,
  WORKFLOW_CONFIG_DEFAULTS,
  type ConfigLoadResult,
} from "./config-loader.js";
import { createStatusWriter, type StatusWriter } from "./status-writer.js";
import {
  createWorkflowLifecycleNotificationState,
  installWorkflowLifecycleNotifications,
  registerLifecycleNoticeRenderer,
  withWorkflowLifecycleNotificationsSuppressedAsync,
  type WorkflowLifecycleNotificationConfig,
} from "./lifecycle-notifications.js";
import {
  createWorkflowHilAnswerNotificationState,
  installWorkflowHilAnswerNotifications,
  registerHilAnswerNoticeRenderer,
} from "./hil-answer-notifications.js";
import type { ExtensionAPI, PiModelContext } from "./public-types.js";
import { makeMcpPort, makePersistencePort } from "./workflow-ports.js";
import { createWorkflowReloadCoordinator } from "./workflow-reload-coordinator.js";
import {
  workflowReloadDiagnostics,
  type WorkflowReloadReport,
} from "./workflow-reload-report.js";

export interface WorkflowExtensionRuntimeState {
  persistenceRef: { current: WorkflowPersistencePort | undefined };
  mcpPort: WorkflowMcpPort | undefined;
  runtimeProxy: ExtensionRuntime;
  configLoadRef: { current: ConfigLoadResult | null };
  discoveryRef: { current: DiscoveryResult | null };
  lifecycleNotificationState: ReturnType<typeof createWorkflowLifecycleNotificationState>;
  hilAnswerNotificationState: ReturnType<typeof createWorkflowHilAnswerNotificationState>;
  runtimeForContext(ctx?: PiModelContext): ExtensionRuntime;
  resetWorkflowDiscoveryForSession(): void;
  ensureWorkflowConfigLoaded(): Promise<void>;
  ensureWorkflowResourcesLoaded(): Promise<void>;
  reloadWorkflowResources(): Promise<WorkflowReloadReport>;
  startWorkflowDiscoveryWarmup(onSettled?: () => void): void;
  runWithLifecycleSuppressedForPolicy<T>(policy: WorkflowExecutionPolicy, fn: () => Promise<T>): Promise<T>;
  setNotificationsActive(active: boolean): void;
  setIntercomParentSession(session: string | null): void;
  updateHostStageSessionDir(sessionManager: SessionManager | undefined): void;
}

export function createWorkflowExtensionRuntimeState(
  pi: ExtensionAPI,
  adapters: StageAdapters,
): WorkflowExtensionRuntimeState {
  const persistenceRef = { current: makePersistencePort(pi, WORKFLOW_CONFIG_DEFAULTS.persistRuns) };
  const mcpPort = makeMcpPort(pi);
  const runtimeConfigRef: { current: WorkflowRuntimeConfig } = {
    current: {
      maxDepth: WORKFLOW_CONFIG_DEFAULTS.maxDepth,
      defaultConcurrency: WORKFLOW_CONFIG_DEFAULTS.defaultConcurrency,
      persistRuns: WORKFLOW_CONFIG_DEFAULTS.persistRuns,
      statusFile: WORKFLOW_CONFIG_DEFAULTS.statusFile,
      resumeInFlight: WORKFLOW_CONFIG_DEFAULTS.resumeInFlight,
    },
  };
  let statusWriterRef: StatusWriter = createStatusWriter(store, runtimeConfigRef.current);
  let lifecycleNotificationsUnsubscribe: (() => void) | null = null;
  let hilAnswerNotificationsUnsubscribe: (() => void) | null = null;
  let notificationsActive = false;
  let notificationGeneration = 0;
  const lifecycleNotificationState = createWorkflowLifecycleNotificationState();
  const hilAnswerNotificationState = createWorkflowHilAnswerNotificationState();
  const lifecycleNotificationConfigRef: { current: WorkflowLifecycleNotificationConfig } = {
    current: WORKFLOW_CONFIG_DEFAULTS.workflowNotifications,
  };
  const registerMessageRenderer: ExtensionAPI["registerMessageRenderer"] | undefined =
    typeof pi.registerMessageRenderer === "function"
      ? (event, renderer) => pi.registerMessageRenderer!(event, renderer)
      : undefined;
  registerLifecycleNoticeRenderer({ rendererHost: pi, registerMessageRenderer });
  registerHilAnswerNoticeRenderer({ rendererHost: pi, registerMessageRenderer });
  const sendWorkflowNotificationMessage: ExtensionAPI["sendMessage"] | undefined =
    typeof pi.sendMessage === "function" ? (message, options) => pi.sendMessage!(message, options) : undefined;
  const reinstallLifecycleNotifications = (): void => {
    lifecycleNotificationsUnsubscribe?.();
    lifecycleNotificationsUnsubscribe = null;
    if (!notificationsActive) return;
    lifecycleNotificationsUnsubscribe = installWorkflowLifecycleNotifications({
      store,
      config: lifecycleNotificationConfigRef.current,
      state: lifecycleNotificationState,
      seedExisting: true,
      sendMessage: sendWorkflowNotificationMessage,
    });
  };
  const reinstallHilAnswerNotifications = (): void => {
    hilAnswerNotificationsUnsubscribe?.();
    hilAnswerNotificationsUnsubscribe = null;
    if (!notificationsActive) return;
    hilAnswerNotificationsUnsubscribe = installWorkflowHilAnswerNotifications({
      store,
      stageUiBroker,
      state: hilAnswerNotificationState,
      sendMessage: sendWorkflowNotificationMessage,
    });
  };

  let intercomParentSession: string | null = null;
  const intercomPort = {
    emit: typeof pi.events?.emit === "function"
      ? (event: string, payload: Record<string, unknown>) => pi.events!.emit!(event, payload)
      : undefined,
    parentSession: () => intercomParentSession ?? undefined,
  };
  const hostStageSessionDir: { current: string | undefined } = { current: undefined };
  const resolveDefaultStageSessionDir = (): string | undefined => hostStageSessionDir.current;
  const startupDiscovery = discoverStartupWorkflowsSync();
  const runtimeRef: { current: ExtensionRuntime } = {
    current: createExtensionRuntime({
      registry: startupDiscovery.registry,
      cwd: process.cwd(),
      adapters,
      cancellation: cancellationRegistry,
      persistence: persistenceRef.current,
      mcp: mcpPort,
      intercom: intercomPort,
      config: runtimeConfigRef.current,
      resolveDefaultStageSessionDir,
    }),
  };
  const discoveryRef: { current: DiscoveryResult | null } = { current: null };
  const configLoadRef: { current: ConfigLoadResult | null } = { current: null };
  const runtimeProxy: ExtensionRuntime = {
    get registry() { return runtimeRef.current.registry; },
    dispatch(args, options) { return runtimeRef.current.dispatch(args, options); },
    runDirect(args, options) { return runtimeRef.current.runDirect(args, options); },
    resumeFailedRun(sourceRunId, stageId, options) { return runtimeRef.current.resumeFailedRun(sourceRunId, stageId, options); },
    resumeDurableWorkflow(workflowIdOrPrefix, options) { return runtimeRef.current.resumeDurableWorkflow(workflowIdOrPrefix, options); },
    listDurableResumable(sessionDir) { return runtimeRef.current.listDurableResumable(sessionDir); },
    prepareDurableResumable(workflowIdOrPrefix, sessionDir) { return runtimeRef.current.prepareDurableResumable(workflowIdOrPrefix, sessionDir); },
    prepareCompletedDurable() {
      return runtimeRef.current.prepareCompletedDurable?.() ?? Promise.resolve([]);
    },
    openCompletedDurableWorkflow(workflowIdOrPrefix, catalog) {
      const open = runtimeRef.current.openCompletedDurableWorkflow;
      if (open === undefined) {
        return { ok: false, reason: "not_found", message: `No completed durable workflow found for id/prefix: ${workflowIdOrPrefix}` };
      }
      return open(workflowIdOrPrefix, catalog);
    },
  };

  function workflowModelCatalogFromContext(ctx?: PiModelContext): WorkflowModelCatalogPort | undefined {
    if (ctx?.modelRegistry === undefined && ctx?.model === undefined) return undefined;
    return {
      listModels: async (): Promise<readonly WorkflowModelInfo[]> => {
        const available = ctx.modelRegistry?.getAvailable() ?? (ctx.model === undefined ? [] : [ctx.model]);
        return available.map((model) => ({
          provider: String(model.provider),
          id: model.id,
          fullId: `${String(model.provider)}/${model.id}`,
          model: model as NonNullable<CreateAgentSessionOptions["model"]>,
        }));
      },
      ...(ctx.model !== undefined
        ? {
            currentModel: ctx.model as NonNullable<CreateAgentSessionOptions["model"]>,
            preferredProvider: String(ctx.model.provider),
          }
        : {}),
    };
  }

  function runtimeForContext(ctx?: PiModelContext): ExtensionRuntime {
    const models = workflowModelCatalogFromContext(ctx);
    if (models === undefined) return runtimeProxy;
    return createExtensionRuntime({
      registry: runtimeRef.current.registry,
      cwd: process.cwd(),
      adapters,
      cancellation: cancellationRegistry,
      persistence: persistenceRef.current,
      mcp: mcpPort,
      intercom: intercomPort,
      config: runtimeConfigRef.current,
      models,
      resolveDefaultStageSessionDir,
    });
  }

  let lazyDiscoveryPromise: Promise<WorkflowReloadReport> | null = null;
  let workflowDiscoveryGeneration = 0;
  let activeResourceGeneration = 0;
  function deferToMacrotask(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  function applyWorkflowConfig(configResult: ConfigLoadResult): void {
    configLoadRef.current = configResult;
    const effectiveConfig = withWorkflowDefaults(configResult.config ?? {});
    runtimeConfigRef.current = {
      maxDepth: effectiveConfig.maxDepth,
      defaultConcurrency: effectiveConfig.defaultConcurrency,
      persistRuns: effectiveConfig.persistRuns,
      statusFile: effectiveConfig.statusFile,
      resumeInFlight: effectiveConfig.resumeInFlight,
    };
    lifecycleNotificationConfigRef.current = effectiveConfig.workflowNotifications;
    reinstallLifecycleNotifications();
    statusWriterRef.unsubscribe();
    statusWriterRef = createStatusWriter(store, runtimeConfigRef.current);
    persistenceRef.current = makePersistencePort(pi, effectiveConfig.persistRuns);
  }

  function rebuildRuntime(registry = runtimeRef.current.registry): void {
    runtimeRef.current = createExtensionRuntime({
      registry,
      cwd: process.cwd(),
      adapters,
      cancellation: cancellationRegistry,
      persistence: persistenceRef.current,
      mcp: mcpPort,
      intercom: intercomPort,
      config: runtimeConfigRef.current,
      resolveDefaultStageSessionDir,
    });
  }

  function isWorkflowDiscoveryCurrent(generation: number): boolean {
    return generation === workflowDiscoveryGeneration;
  }

  function resetWorkflowDiscoveryForSession(): void {
    workflowDiscoveryGeneration += 1;
    discoveryRef.current = null;
    lazyDiscoveryPromise = null;
    rebuildRuntime(startupDiscovery.registry);
  }

  async function ensureWorkflowConfigLoaded(): Promise<void> {
    const generation = workflowDiscoveryGeneration;
    const configResult = await loadWorkflowConfig();
    if (!isWorkflowDiscoveryCurrent(generation)) return;
    applyWorkflowConfig(configResult);
    rebuildRuntime();
  }

  function supersededReloadReport(
    coalescedRequests: number,
    configResult?: ConfigLoadResult,
    result?: DiscoveryResult,
  ): WorkflowReloadReport {
    return {
      outcome: "superseded",
      generation: activeResourceGeneration,
      workflowCount: runtimeRef.current.registry.names().length,
      coalescedRequests,
      diagnostics: workflowReloadDiagnostics(configResult?.diagnostics ?? [], result?.errors ?? []),
    };
  }

  function failedReloadReport(
    error: unknown,
    coalescedRequests: number,
    configResult?: ConfigLoadResult,
  ): WorkflowReloadReport {
    return {
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
      generation: activeResourceGeneration,
      workflowCount: runtimeRef.current.registry.names().length,
      coalescedRequests,
      diagnostics: workflowReloadDiagnostics(configResult?.diagnostics ?? [], []),
    };
  }

  function trackLazyDiscovery(pending: Promise<WorkflowReloadReport>): Promise<WorkflowReloadReport> {
    lazyDiscoveryPromise = pending;
    void pending.finally(() => {
      if (lazyDiscoveryPromise === pending) lazyDiscoveryPromise = null;
    }).catch(() => {});
    return pending;
  }

  function reloadWorkflowResources(): Promise<WorkflowReloadReport> {
    return trackLazyDiscovery(reloadCoordinator.request(workflowDiscoveryGeneration));
  }
  async function loadPackageWorkflowPaths(): Promise<string[]> {
    const packageResources = (await pi.refreshWorkflowResources?.()) ?? pi.getWorkflowResources?.() ?? [];
    return packageResources.filter((resource) => resource.enabled !== false).map((resource) => resource.path);
  }
  async function reloadWorkflowResourcesNow(
    discoveryGeneration: number,
    coalescedRequests: number,
  ): Promise<WorkflowReloadReport> {
    if (!isWorkflowDiscoveryCurrent(discoveryGeneration)) {
      return supersededReloadReport(coalescedRequests);
    }
    const configResult = await loadWorkflowConfig();
    if (!isWorkflowDiscoveryCurrent(discoveryGeneration)) {
      return supersededReloadReport(coalescedRequests, configResult);
    }
    try {
      const hasGlobal = configResult.globalConfig != null;
      const hasProject = configResult.projectConfig != null;
      const discoveryConfig = hasGlobal || hasProject
        ? toScopedDiscoveryConfig(configResult.globalConfig ?? null, configResult.projectConfig ?? null, { projectRoot: process.cwd() })
        : undefined;
      const packageWorkflowPaths = await loadPackageWorkflowPaths();
      if (!isWorkflowDiscoveryCurrent(discoveryGeneration)) {
        return supersededReloadReport(coalescedRequests, configResult);
      }
      const result = await discoverWorkflows({ config: discoveryConfig, packageWorkflowPaths });
      if (!isWorkflowDiscoveryCurrent(discoveryGeneration)) {
        return supersededReloadReport(coalescedRequests, configResult, result);
      }

      // Commit config, diagnostics, and the replacement runtime synchronously,
      // after every fallible/awaited discovery step has completed.
      applyWorkflowConfig(configResult);
      discoveryRef.current = result;
      rebuildRuntime(result.registry);
      activeResourceGeneration += 1;
      return {
        outcome: "applied",
        generation: activeResourceGeneration,
        workflowCount: result.registry.names().length,
        coalescedRequests,
        diagnostics: workflowReloadDiagnostics(configResult.diagnostics, result.errors),
      };
    } catch (error) {
      return failedReloadReport(error, coalescedRequests, configResult);
    }
  }

  const reloadCoordinator = createWorkflowReloadCoordinator(async (discoveryGeneration, coalescedRequests) => {
    try {
      return await reloadWorkflowResourcesNow(discoveryGeneration, coalescedRequests);
    } catch (error) {
      return failedReloadReport(error, coalescedRequests);
    }
  });

  async function ensureWorkflowResourcesLoaded(): Promise<void> {
    while (!pi.disableAsyncDiscovery && discoveryRef.current === null) {
      const discoveryGeneration = workflowDiscoveryGeneration;
      const pending = lazyDiscoveryPromise
        ?? trackLazyDiscovery(reloadCoordinator.request(discoveryGeneration));
      const report = await pending;
      if (report.outcome === "failed") throw new Error(report.error);
      if (!isWorkflowDiscoveryCurrent(discoveryGeneration)) continue;
      if (discoveryRef.current === null) lazyDiscoveryPromise = null;
    }
  }

  function startWorkflowDiscoveryWarmup(onSettled?: () => void): void {
    if (pi.disableAsyncDiscovery || discoveryRef.current !== null || lazyDiscoveryPromise !== null) return;
    const notificationStart = notificationGeneration;
    const discoveryStart = workflowDiscoveryGeneration;
    const pending = (async (): Promise<WorkflowReloadReport> => {
      await deferToMacrotask();
      if (!isWorkflowDiscoveryCurrent(discoveryStart)) {
        return supersededReloadReport(1);
      }
      const report = await reloadCoordinator.request(discoveryStart);
      if (report.outcome === "failed") throw new Error(report.error);
      return report;
    })();
    lazyDiscoveryPromise = pending;
    const isCurrentWarmup = (): boolean => lazyDiscoveryPromise === pending
      && notificationGeneration === notificationStart
      && isWorkflowDiscoveryCurrent(discoveryStart);
    void pending
      .catch((error) => {
        if (isCurrentWarmup() && process.env.ATOMIC_WORKFLOW_DEBUG === "1") {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`Workflow background discovery failed: ${message}`);
        }
      })
      .finally(() => {
        const current = isCurrentWarmup();
        if (lazyDiscoveryPromise === pending) lazyDiscoveryPromise = null;
        if (!current || !notificationsActive) return;
        try {
          onSettled?.();
        } catch (error) {
          if (process.env.ATOMIC_WORKFLOW_DEBUG === "1") {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`Workflow background discovery callback failed: ${message}`);
          }
        }
      })
      .catch(() => {});
  }

  return {
    persistenceRef,
    mcpPort,
    runtimeProxy,
    configLoadRef,
    discoveryRef,
    lifecycleNotificationState,
    hilAnswerNotificationState,
    runtimeForContext,
    resetWorkflowDiscoveryForSession,
    ensureWorkflowConfigLoaded,
    ensureWorkflowResourcesLoaded,
    reloadWorkflowResources,
    startWorkflowDiscoveryWarmup,
    runWithLifecycleSuppressedForPolicy(policy, fn) {
      return policy.mode !== "non_interactive" || policy.awaitTerminalRun !== true
        ? fn()
        : withWorkflowLifecycleNotificationsSuppressedAsync(lifecycleNotificationState, fn);
    },
    setNotificationsActive(active) {
      notificationGeneration += 1;
      notificationsActive = active;
      reinstallLifecycleNotifications();
      reinstallHilAnswerNotifications();
    },
    setIntercomParentSession(session) { intercomParentSession = session; },
    updateHostStageSessionDir(sessionManager) {
      try {
        hostStageSessionDir.current = sessionManager?.usesDefaultSessionDir?.() === false
          ? sessionManager.getSessionDir?.()
          : undefined;
      } catch {
        hostStageSessionDir.current = undefined;
      }
    },
  };
}
