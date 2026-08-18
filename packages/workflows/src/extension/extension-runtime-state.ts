import { getDurableBackend } from "../durable/factory.js";
import { readWorkflowHeartbeatAnchor, recordWorkflowHeartbeatAnchor } from "../durable/workflow-heartbeat-anchor.js";
import { cancellationRegistry } from "../runs/background/cancellation-registry.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import type { SessionManager } from "../shared/persistence-restore.js";
import { stageUiBroker } from "../shared/stage-ui-broker.js";
import { store } from "../shared/store.js";
import { readGraphStoreSnapshot } from "../shared/store-observation.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type {
	WorkflowExecutionPolicy,
	WorkflowMcpPort,
	WorkflowPersistencePort,
	WorkflowRuntimeConfig,
} from "../shared/types.js";
import type { WorkflowHeartbeatIdentity } from "../shared/workflow-heartbeat-contract.js";
import {
	type ConfigLoadResult,
	loadWorkflowConfig,
	toScopedDiscoveryConfig,
	WORKFLOW_CONFIG_DEFAULTS,
	withWorkflowDefaults,
} from "./config-loader.js";
import { type DiscoveryResult, discoverStartupWorkflowsSync, discoverWorkflows } from "./discovery.js";
import {
	createWorkflowHilAnswerNotificationState,
	installWorkflowHilAnswerNotifications,
	registerHilAnswerNoticeRenderer,
} from "./hil-answer-notifications.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	registerLifecycleNoticeRenderer,
	seedWorkflowLifecycleNotificationState,
	type WorkflowLifecycleNotificationConfig,
	withWorkflowLifecycleNotificationsSuppressedAsync,
} from "./lifecycle-notifications.js";
import type { ExtensionAPI, PiModelContext } from "./public-types.js";
import { createExtensionRuntime, type ExtensionRuntime } from "./runtime.js";
import { createStatusWriter, type StatusWriter } from "./status-writer.js";
import { registerWorkflowHeartbeatRenderer } from "./workflow-heartbeat-notice.js";
import {
	createWorkflowHeartbeatSchedulerState,
	installWorkflowHeartbeatScheduler,
	isWorkflowHeartbeatTerminalRun,
	resetWorkflowHeartbeatSchedulerState,
	type WorkflowHeartbeatAnchorStore,
	type WorkflowHeartbeatScheduler,
	workflowHeartbeatConsumedIdentity,
	workflowHeartbeatContextInvalidation,
} from "./workflow-heartbeat-scheduler.js";
import { workflowModelCatalogFromContext } from "./workflow-model-catalog.js";
import { makeMcpPort, makePersistencePort } from "./workflow-ports.js";
import { createWorkflowReloadCoordinator } from "./workflow-reload-coordinator.js";
import { type WorkflowReloadReport, workflowReloadDiagnostics } from "./workflow-reload-report.js";

/**
 * Best-effort durable cadence-anchor store for workflow heartbeats.
 *
 * `getDurableBackend()` throws `DbosNotReadyError` until a backend exists, and
 * the scheduler installs at `session_start`, before any workflow has run — so
 * both sides swallow failure and fall back to the run's own `startedAt`.
 */
function durableWorkflowHeartbeatAnchorStore(): WorkflowHeartbeatAnchorStore {
	return {
		readAnchorAt(runId) {
			try {
				return readWorkflowHeartbeatAnchor(getDurableBackend(), runId);
			} catch {
				return undefined;
			}
		},
		async recordAnchorAt(runId, record) {
			try {
				return await recordWorkflowHeartbeatAnchor(getDurableBackend(), {
					runId,
					anchorAt: record.anchorAt,
					// The scheduler only records a positive cadence; a run launched
					// disabled never reaches this seam.
					intervalMinutes: record.intervalMinutes ?? 0,
					now: Date.now(),
				});
			} catch {
				// A backend that is not ready must not break a background pass; the
				// caller retries on the next schedule pass.
				return false;
			}
		},
	};
}

export interface WorkflowExtensionRuntimeState {
	persistenceRef: { current: WorkflowPersistencePort | undefined };
	mcpPort: WorkflowMcpPort | undefined;
	runtimeProxy: ExtensionRuntime;
	configLoadRef: { current: ConfigLoadResult | null };
	discoveryRef: { current: DiscoveryResult | null };
	lifecycleNotificationState: ReturnType<typeof createWorkflowLifecycleNotificationState>;
	hilAnswerNotificationState: ReturnType<typeof createWorkflowHilAnswerNotificationState>;
	workflowHeartbeatSchedulerState: ReturnType<typeof createWorkflowHeartbeatSchedulerState>;
	/** Seed lifecycle notification state before completed historical snapshots are inserted. */
	beforeRestoreCompleted(snapshots: readonly RunSnapshot[]): void;
	runtimeForContext(ctx?: PiModelContext): ExtensionRuntime;
	resetWorkflowDiscoveryForSession(): void;
	ensureWorkflowConfigLoaded(): Promise<void>;
	ensureWorkflowResourcesLoaded(): Promise<void>;
	reloadWorkflowResources(): Promise<WorkflowReloadReport>;
	startWorkflowDiscoveryWarmup(onSettled?: () => void): void;
	runWithLifecycleSuppressedForPolicy<T>(policy: WorkflowExecutionPolicy, fn: () => Promise<T>): Promise<T>;
	setNotificationsActive(active: boolean): void;
	updateHostStageSessionDir(sessionManager: SessionManager | undefined): void;
	/** Current default stage session directory, when the host set a non-default one. */
	resolveDefaultStageSessionDir(): string | undefined;
}

export function createWorkflowExtensionRuntimeState(
	pi: ExtensionAPI,
	adapters: StageAdapters,
	resolveCwd: () => string = () => pi.sessionManager?.getCwd?.() ?? process.cwd(),
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
			budget: withWorkflowDefaults({}).budget,
			worktree: WORKFLOW_CONFIG_DEFAULTS.worktree,
		},
	};
	let statusWriterRef: StatusWriter = createStatusWriter(store, runtimeConfigRef.current);
	let lifecycleNotificationsUnsubscribe: (() => void) | null = null;
	let hilAnswerNotificationsUnsubscribe: (() => void) | null = null;
	let workflowHeartbeatScheduler: WorkflowHeartbeatScheduler | null = null;
	let notificationsActive = false;
	let notificationGeneration = 0;
	const lifecycleNotificationState = createWorkflowLifecycleNotificationState();
	const hilAnswerNotificationState = createWorkflowHilAnswerNotificationState();
	const workflowHeartbeatSchedulerState = createWorkflowHeartbeatSchedulerState();
	const beforeRestoreCompleted = (snapshots: readonly RunSnapshot[]): void => {
		seedWorkflowLifecycleNotificationState(lifecycleNotificationState, {
			...readGraphStoreSnapshot(store),
			runs: snapshots,
		});
	};
	const lifecycleNotificationConfigRef: { current: WorkflowLifecycleNotificationConfig } = {
		current: WORKFLOW_CONFIG_DEFAULTS.workflowNotifications,
	};
	const registerMessageRenderer: ExtensionAPI["registerMessageRenderer"] | undefined =
		typeof pi.registerMessageRenderer === "function"
			? (event, renderer) => pi.registerMessageRenderer!(event, renderer)
			: undefined;
	registerLifecycleNoticeRenderer({ rendererHost: pi, registerMessageRenderer });
	registerHilAnswerNoticeRenderer({ rendererHost: pi, registerMessageRenderer });
	registerWorkflowHeartbeatRenderer({ rendererHost: pi, registerMessageRenderer });
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
	// `message_end` is the host's injection signal: agent-core emits it at the
	// moment a message enters the conversation. That is what releases a held
	// heartbeat slot.
	//
	// The turn-settled event is deliberately not used. The host emits it from the
	// prompt cycle's `finally` whether or not the queued messages were drained, so
	// pausing the queue mid-turn would release a slot whose card is still parked
	// and let the next boundary stack a second card behind it. `message_end` never
	// fires for a parked card. The visible display card is published on the
	// session-listener channel only, so an extension sees the hidden
	// reconciliation at consumption and never the card at admission — there is no
	// ambiguity to disambiguate. Proven end to end against a real `AgentSession`
	// in test/unit/workflow-heartbeat-parent-pickup.test.ts.
	//
	// Registered exactly once, at construction: `pi.on` has no unsubscribe, so a
	// per-install registration would accumulate a handler on every notification
	// cycle. The mutable scheduler reference is what routes the signal to the
	// current installation, and a `null` reference makes it a no-op.
	//
	// The same condition decides whether the scheduler holds a slot at all, so the
	// registration and the option can never disagree: a host that reports no
	// consumption would leave a held slot with nothing to release it.
	const parentAvailabilityReported = typeof pi.on === "function";
	if (parentAvailabilityReported) {
		// This handler observes, and for one narrow case replaces.
		//
		// The last guard on the heartbeat path (issue #1975): the three before it
		// all sit before `sendMessage`, so a heartbeat the host has already
		// admitted is beyond them. Consumption is the final moment before its
		// steer joins the model's context, and `message_end` may return a
		// replacement of the same role, so a heartbeat whose run has finished,
		// vanished, or no longer owns that exact scheduled identity is excluded
		// from context rather than steering the parent about stale work.
		//
		// `absent` counts as much as `terminal`. A card recovered at the restart
		// door is consumed just after `session_start` cleared the store, so its run
		// is normally absent. A durable resume may instead reuse the run id, but its
		// future pending boundary has a different `scheduledAt`. Both cases fail
		// exact pending ownership and preserve the no-backfill rule.
		pi.on?.("message_end", (event, ctx) => {
			// The host hands the session manager to the handler on its context; the
			// top-level `pi.sessionManager` is not populated in every host, so the
			// per-call one is preferred and the other is the fallback. Verified
			// against a real `AgentSession` in
			// test/unit/workflow-heartbeat-parent-pickup.test.ts.
			const entries = (ctx?.sessionManager ?? pi.sessionManager)?.getEntries?.();
			const invalidation = workflowHeartbeatContextInvalidation(event, entries, isWorkflowHeartbeatIdentityOwned);
			if (invalidation !== undefined) return invalidation;
			const identity = workflowHeartbeatConsumedIdentity(event, entries);
			if (identity !== undefined) workflowHeartbeatScheduler?.notifyHeartbeatConsumed(identity);
			return undefined;
		});
	}

	/** Whether this exact identity is still pending for a current nonterminal run. */
	function isWorkflowHeartbeatIdentityOwned(identity: WorkflowHeartbeatIdentity): boolean {
		const pending = workflowHeartbeatSchedulerState.pending.get(identity.runId);
		const run = store.runs().find((candidate) => candidate.id === identity.runId);
		return pending?.scheduledAt === identity.scheduledAt && run !== undefined && !isWorkflowHeartbeatTerminalRun(run);
	}

	/**
	 * Workflow heartbeats share the lifecycle-notice lifetime: they are armed
	 * while notifications are active and disposed with them. The cadence itself
	 * comes from the live registry, so a workflow reload is picked up without a
	 * reinstall.
	 */
	const reinstallWorkflowHeartbeatScheduler = (): void => {
		workflowHeartbeatScheduler?.dispose();
		workflowHeartbeatScheduler = null;
		if (!notificationsActive) return;
		workflowHeartbeatScheduler = installWorkflowHeartbeatScheduler({
			store,
			state: workflowHeartbeatSchedulerState,
			sendMessage: sendWorkflowNotificationMessage,
			resolveIntervalMinutes: (workflowName) => runtimeProxy.registry.get(workflowName)?.heartbeatIntervalMinutes,
			parentAvailabilityReported,
			anchorStore: durableWorkflowHeartbeatAnchorStore(),
		});
	};

	const hostStageSessionDir: { current: string | undefined } = { current: undefined };
	const resolveDefaultStageSessionDir = (): string | undefined => hostStageSessionDir.current;
	const startupDiscovery = discoverStartupWorkflowsSync();
	const runtimeRef: { current: ExtensionRuntime } = {
		current: createExtensionRuntime({
			registry: startupDiscovery.registry,
			cwd: resolveCwd(),
			adapters,
			cancellation: cancellationRegistry,
			persistence: persistenceRef.current,
			mcp: mcpPort,
			config: runtimeConfigRef.current,
			resolveDefaultStageSessionDir,
			beforeRestoreCompleted,
		}),
	};
	const discoveryRef: { current: DiscoveryResult | null } = { current: null };
	const configLoadRef: { current: ConfigLoadResult | null } = { current: null };
	const runtimeProxy: ExtensionRuntime = {
		get registry() {
			return runtimeRef.current.registry;
		},
		dispatch(args, options) {
			return runtimeRef.current.dispatch(args, options);
		},
		resumeFailedRun(sourceRunId, stageId, options) {
			return runtimeRef.current.resumeFailedRun(sourceRunId, stageId, options);
		},
		resumeDurableWorkflow(workflowId, options) {
			return runtimeRef.current.resumeDurableWorkflow(workflowId, options);
		},
		inspectDurableWorkflow(workflowId) {
			return runtimeRef.current.inspectDurableWorkflow(workflowId);
		},
		listDurableResumable() {
			return runtimeRef.current.listDurableResumable();
		},
		prepareDurableResumable(workflowId) {
			return runtimeRef.current.prepareDurableResumable(workflowId);
		},
		prepareDurableResumableForIds(workflowIds) {
			const targeted = runtimeRef.current.prepareDurableResumableForIds;
			if (targeted !== undefined) return targeted.call(runtimeRef.current, workflowIds);
			return runtimeRef.current.prepareDurableResumable();
		},
		prepareCompletedDurable() {
			return runtimeRef.current.prepareCompletedDurable?.() ?? Promise.resolve([]);
		},
		openCompletedDurableWorkflow(workflowId, catalog) {
			const open = runtimeRef.current.openCompletedDurableWorkflow;
			if (open === undefined) {
				return {
					ok: false,
					reason: "not_found",
					message: `No completed durable workflow found for id: ${workflowId}`,
				};
			}
			return open(workflowId, catalog);
		},
	};

	function runtimeForContext(ctx?: PiModelContext): ExtensionRuntime {
		const models = workflowModelCatalogFromContext(ctx);
		if (models === undefined) return runtimeProxy;
		return createExtensionRuntime({
			registry: runtimeRef.current.registry,
			cwd: resolveCwd(),
			adapters,
			cancellation: cancellationRegistry,
			persistence: persistenceRef.current,
			mcp: mcpPort,
			config: runtimeConfigRef.current,
			models,
			resolveDefaultStageSessionDir,
			beforeRestoreCompleted,
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
			budget: effectiveConfig.budget,
			worktree: effectiveConfig.worktree,
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
			cwd: resolveCwd(),
			adapters,
			cancellation: cancellationRegistry,
			persistence: persistenceRef.current,
			mcp: mcpPort,
			config: runtimeConfigRef.current,
			resolveDefaultStageSessionDir,
			beforeRestoreCompleted,
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
		void pending
			.finally(() => {
				if (lazyDiscoveryPromise === pending) lazyDiscoveryPromise = null;
			})
			.catch(() => {});
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
			const discoveryConfig =
				hasGlobal || hasProject
					? toScopedDiscoveryConfig(configResult.globalConfig ?? null, configResult.projectConfig ?? null, {
							projectRoot: process.cwd(),
						})
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
			const pending = lazyDiscoveryPromise ?? trackLazyDiscovery(reloadCoordinator.request(discoveryGeneration));
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
		const isCurrentWarmup = (): boolean =>
			lazyDiscoveryPromise === pending &&
			notificationGeneration === notificationStart &&
			isWorkflowDiscoveryCurrent(discoveryStart);
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
		workflowHeartbeatSchedulerState,
		beforeRestoreCompleted,
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
			// A fresh host session restarts the cadence from each run's persisted
			// start time; prior-session schedule and pending state cannot apply.
			if (!active) resetWorkflowHeartbeatSchedulerState(workflowHeartbeatSchedulerState);
			reinstallWorkflowHeartbeatScheduler();
		},
		updateHostStageSessionDir(sessionManager) {
			try {
				hostStageSessionDir.current =
					sessionManager?.usesDefaultSessionDir?.() === false ? sessionManager.getSessionDir?.() : undefined;
			} catch {
				hostStageSessionDir.current = undefined;
			}
		},
		resolveDefaultStageSessionDir,
	};
}
