import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { AuthInteraction } from "@bastani/atomic-ai";
import type { Api, Model } from "@bastani/atomic-ai/compat";
import type { AgentSession, ClearedQueue, CompactionReason } from "../../core/agent-session.js";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionBindings,
	ModelMutationOptions,
	PromptDisposition,
	PromptOptions,
	SessionRecoveryReport,
} from "../../core/agent-session-types.js";
import { onDebugSettingChange } from "../../core/debug-setting.ts";
import type { ResourceOverlap } from "../../core/diagnostics.ts";
import type { ExtensionError } from "../../core/extensions/index.js";
import type { SessionRecoveryReason } from "../../core/extensions/session-events.ts";
import type { WorkflowActivityFrame } from "../../core/extensions/workflow-events.js";
import { mergeSessionTrustDecisions, type SessionTrustDecisions } from "../../core/project-trust-state.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { serializeSessionMutation } from "../../core/session-mutation-queue.ts";
import { retryStatusUpdate, type SessionRetryStatus } from "../../core/session-retry-status.js";
import type { StopAllBackgroundOutcome } from "../../core/tasks/stop-all.ts";
import type { ToolStatusReport } from "../../core/tool-status.js";
import { captureHerdrEnvironment } from "../../extensions/herdr/environment.js";
import { releaseUnownedPaneRegistration } from "../../extensions/herdr/pane-owner.js";
import { warnDeprecation } from "../../utils/deprecation.js";
import { canonicalizePathAsync } from "../../utils/paths.ts";
import { sleep } from "../../utils/sleep.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import type { AgentPanelCounts } from "../rpc/agent-panel-bridge.ts";
import type { RpcClient } from "../rpc/rpc-client.ts";
import { isExtensionLoadError } from "../rpc/rpc-extension-load-errors.ts";
import {
	isRpcRequestAcceptedFailure,
	isRpcTransportFailure,
	markRpcTransportFailure,
	rpcTransportError,
} from "../rpc/rpc-transport-error.ts";
import type {
	RpcAutocompleteItem,
	RpcEvent,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcModelCatalog,
	RpcPersistedModelDefaults,
	RpcResourceExtension,
	RpcResumeNotice,
	RpcSessionState,
	RpcSlashCommand,
} from "../rpc/rpc-types.ts";
import type { ActivityWatchdogDiagnostic } from "./activity-watchdog.ts";
import type { InteractiveEngineGenerationEndedListener } from "./engine-generation.ts";
import { type EngineDiagnosticListener, EngineHealthController } from "./engine-health.ts";
import { EngineSessionStats } from "./engine-session-stats.js";
import {
	type AtomicOAuthLoginCallbacks,
	loginIsolatedApiKeyProvider,
	loginIsolatedOAuthProvider,
} from "./isolated-auth.ts";
import type { EngineKeybindingState, InteractiveEngineCommand, InteractiveEngineMessage } from "./protocol.ts";
import { RemoteCommandCatalog, type RemoteCommandsListener } from "./remote-command-catalog.ts";
import { RemoteModelCatalog } from "./remote-model-catalog.ts";
import { RemoteQueuePause } from "./remote-queue-pause.js";
import { InteractiveEngineResourceReadinessError } from "./resource-readiness-error.ts";

/** The extension load errors and warnings of the engine's last (re)load. */
export interface EngineResourceIssues {
	errors: Array<{ path: string; error: string }>;
	warnings: Array<{ path: string; warning: string }>;
}
type ResourceExtensionsListener = (extensions: readonly RpcResourceExtension[], forNextView?: true) => void;
type QueueSnapshot = { steering: string[]; followUp: string[] };

/** An extension error of the engine's session, as its RPC binding reports it on the event stream. */
function isEngineExtensionError(record: unknown): record is { type: "extension_error" } & ExtensionError {
	return typeof record === "object" && record !== null && (record as { type?: unknown }).type === "extension_error";
}

function applyPersistedModelDefault(
	session: AgentSession,
	model: Pick<Model<Api>, "provider" | "id">,
	alreadyInScope: boolean,
): void {
	session.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
	if (alreadyInScope || session.scopedModels.length === 0) return;
	const enabledModels = session.settingsManager.getGlobalSettings().enabledModels;
	if (!enabledModels?.length) return;
	const modelReference = `${model.provider}/${model.id}`;
	if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase())) return;
	session.settingsManager.setEnabledModels([...enabledModels, modelReference]);
}

function thinkingPersistTarget(result: {
	provider?: string;
	modelId?: string;
}): { provider: string; modelId: string } | undefined {
	if (!result.provider || !result.modelId) return undefined;
	return { provider: result.provider, modelId: result.modelId };
}

function applyPersistedThinkingDefault(
	session: AgentSession,
	level: AgentSession["thinkingLevel"],
	target?: { provider: string; modelId: string },
): void {
	if (target) {
		session.settingsManager.setModelThinkingLevel(target.provider, target.modelId, level);
	}
	session.settingsManager.setDefaultThinkingLevel(level);
}

type PendingQueueClear = {
	snapshot: QueueSnapshot;
	queueUpdateGeneration: number;
	count: number;
	succeeded: boolean;
};

/**
 * Owns Atomic's local interactive host facade and child-process engine.
 *
 * This runtime is deliberately not a RemoteSession adapter. Its JSONL RPC,
 * rendering, custom UI, and recovery lifecycle stay separate from pi-client's
 * protocol lease lifecycle.
 */
/** The agent panel counts an engine's panel state carries, as the host's hint line reads them. */
export function engineAgentPanelCounts(
	message: Extract<InteractiveEngineMessage, { type: "engine_agent_panel_state" }>,
): AgentPanelCounts {
	return {
		total: message.total,
		// An engine that predates the agent count counted every row as an agent.
		agents: message.agents ?? message.total,
		needsInput: message.needsInput,
		shells: message.shells ?? 0,
		subagents: message.subagents ?? 0,
		...(message.hiddenWorkflow ? { hiddenWorkflow: true } : {}),
	};
}

export class IsolatedInteractiveRuntime extends AgentSessionRuntime {
	private readonly client: RpcClient;
	/** The engine prepares every resume of this session and builds its blueprints; this mirror only restores the same state. */
	protected override resumeBlueprints: "build" | "skip" = "skip";
	private readonly patchedSessions = new WeakSet<AgentSession>();
	/** Host sessions bound with an extension error listener. Engine errors that arrive before one is bound wait for it. */
	private readonly errorReportingSessions = new WeakSet<AgentSession>();
	private readonly heldExtensionErrors: ExtensionError[] = [];
	private readonly patchedSettingsManagers = new WeakSet<AgentSession["settingsManager"]>();
	private mirroringPersistedModelDefault = false;
	private pendingEnabledModelsSync: { patterns: string[] | null } | undefined;
	private streaming = false;
	private streamingEpoch = 0;
	private turnStartedAt?: number;
	private retryStatus?: SessionRetryStatus;
	private retryStatusEpoch = 0;
	private panelCounts: AgentPanelCounts = { total: 0, agents: 0, needsInput: 0, shells: 0, subagents: 0 };
	private compacting = false;
	/** Whether the engine has a retry or fallback in progress. */
	private retrying = false;
	private compactionReason: CompactionReason | undefined;
	private compactionStartedAt: number | undefined;
	private readonly activeBashRequestIds = new Map<string | symbol, string>();
	private steeringMessages: string[] = [];
	private followUpMessages: string[] = [];
	/** Bumped by every authoritative queue_update. */
	private queueUpdateGeneration = 0;
	/** Bumped by local thinking mutations and thinking_level_changed events. */
	private thinkingEpoch = 0;
	private modelEpoch = 0;
	/** Clears started before the next queue_update share one rollback snapshot. */
	private pendingQueueClear: PendingQueueClear | undefined;
	private engineCallbackActive = false;
	private readonly queuePause: RemoteQueuePause;
	private readonly sessionStats: EngineSessionStats;
	private autoCompactionEnabled = true;
	private autoRetryEnabled = true;
	/** Whether the engine reported a trust decision for its current session; it reports none while still deciding. */
	private engineProjectTrustReported = false;
	/** The next engine catalog for this session follows a startup view drawn without the folder's resources. */
	private readonly restrictedStartupCatalogs = new WeakSet<AgentSession>();
	/** The engine's trust decisions in this host session, handed to an engine started to replace it. */
	private knownTrust: SessionTrustDecisions = { projects: {}, extensionSources: {} };
	private readonly projectTrustListeners = new Set<(resourcesChanged: boolean) => void>();
	private remoteSessionName: string | undefined;
	private remoteSessionId: string | undefined;
	private remoteSessionFile: string | undefined;
	private readonly health: EngineHealthController;
	private readonly remoteCommands: RemoteCommandCatalog;
	/** The first engine child's start, while it may still be in flight; settles once it announced readiness or failed to. */
	private readonly initialStart: Promise<void> | undefined;
	private initialStartSettled: boolean;
	/** Why the first engine child never started. Its loss is a startup failure, never a recovery. */
	private startupFailure: Error | undefined;
	private disposed = false;
	private disposePromise: Promise<void> | undefined;
	private readonly remoteModelCatalog: RemoteModelCatalog;
	private resourceOverlaps: ResourceOverlap[] = [];
	private readonly resourceExtensionsListeners: ResourceExtensionsListener[] = [];
	private resourceExtensions: RpcResourceExtension[] = [];
	private legacyWorkflowFileCount = 0;
	private resourceIssues: EngineResourceIssues = { errors: [], warnings: [] };
	private resourcesInitializedGeneration = 0;
	private resourceInitialization: { generation: number; promise: Promise<void> } | undefined;
	private readonly retiredResourceGenerations = new Set<number>();
	private readonly reportedResourceFailureGenerations = new Set<number>();
	private initializationTail: Promise<void> | undefined;
	private engineRecoveryFailure: Error | undefined;
	private promptCancellationEpoch = 0;
	private hostExtensionUIReset: (() => void) | undefined;
	private readonly stopSharingDebugSetting: () => void;

	/**
	 * @param initialStart The first engine child's `client.start()`, still in flight: the host paints and takes input
	 * while the engine loads. When it rejects, this runtime is disposed as a failed startup, and `waitUntilBound`
	 * rejects with its error.
	 */
	constructor(
		localRuntime: AgentSessionRuntime,
		createRuntime: CreateAgentSessionRuntimeFactory,
		client: RpcClient,
		initialStart?: Promise<void>,
	) {
		super(
			localRuntime.session,
			localRuntime.services,
			createRuntime,
			[...localRuntime.diagnostics],
			localRuntime.modelFallbackMessage,
			localRuntime.modelFallbackReason,
			true,
		);
		this.adoptSessionStores(localRuntime);
		this.client = client;
		this.remoteCommands = new RemoteCommandCatalog(client);
		this.remoteModelCatalog = new RemoteModelCatalog(client);
		this.queuePause = new RemoteQueuePause(client);
		this.sessionStats = new EngineSessionStats(client);
		this.health = new EngineHealthController({
			stop: () => this.client.stop(),
			restart: async (replacementReady) => {
				this.engineRecoveryFailure = undefined;
				try {
					const manager = super.session.sessionManager;
					await this.client.restart(manager.isPersisted() ? manager.getSessionId() : undefined, {
						cwd: manager.getCwd(),
						sessionDirectory: manager.getSessionDir() || undefined,
						trustDecisions: this.knownTrust,
					});
					replacementReady();
					await this.initializeFromEngine();
				} catch (error) {
					const failure = markRpcTransportFailure(error);
					this.engineRecoveryFailure = failure;
					throw failure;
				}
			},
			clearActivity: () => {
				this.streaming = false;
				this.streamingEpoch++;
				this.turnStartedAt = undefined;
				this.retryStatus = undefined;
				this.retryStatusEpoch++;
				this.compacting = false;
				this.retrying = false;
				this.compactionReason = undefined;
				this.compactionStartedAt = undefined;
				this.pendingQueueClear = undefined;
				this.engineCallbackActive = false;
				this.health.markCooperativeAbortSettled();
			},
		});
		this.client.onEvent((event) => this.observeEvent(event));
		this.stopSharingDebugSetting = onDebugSettingChange((enabled) =>
			this.dispatchBestEffort("set debug", this.client.setDebug(enabled)),
		);
		this.initialStartSettled = initialStart === undefined;
		this.initialStart = initialStart?.then(
			() => {
				this.initialStartSettled = true;
			},
			async (error: Error) => {
				this.initialStartSettled = true;
				// A quit before the engine was ready stopped it on purpose: nothing failed.
				if (this.disposed) return;
				this.startupFailure = error;
				await this.dispose({ fromSignal: true }).catch(() => {});
				throw error;
			},
		);
		this.initialStart?.catch(() => {});
		this.client.onGenerationEnded((event) => {
			this.retiredResourceGenerations.add(event.generation);
			if (event.generation === this.client.getGeneration()) {
				this.panelCounts = { total: 0, agents: 0, needsInput: 0, shells: 0, subagents: 0 };
				this.updateResources({});
			}
			// A first child that never became ready failed startup; initialStart reports it instead of a restart.
			if (!this.initialStartSettled) {
				this.health.handleGenerationEnded({ ...event, expected: true });
				return;
			}
			this.health.handleGenerationEnded(event);
		});
		// Production RpcClient instances expose engine lifecycle messages. Keep the
		// subscription optional so focused runtime test doubles that exercise only
		// session/model/bash behavior do not need to implement unrelated transport
		// surfaces.
		this.client.onInteractiveEngineMessage?.((message) => {
			if (message.type === "engine_project_resources_withheld") {
				this.applyProjectPermissionWhilePending(message.path, false, true);
				return;
			}
			if (message.type === "engine_trust_decision") {
				this.knownTrust = mergeSessionTrustDecisions(this.knownTrust, {
					[message.scope]: { [message.path]: message.trusted },
				});
				if (message.scope === "projects" && !this.engineProjectTrustReported)
					this.applyProjectPermissionWhilePending(message.path, message.trusted);
				return;
			}
			if (message.type === "engine_deprecation_warning") {
				warnDeprecation(message.message, message.once === undefined ? {} : { once: message.once });
				return;
			}
			if (message.type === "engine_agent_panel_state") {
				this.panelCounts = engineAgentPanelCounts(message);
				return;
			}
			if (message.type === "engine_extension_ui_reset") {
				this.panelCounts = { total: 0, agents: 0, needsInput: 0, shells: 0, subagents: 0 };
				this.hostExtensionUIReset?.();
				return;
			}
			if (message.type !== "engine_resources_ready" && message.type !== "engine_resources_failed") return;
			const observedGeneration = this.client.getGeneration();
			void this.waitUntilResourcesReady().catch((error: Error) => {
				const generation =
					error instanceof InteractiveEngineResourceReadinessError ? error.generation : observedGeneration;
				if (this.reportedResourceFailureGenerations.has(generation)) return;
				this.reportedResourceFailureGenerations.add(generation);
				this.emitDiagnostic({
					activity: undefined,
					elapsedMs: 0,
					level: "unresponsive",
					message: error.message,
					error,
				});
			});
		});
	}

	get agentPanelCounts(): Readonly<AgentPanelCounts> {
		return this.panelCounts;
	}

	override get session(): AgentSession {
		const session = super.session;
		this.patchSession(session);
		return session;
	}
	async openTaskInspector(taskId?: string): Promise<void> {
		await this.client.requestInternal({ type: "open_task_inspector", ...(taskId ? { taskId } : {}) });
	}
	async openAgentPanel(): Promise<void> {
		await this.client.requestInternal({ type: "open_agent_panel" });
	}
	async setStopAllNotice(text: string | undefined): Promise<void> {
		await this.client.requestInternal({ type: "set_stop_all_notice", ...(text === undefined ? {} : { text }) });
	}
	/** The engine owns the session's tasks and workflow runs, so it stops them. */
	async stopAllBackgroundWork(): Promise<StopAllBackgroundOutcome> {
		return this.client.requestInternal<StopAllBackgroundOutcome>({ type: "stop_all_background" });
	}
	/** The engine owns extensions and tools; the host session has neither. */
	async getToolStatus(): Promise<ToolStatusReport> {
		return this.client.requestInternal<ToolStatusReport>({ type: "get_tools" });
	}
	async initializeFromEngine(generation = this.client.getGeneration?.()): Promise<void> {
		const run = this.initializationTail
			? this.initializationTail.then(() => this.initializeFromEngineGeneration(generation))
			: this.initializeFromEngineGeneration(generation);
		const tail = run.catch(() => {});
		this.initializationTail = tail;
		void tail.then(() => {
			if (this.initializationTail === tail) this.initializationTail = undefined;
		});
		return run;
	}

	private async settleEngineResync(): Promise<void> {
		await this.initializationTail;
	}

	/**
	 * The project's own decision, made while startup still decides other trust (an `-e` source's question, which also
	 * keeps the engine's other requests waiting for its resources). Each source follows its own decision, so the
	 * project's resources load, or stay out, now instead of when startup has decided. It is no startup decision: the
	 * warning still waits for that (#5693).
	 */
	private applyProjectPermissionWhilePending(path: string, trusted: boolean, withheld = false): void {
		const generation = this.client.getGeneration?.();
		const apply = async () => {
			const session = super.session;
			if (this.disposed || this.engineProjectTrustReported) return;
			if (generation !== undefined && !this.isCurrentResourceGeneration(generation)) return;
			const [decided, current] = await Promise.all([
				canonicalizePathAsync(path),
				canonicalizePathAsync(session.sessionManager.getCwd()),
			]);
			if (decided !== current || session !== super.session || this.engineProjectTrustReported) return;
			if (this.disposed || (generation !== undefined && !this.isCurrentResourceGeneration(generation))) return;
			if (withheld) {
				if (Object.hasOwn(this.knownTrust.projects, path)) return;
				this.restrictedStartupCatalogs.add(session);
			}
			if (session.settingsManager.isProjectTrusted() === trusted) return;
			await session.settingsManager.setProjectTrustedAsync(trusted);
			// Withholding a folder did not invalidate user settings. The setter has loaded its project layer.
			if (this.restrictedStartupCatalogs.has(session))
				await session.resourceLoader.reload({ useLoadedSettings: true });
			else {
				await session.settingsManager.reload();
				await session.resourceLoader.reload();
			}
			if (
				this.disposed ||
				session !== super.session ||
				(generation !== undefined && !this.isCurrentResourceGeneration(generation))
			)
				return;
			for (const listener of [...this.projectTrustListeners]) listener(true);
		};
		// After any synchronization in flight, so an earlier report cannot undo the decision.
		const run = (this.initializationTail ?? Promise.resolve()).then(apply);
		const tail = run.catch(() => {});
		this.initializationTail = tail;
		void tail.then(() => {
			if (this.initializationTail === tail) this.initializationTail = undefined;
		});
	}

	/** Keep a live engine's report as soon as it arrives, before the caller waits on other engine or session work. */
	private async getEngineState(): Promise<RpcSessionState> {
		const generation = this.client.getGeneration?.();
		const state = await this.client.getState();
		if (state.trustDecisions && (generation === undefined || this.isCurrentResourceGeneration(generation))) {
			this.knownTrust = mergeSessionTrustDecisions(this.knownTrust, state.trustDecisions);
		}
		return state;
	}

	private async initializeFromEngineGeneration(generation: number | undefined): Promise<void> {
		if (this.disposed || (generation !== undefined && !this.isCurrentResourceGeneration(generation))) return;
		try {
			this.sessionStats.reset();
			this.pendingEnabledModelsSync = undefined;
			const modelEpoch = this.modelEpoch;
			const retryStatusEpoch = this.retryStatusEpoch;
			const streamingEpoch = this.streamingEpoch;
			const thinkingEpoch = this.thinkingEpoch;
			const scope = this.remoteModelCatalog.getScopeSnapshot();
			const state = await this.getEngineState();
			if (generation !== undefined && !this.isCurrentResourceGeneration(generation)) return;
			const catalog = await this.client.requestInternal<RpcModelCatalog>({
				type: "get_available_models",
				allowPartialResources: true,
			});
			if (generation !== undefined && !this.isCurrentResourceGeneration(generation)) return;
			if (
				(super.session.sessionManager.isPersisted() && state.sessionId !== super.session.sessionId) ||
				(state.sessionLocation &&
					(await canonicalizePathAsync(dirname(state.sessionLocation))) !==
						(await canonicalizePathAsync(super.session.sessionManager.getSessionDir())))
			) {
				await super.switchSession(state.sessionId, {
					sessionDirectory: state.sessionLocation ? dirname(state.sessionLocation) : undefined,
					history: "tail",
				});
				if (generation !== undefined && !this.isCurrentResourceGeneration(generation)) return;
			}
			const session = super.session;
			const trustBefore = [session.settingsManager.isProjectTrusted(), this.engineProjectTrustReported] as const;
			const followsRestrictedCatalog = this.restrictedStartupCatalogs.has(session);
			if (state.pendingProjectResourcesTrusted === false) this.restrictedStartupCatalogs.add(session);
			else if (state.projectTrusted !== undefined) this.restrictedStartupCatalogs.delete(session);
			const resourcesTrusted = state.projectTrusted ?? state.pendingProjectResourcesTrusted;
			if (resourcesTrusted !== undefined && session.settingsManager.isProjectTrusted() !== resourcesTrusted) {
				// The child owns trust hooks/decisions. The host only mirrors their result.
				await session.settingsManager.setProjectTrustedAsync(resourcesTrusted);
				if (followsRestrictedCatalog || state.pendingProjectResourcesTrusted !== undefined) {
					await session.resourceLoader.reload({ useLoadedSettings: true });
				} else {
					await session.settingsManager.reload();
					await session.resourceLoader.reload();
				}
				if (generation !== undefined && !this.isCurrentResourceGeneration(generation)) return;
			}
			// A pending report keeps the project's resources out until the engine decides; it is no decision to warn about.
			this.engineProjectTrustReported = state.projectTrusted !== undefined;
			if (this.engineProjectTrustReported) session.settingsManager.trackEditsWhileProjectTrustPending(false);
			const resourcesChanged = trustBefore[0] !== session.settingsManager.isProjectTrusted();
			if (resourcesChanged || trustBefore[1] !== this.engineProjectTrustReported) {
				for (const listener of [...this.projectTrustListeners]) listener(resourcesChanged);
			}
			this.remoteModelCatalog.apply(catalog, scope);
			this.remoteModelCatalog.patch(session);
			if (modelEpoch === this.modelEpoch) {
				(session.agent.state as { model?: Model<Api> }).model = state.model;
			}
			if (thinkingEpoch === this.thinkingEpoch) {
				session.agent.state.thinkingLevel = state.thinkingLevel;
			}
			session.agent.steeringMode = state.steeringMode;
			session.agent.followUpMode = state.followUpMode;
			this.autoCompactionEnabled = state.autoCompactionEnabled;
			this.resourceOverlaps = state.resourceOverlaps ?? [];
			this.updateResources(state, followsRestrictedCatalog);
			this.remoteSessionName = state.sessionName;
			this.remoteSessionId = state.sessionId;
			this.remoteSessionFile = state.sessionLocation;
			if (retryStatusEpoch === this.retryStatusEpoch) this.retryStatus = state.retryStatus;
			if (streamingEpoch === this.streamingEpoch) {
				this.streaming = state.isStreaming;
				this.turnStartedAt = state.turnStartedAt;
			}
			this.compacting = state.isCompacting;
			this.compactionReason = state.isCompacting ? state.compactionReason : undefined;
			this.compactionStartedAt = state.isCompacting
				? (state.compactionStartedAt ?? this.compactionStartedAt ?? Date.now())
				: undefined;
			this.queuePause.synchronize(state.queuedMessagesPaused === true);
			this.replaceModelFallback(state.modelFallbackMessage, state.modelFallbackReason);
			await this.refreshSessionView();
			this.sessionStats.refresh();
			this.engineCallbackActive = false;
			this.health.clearUnresponsive();
			this.health.markCooperativeAbortSettled();
			// Non-blocking refresh so isolated autocomplete lists engine-only extension
			// commands after bind/restart/reload/new/resume/fork. See RemoteCommandCatalog.
			this.remoteCommands.refresh(followsRestrictedCatalog || state.pendingProjectResourcesTrusted === false);
		} catch (error) {
			if (this.disposed && isRpcTransportFailure(error)) return;
			throw error;
		}
	}

	override async loginOAuthProvider(provider: string, callbacks: AtomicOAuthLoginCallbacks) {
		return loginIsolatedOAuthProvider(super.session, this.client, this.remoteModelCatalog, provider, callbacks);
	}

	override async loginApiKeyProvider(provider: string, interaction: AuthInteraction) {
		return loginIsolatedApiKeyProvider(super.session, this.client, this.remoteModelCatalog, provider, interaction);
	}

	override async logoutProvider(provider: string) {
		const scope = this.remoteModelCatalog.getScopeSnapshot();
		const result = await this.client.logoutProvider(provider);
		this.remoteModelCatalog.applyModels({ models: result.models, scopedModels: result.scopedModels ?? [] }, scope);
		await super.session.modelRuntime.reloadCredentials({ refreshAvailability: false });
		super.session.modelRuntime.applyExternalProviderAuthStatus(provider, result.authStatus);
		this.remoteModelCatalog.applyProviderAuthStatus(provider, result.authStatus);
		await super.session.refreshCurrentModelFromRegistry();
		return result;
	}

	onDiagnostic(listener: EngineDiagnosticListener): () => void {
		return this.health.onDiagnostic(listener);
	}

	/** Fires when fresh engine session stats arrive, so the host can repaint its footer. */
	onSessionStatsChanged(listener: () => void): () => void {
		return this.sessionStats.onChange(listener);
	}

	onEngineMessage(listener: (message: InteractiveEngineMessage) => void): () => void {
		return this.client.onInteractiveEngineMessage(listener);
	}
	/** Workflow activity of the engine child, starting from its current snapshot. */
	onWorkflowActivity(listener: (frame: WorkflowActivityFrame) => void): () => void {
		return this.client.onInteractiveEngineWorkflowActivity(listener);
	}
	onKeybindingState(listener: (state: EngineKeybindingState) => void): () => void {
		return this.client.onInteractiveEngineKeybindingState(listener);
	}

	sendEngineCommand(command: InteractiveEngineCommand): void {
		this.client.sendInteractiveEngineCommand(command);
	}

	/** Report a native host trust dialog to the extension runner in this engine generation. */
	async withProjectTrustPrompt<T>(
		kind: "select" | "confirm" | "input",
		title: string,
		run: () => Promise<T>,
	): Promise<T> {
		const generation = this.client.getGeneration();
		const componentId = randomUUID();
		const notify = (command: InteractiveEngineCommand) => {
			if (this.disposed || generation !== this.client.getGeneration()) return;
			try {
				this.sendEngineCommand(command);
			} catch {
				// Status notification failure must not prevent a host-owned trust decision.
			}
		};
		notify({ type: "engine_project_trust_start", componentId, kind, title });
		try {
			return await run();
		} finally {
			notify({ type: "engine_project_trust_end", componentId });
		}
	}

	getRemoteCommands(): readonly RpcSlashCommand[] {
		return this.remoteCommands.getCommands();
	}
	onRemoteCommandsChanged(listener: RemoteCommandsListener): () => void {
		return this.remoteCommands.onChange(listener);
	}
	getRemoteCommandCompletions(commandName: string, argumentPrefix: string): Promise<RpcAutocompleteItem[] | null> {
		return this.client.getCommandCompletions(commandName, argumentPrefix);
	}

	async invokeRemoteShortcut(key: string): Promise<void> {
		await this.client.requestInternal<void>({ type: "invoke_shortcut", key });
	}

	async waitUntilBound(): Promise<void> {
		try {
			// A failed start rejects once this runtime has been disposed, so its store is closed when the failure reaches us.
			if (this.initialStart && (!this.initialStartSettled || this.startupFailure)) await this.initialStart;
			if (this.startupFailure) throw this.startupFailure;
			await this.client.waitForInteractiveEngineBound();
		} catch (error) {
			if (this.startupFailure) throw this.startupFailure;
			if (this.disposed && isRpcTransportFailure(error)) return;
			throw error;
		}
	}
	async waitUntilProjectTrustSettled(): Promise<void> {
		await this.client.waitForInteractiveEngineProjectTrust();
		await this.initializeFromEngine();
	}
	/** The engine decides project trust: until it reports a decision, this host's trust is only its own lookup. */
	override isProjectTrustPending(): boolean {
		return !this.engineProjectTrustReported;
	}
	/** A catalog request started from a restricted startup view must not replace that view with a later catalog. */
	captureStartupCatalog(): (() => boolean) | undefined {
		const session = super.session;
		if (!this.restrictedStartupCatalogs.has(session)) return undefined;
		const trusted = session.settingsManager.isProjectTrusted();
		return () =>
			this.restrictedStartupCatalogs.has(session) && session.settingsManager.isProjectTrusted() === trusted;
	}
	/** The trust decisions the engine reported in this host session. */
	override trustDecisions(): SessionTrustDecisions {
		return this.knownTrust;
	}
	/** Called when this host's trust for its session, or whether the engine has decided it, changes. */
	onProjectTrustChanged(listener: (resourcesChanged: boolean) => void): () => void {
		this.projectTrustListeners.add(listener);
		return () => this.projectTrustListeners.delete(listener);
	}
	async waitUntilResourcesReady(): Promise<void> {
		while (true) {
			this.throwIfUnavailable();
			const generation = this.client.getGeneration();
			if (this.retiredResourceGenerations.has(generation)) {
				await this.waitForReplacementGeneration(generation);
				continue;
			}
			try {
				await this.client.waitForInteractiveEngineResources();
			} catch (error) {
				this.throwIfUnavailable();
				if (!this.isCurrentResourceGeneration(generation)) {
					await this.waitForReplacementGeneration(generation);
					continue;
				}
				if (isRpcTransportFailure(error)) throw error;
				throw new InteractiveEngineResourceReadinessError(
					generation,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
			if (!this.isCurrentResourceGeneration(generation)) {
				await this.waitForReplacementGeneration(generation);
				continue;
			}
			if (this.resourcesInitializedGeneration === generation) return;

			let initialization = this.resourceInitialization;
			if (initialization?.generation !== generation) {
				const promise = this.initializeFromEngine(generation).finally(() => {
					if (this.resourceInitialization?.generation === generation) this.resourceInitialization = undefined;
				});
				initialization = { generation, promise };
				this.resourceInitialization = initialization;
			}
			try {
				await initialization.promise;
			} catch (error) {
				this.throwIfUnavailable();
				if (!this.isCurrentResourceGeneration(generation)) {
					await this.waitForReplacementGeneration(generation);
					continue;
				}
				throw error;
			}
			this.throwIfUnavailable();
			if (!this.isCurrentResourceGeneration(generation)) {
				await this.waitForReplacementGeneration(generation);
				continue;
			}
			this.resourcesInitializedGeneration = generation;
			return;
		}
	}

	private isCurrentResourceGeneration(generation: number): boolean {
		return generation === this.client.getGeneration() && !this.retiredResourceGenerations.has(generation);
	}

	private async waitForReplacementGeneration(generation: number): Promise<void> {
		while (generation === this.client.getGeneration()) {
			this.throwIfUnavailable();
			await sleep(1);
		}
	}

	private throwIfUnavailable(): void {
		if (this.startupFailure) throw this.startupFailure;
		if (this.disposed) throw rpcTransportError("Interactive engine runtime is disposed");
		if (this.engineRecoveryFailure) throw this.engineRecoveryFailure;
	}
	getEnginePid(): number | undefined {
		return this.client.getEnginePid();
	}
	getEngineGeneration(): number {
		return this.client.getGeneration();
	}
	isRecovering(): boolean {
		return this.health.isRecovering();
	}
	/** Subscribe to host-local engine generation death (see engine-generation.ts). */
	onGenerationEnded(listener: InteractiveEngineGenerationEndedListener): () => void {
		return this.client.onGenerationEnded(listener);
	}
	/**
	 * A heartbeat proves the child's event loop is turning again, so a stall the
	 * watchdog already reported must stop arming the Ctrl+C escape hatch. Fed by a
	 * dedicated client callback rather than a generic engine-message subscriber,
	 * which would consume buffered startup custom-UI messages.
	 */
	noteEngineHeartbeat(): void {
		this.health.clearUnresponsive();
	}
	/** True only when the engine is provably not answering (see EngineHealthController). */
	needsExplicitTermination(): boolean {
		return this.health.needsExplicitTermination();
	}
	/** Explicit user-driven engine termination and recovery (Ctrl+C escape hatch). */
	terminateAndRecover(): Promise<void> {
		return this.health.terminate();
	}
	getResourceOverlaps(): readonly ResourceOverlap[] {
		return this.resourceOverlaps;
	}
	getResourceExtensions(): readonly RpcResourceExtension[] {
		return this.resourceExtensions;
	}
	onResourceExtensionsChanged(listener: ResourceExtensionsListener): () => void {
		this.resourceExtensionsListeners.push(listener);
		return () => {
			const index = this.resourceExtensionsListeners.indexOf(listener);
			if (index !== -1) this.resourceExtensionsListeners.splice(index, 1);
		};
	}
	/** The engine's extension load errors and warnings of its last (re)load, as its session's resource loader holds them. */
	getResourceIssues(): EngineResourceIssues {
		return this.resourceIssues;
	}
	async getStartupLegacyWorkflowFileCount(): Promise<number> {
		await this.waitUntilResourcesReady();
		return this.legacyWorkflowFileCount;
	}
	private updateResources(
		state: Pick<
			RpcSessionState,
			"resourceExtensions" | "resourceErrors" | "resourceWarnings" | "legacyWorkflowFileCount"
		>,
		forNextView = false,
	): void {
		this.legacyWorkflowFileCount = state.legacyWorkflowFileCount ?? 0;
		this.resourceIssues = { errors: state.resourceErrors ?? [], warnings: state.resourceWarnings ?? [] };
		this.resourceExtensions = [...(state.resourceExtensions ?? [])];
		for (const listener of [...this.resourceExtensionsListeners]) {
			if (forNextView) listener(this.resourceExtensions, true);
			else listener(this.resourceExtensions);
		}
	}
	async synchronize(): Promise<void> {
		const generation = this.client.getGeneration();
		const state = await this.getEngineState();
		if (!this.isCurrentResourceGeneration(generation)) return;
		this.remoteSessionFile = state.sessionLocation;
		this.remoteSessionName = state.sessionName;
		this.resourceOverlaps = state.resourceOverlaps ?? [];
		this.updateResources(state, this.restrictedStartupCatalogs.has(super.session));
	}

	setEngineCallbackActive(active: boolean): void {
		this.engineCallbackActive = active;
	}

	interruptBlockedCallback(): boolean {
		if (!this.engineCallbackActive) return false;
		this.dispatchBestEffort("interrupt", this.session.abort());
		return true;
	}

	setExtensionUIHandler(
		handler: (request: RpcExtensionUIRequest) => Promise<RpcExtensionUIResponse | undefined>,
	): () => void {
		return this.client.onExtensionUIRequest((request) => {
			void handler(request)
				.then(async (response) => {
					if (response) await this.client.respondExtensionUI(response);
				})
				.catch((error: Error) => {
					this.emitDiagnostic({
						activity: undefined,
						elapsedMs: 0,
						level: "unresponsive",
						message: `Interactive engine UI bridge failed: ${error.message}`,
					});
				});
		});
	}

	emitDiagnostic(diagnostic: ActivityWatchdogDiagnostic): void {
		if (diagnostic.source !== "stderr") this.engineCallbackActive = true;
		this.health.publish(diagnostic);
	}

	/**
	 * Extension UI belongs to the engine's sessions, not to this host's mirror session. The mirror is torn
	 * down only after the engine has already switched and the new session's `session_start` has set its UI
	 * (see `switchSession`), so a reset tied to that teardown would clear the new session's UI. The reset
	 * therefore follows the engine's own lifecycle: `engine_extension_ui_reset` arrives on the same stream,
	 * ahead of the new session's UI requests. Quitting still resets here, as it always has.
	 */
	override setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.hostExtensionUIReset = beforeSessionInvalidate;
		super.setBeforeSessionInvalidate(
			beforeSessionInvalidate &&
				(() => {
					if (this.disposed) beforeSessionInvalidate();
				}),
		);
	}

	override async switchSession(
		sessionId: string,
		options?: Parameters<AgentSessionRuntime["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		const result = await this.client.switchSession(sessionId, options?.cwdOverride, options?.sessionDirectory);
		if (!result.cancelled) {
			this.queueResumeNotices(result.notices ?? []);
			await super.switchSession(sessionId, {
				cwdOverride: options?.cwdOverride,
				sessionDirectory: options?.sessionDirectory,
				history: options?.history ?? "full",
			});
			await this.initializeFromEngine();
			if (options?.withSession) await options.withSession(this.session.createReplacedSessionContext());
		}
		return { cancelled: result.cancelled };
	}

	override async newSession(options?: { parentSession?: string }): Promise<{ cancelled: boolean }> {
		const result = await this.client.newSession(options?.parentSession);
		if (result.cancelled) return result;
		const state = await this.getEngineState();
		if (super.session.sessionManager.isPersisted())
			await super.switchSession(state.sessionId, {
				sessionDirectory: state.sessionLocation ? dirname(state.sessionLocation) : undefined,
				history: "tail",
			});
		else await this.resetUnpersistedSessionView();
		await this.initializeFromEngine();
		return result;
	}

	override async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const result = await this.client.requestInternal<{ cancelled: boolean; notices?: readonly RpcResumeNotice[] }>({
			type: "import_session",
			inputPath,
			cwdOverride,
		});
		if (result.cancelled) return { cancelled: true };
		this.queueResumeNotices(result.notices ?? []);
		const state = await this.getEngineState();
		if (super.session.sessionManager.isPersisted())
			await super.switchSession(state.sessionId, {
				cwdOverride,
				sessionDirectory: state.sessionLocation ? dirname(state.sessionLocation) : undefined,
				history: "tail",
			});
		await this.initializeFromEngine();
		return { cancelled: false };
	}

	override async fork(
		entryId: string,
		options?: { position?: "before" | "at" },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		let selectedText: string | undefined;
		let cancelled: boolean;
		if (options?.position === "at") {
			cancelled = (await this.client.clone()).cancelled;
		} else {
			const result = await this.client.fork(entryId);
			cancelled = result.cancelled;
			selectedText = result.text;
		}
		if (cancelled) return { cancelled: true };
		const state = await this.getEngineState();
		if (super.session.sessionManager.isPersisted())
			await super.switchSession(state.sessionId, {
				sessionDirectory: state.sessionLocation ? dirname(state.sessionLocation) : undefined,
				history: "tail",
			});
		await this.initializeFromEngine();
		return { cancelled: false, selectedText };
	}

	/**
	 * The child engine already settled (and persisted) its own turn before it
	 * reported the replacement, and the host facade's `abort()` is `abortAndRecover()`
	 * — an unbounded cooperative round trip. Re-entering it during teardown would
	 * hang session replacement on an unresponsive or dead engine, which is exactly
	 * what engine recovery exists to survive.
	 */
	protected override async settleActiveResponseBeforeTeardown(): Promise<void> {}

	override dispose(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		this.stopSharingDebugSetting();
		this.disposePromise = (async () => {
			// A quit the user asked for must reach the engine before it is stopped: the stop
			// is a SIGTERM, which the engine cannot tell from this process being signalled.
			// Optional like the other transport surfaces focused test doubles omit.
			const unrecordedQuit = !options?.fromSignal && (await this.client.announceExplicitQuit?.()) === false;
			// EngineHealthController owns the first client stop and joins recovery.
			await this.health.shutdown();
			// A replacement may have spawned while shutdown joined recovery; the
			// idempotent trailing stop closes that child before disposal returns.
			await this.client.stop();
			if (unrecordedQuit) {
				// No engine child recorded the quit, so none released Herdr's registration, and a replacement started
				// during recovery may have registered again. Every child is stopped now; this host loads no Herdr reporter.
				const herdr = captureHerdrEnvironment(process.env);
				if (herdr) await releaseUnownedPaneRegistration(herdr);
			}
			await super.dispose(options);
		})();
		return this.disposePromise;
	}

	private patchSession(session: AgentSession): void {
		if (this.patchedSessions.has(session)) return;
		this.patchedSessions.add(session);
		this.patchSessionManager(session.sessionManager);
		this.patchSettingsManager(session.settingsManager);
		this.sessionStats.track(session);
		// Optional because focused runtime test doubles stand in for a session without extension bindings.
		const bindExtensions = session.bindExtensions?.bind(session);
		Object.defineProperties(session, {
			...(bindExtensions && {
				bindExtensions: {
					configurable: true,
					value: async (bindings: ExtensionBindings) => {
						await bindExtensions(bindings);
						if (!bindings.onError) return;
						this.errorReportingSessions.add(session);
						for (const error of this.heldExtensionErrors.splice(0)) session.extensionRunner.emitError(error);
					},
				},
			}),
			isStreaming: { configurable: true, get: () => this.streaming },
			retryStatus: { configurable: true, get: () => this.retryStatus },
			turnStartedAt: { configurable: true, get: () => this.turnStartedAt },
			isCompacting: { configurable: true, get: () => this.compacting },
			compactionReason: { configurable: true, get: () => this.compactionReason },
			compactionStartedAt: { configurable: true, get: () => this.compactionStartedAt },
			isBashRunning: { configurable: true, get: () => this.activeBashRequestIds.size > 0 },
			isRetrying: { configurable: true, get: () => this.retrying || this.retryStatus !== undefined },
			sessionName: { configurable: true, get: () => this.remoteSessionName },
			sessionFile: { configurable: true, get: () => this.remoteSessionFile },
			autoCompactionEnabled: { configurable: true, get: () => this.autoCompactionEnabled },
			autoRetryEnabled: { configurable: true, get: () => this.autoRetryEnabled },
			queuedMessagesPaused: { configurable: true, get: () => this.queuePause.isPaused },
			subscribe: {
				configurable: true,
				value: (listener: (event: JsonAgentSessionEvent) => void) => this.client.onEvent(listener),
			},
			prompt: {
				configurable: true,
				value: async (text: string, options?: PromptOptions) => {
					const cancellationEpoch = this.promptCancellationEpoch;
					await this.waitUntilResourcesReady();
					if (cancellationEpoch !== this.promptCancellationEpoch) return;
					let disposition: PromptDisposition;
					try {
						disposition = await this.client.prompt(text, options?.images, options?.streamingBehavior);
					} catch (error) {
						if (!isRpcRequestAcceptedFailure(error)) options?.preflightResult?.(false);
						throw error;
					}
					options?.preflightResult?.(true, disposition);
				},
			},
			steer: { configurable: true, value: (text: string) => this.client.steer(text) },
			followUp: { configurable: true, value: (text: string) => this.client.followUp(text) },
			abort: { configurable: true, value: () => this.abortAndRecover() },
			executeBash: {
				configurable: true,
				value: async (
					command: string,
					onChunk?: Parameters<AgentSession["executeBash"]>[1],
					options?: Parameters<AgentSession["executeBash"]>[2],
				) => {
					const key = options?.id ?? Symbol("isolated-bash-request");
					try {
						return await this.client.userBashWithUpdates(command, (delta, channel) => onChunk?.(delta, channel), {
							excludeFromContext: options?.excludeFromContext,
							onRequestId: (requestId) => this.activeBashRequestIds.set(key, requestId),
						});
					} finally {
						this.activeBashRequestIds.delete(key);
					}
				},
			},
			recordBashResult: { configurable: true, value: () => {} },
			abortBash: {
				configurable: true,
				value: (id?: string) => {
					const requestId = id === undefined ? undefined : this.activeBashRequestIds.get(id);
					if (id !== undefined && !requestId) return;
					this.dispatchBestEffort(
						"abort bash",
						this.health.trackControlRequest(() => this.client.abortBash(requestId)),
					);
				},
			},
			compact: {
				configurable: true,
				value: (options?: { query?: string }) => this.client.compact(options?.query),
			},
			abortCompaction: {
				configurable: true,
				value: () =>
					this.dispatchBestEffort(
						"abort compaction",
						this.health.trackControlRequest(() =>
							this.client.requestInternal<void>({ type: "abort_compaction" }),
						),
					),
			},
			abortRetry: {
				configurable: true,
				value: () =>
					this.dispatchBestEffort(
						"abort retry",
						this.health.trackControlRequest(async () => {
							const retry = this.client.abortRetry?.();
							if (retry !== undefined) {
								await retry;
								return;
							}
							if (typeof this.client.requestInternal === "function") {
								await this.client.requestInternal<void>({ type: "abort_retry" });
							}
						}),
					),
			},
			navigateTree: {
				configurable: true,
				value: async (targetId: string, options?: Parameters<AgentSession["navigateTree"]>[1]) => {
					const result = await this.client.requestInternal<Awaited<ReturnType<AgentSession["navigateTree"]>>>({
						type: "navigate_tree",
						targetId,
						options,
					});
					if (!result.cancelled && !result.aborted) {
						// The engine moved its leaf. The chat, the tree cursor and `/clone` read the host's view (#3325).
						await this.refreshSessionView();
						this.sessionStats.reset();
						this.sessionStats.refresh();
					}
					return result;
				},
			},
			abortBranchSummary: {
				configurable: true,
				value: () =>
					this.dispatchBestEffort(
						"abort branch summary",
						this.health.trackControlRequest(() =>
							this.client.requestInternal<void>({ type: "abort_branch_summary" }),
						),
					),
			},
			reload: {
				configurable: true,
				value: async () => {
					await this.client.requestInternal<void>({ type: "reload" });
					await this.initializeFromEngine();
				},
			},
			startPendingRecovery: {
				configurable: true,
				value: (reason?: SessionRecoveryReason) =>
					this.client.requestInternal<SessionRecoveryReport>({ type: "start_pending_recovery", reason }),
			},
			setSessionName: {
				configurable: true,
				value: async (name: string) => {
					return serializeSessionMutation(session, async () => {
						await this.client.setSessionName(name);
						this.remoteSessionName = name;
						await this.refreshSessionView();
					});
				},
			},
			getSteeringMessages: { configurable: true, value: () => [...this.steeringMessages] },
			getFollowUpMessages: { configurable: true, value: () => [...this.followUpMessages] },
			// The cached copy lags the engine by a round trip. A caller that restores the queue to an editor uses
			// `clearEngineQueue()`, whose result is exactly what the engine removed (#4257).
			clearQueue: {
				configurable: true,
				value: () => {
					const { snapshot, removed } = this.beginQueueClear();
					this.dispatchBestEffort("clear queue", removed);
					return snapshot;
				},
			},
			pauseQueuedMessages: { configurable: true, value: () => this.queuePause.pause() },
			resumeQueuedMessages: {
				configurable: true,
				value: (beforeRelease?: () => void) => this.queuePause.resume(beforeRelease),
			},
			setScopedModels: {
				configurable: true,
				value: (scopedModels: Array<{ model: Model<Api>; thinkingLevel?: AgentSession["thinkingLevel"] }>) => {
					const nextScopedModels = scopedModels.map((scoped) => ({
						model: scoped.model,
						...(scoped.thinkingLevel !== undefined ? { thinkingLevel: scoped.thinkingLevel } : {}),
					}));
					const enabledModelsSync = this.pendingEnabledModelsSync;
					this.pendingEnabledModelsSync = undefined;
					(session as unknown as { _scopedModels: typeof nextScopedModels })._scopedModels = nextScopedModels;
					this.dispatchBestEffort(
						"set scoped models",
						this.remoteModelCatalog.syncScopedModels(nextScopedModels, () =>
							serializeSessionMutation(session, async () => {
								await this.settleEngineResync();
								const deferredEnabledModels = enabledModelsSync ?? this.pendingEnabledModelsSync;
								if (enabledModelsSync === undefined) this.pendingEnabledModelsSync = undefined;
								return this.client.requestInternal<RpcModelCatalog>({
									type: "set_scoped_models",
									models: nextScopedModels.map((scoped) => ({
										provider: scoped.model.provider,
										modelId: scoped.model.id,
										...(scoped.thinkingLevel !== undefined ? { thinkingLevel: scoped.thinkingLevel } : {}),
									})),
									...(deferredEnabledModels !== undefined
										? { enabledModels: deferredEnabledModels.patterns }
										: {}),
								});
							}),
						),
					);
				},
			},
			setModel: {
				configurable: true,
				value: async (
					model: Model<Api>,
					options?: ModelMutationOptions & { thinkingLevel?: AgentSession["thinkingLevel"] },
				) => {
					return serializeSessionMutation(session, async () => {
						await this.settleEngineResync();
						const modelEpoch = this.modelEpoch;
						const selected = await this.client.setModel(model.provider, model.id, options);
						const nextModel = session.modelRuntime.getModel(selected.provider, selected.id) ?? model;
						if (modelEpoch === this.modelEpoch) session.agent.state.model = nextModel;
						this.resolveModelFallback();
						const epoch = ++this.thinkingEpoch;
						const state =
							options?.persist === true
								? await this.syncPersistedModelCatalog(session, nextModel, selected.persistedDefaults)
								: await this.getEngineState();
						this.applyThinkingAck(session, epoch, { level: state.thinkingLevel }, false);
					});
				},
			},
			setThinkingLevel: {
				configurable: true,
				value: async (level: AgentSession["thinkingLevel"], options?: ModelMutationOptions) => {
					return serializeSessionMutation(session, async () => {
						if (this.initializationTail) await this.settleEngineResync();
						const epoch = ++this.thinkingEpoch;
						const result = await this.client.setThinkingLevelAck(level, options);
						this.applyThinkingAck(session, epoch, result, options?.persist === true);
					});
				},
			},
			cycleModel: {
				configurable: true,
				value: async (direction?: "forward" | "backward", options?: ModelMutationOptions) => {
					return serializeSessionMutation(session, async () => {
						await this.settleEngineResync();
						const previousModel = session.model;
						const modelEpoch = this.modelEpoch;
						const result = await this.client.cycleModel(direction, options);
						if (!result) return undefined;
						const model = session.modelRuntime.getModel(result.model.provider, result.model.id) ?? result.model;
						if (modelEpoch === this.modelEpoch) session.agent.state.model = model;
						this.resolveModelFallbackAfterExplicitModelSelection(previousModel, model);
						const epoch = ++this.thinkingEpoch;
						const state =
							options?.persist === true
								? await this.syncPersistedModelCatalog(session, model, result.persistedDefaults)
								: await this.getEngineState();
						this.applyThinkingAck(session, epoch, { level: state.thinkingLevel }, false);
						return { model, thinkingLevel: result.thinkingLevel, isScoped: result.isScoped };
					});
				},
			},
			cycleThinkingLevel: {
				configurable: true,
				value: async (options?: ModelMutationOptions) => {
					return serializeSessionMutation(session, async () => {
						if (this.initializationTail) await this.settleEngineResync();
						const levels = session.getAvailableThinkingLevels();
						if (levels.length <= 1) return undefined;
						const current = levels.indexOf(session.thinkingLevel);
						const level = levels[(current + 1) % levels.length]!;
						const epoch = ++this.thinkingEpoch;
						const result = await this.client.setThinkingLevelAck(level, options);
						this.applyThinkingAck(session, epoch, result, options?.persist === true);
						return result.level;
					});
				},
			},
			setSteeringMode: {
				configurable: true,
				value: (mode: "all" | "one-at-a-time") => {
					session.agent.steeringMode = mode;
					this.dispatchBestEffort("set steering mode", this.client.setSteeringMode(mode));
				},
			},
			setFollowUpMode: {
				configurable: true,
				value: (mode: "all" | "one-at-a-time") => {
					session.agent.followUpMode = mode;
					this.dispatchBestEffort("set follow-up mode", this.client.setFollowUpMode(mode));
				},
			},
			setAutoCompactionEnabled: {
				configurable: true,
				value: (enabled: boolean) => {
					this.autoCompactionEnabled = enabled;
					this.dispatchBestEffort("set auto compaction", this.client.setAutoCompaction(enabled));
				},
			},
			setAutoRetryEnabled: {
				configurable: true,
				value: (enabled: boolean) => {
					this.autoRetryEnabled = enabled;
					this.dispatchBestEffort("set auto retry", this.client.setAutoRetry(enabled));
				},
			},
		});
	}

	/**
	 * Cooperative interrupt. Requests the engine's own abort and waits for it —
	 * no timeout, no termination, no restart. A genuinely wedged engine is the
	 * user's call to terminate with Ctrl+C (see terminateAndRecover), never an
	 * automatic consequence of pressing Escape.
	 */
	private async abortAndRecover(): Promise<void> {
		this.promptCancellationEpoch += 1;
		this.health.markCooperativeAbortStarted();
		try {
			await this.health.trackControlRequest(async () => {
				await this.queuePause.settleBeforeAbort();
				await this.client.abort();
			});
			this.health.markCooperativeAbortSettled();
		} finally {
			this.engineCallbackActive = false;
		}
	}

	private applyThinkingAck(
		session: AgentSession,
		epoch: number,
		result: { level: AgentSession["thinkingLevel"]; provider?: string; modelId?: string },
		persist: boolean,
	): void {
		if (persist) {
			applyPersistedThinkingDefault(session, result.level, thinkingPersistTarget(result));
		}
		if (epoch === this.thinkingEpoch) {
			session.agent.state.thinkingLevel = result.level;
		}
	}

	private dispatchBestEffort(label: string, operation: Promise<unknown>): void {
		void operation.catch((error: Error) => {
			if (this.health.isRecovering()) return;
			this.emitDiagnostic({
				activity: undefined,
				elapsedMs: 0,
				level: "unresponsive",
				message: `Interactive engine ${label} failed: ${error.message}`,
			});
		});
	}

	/**
	 * Remove the engine's queued messages and return exactly what it removed, steering then follow-up, each in queue
	 * order. This includes a message the engine queued after the `queue_update` the host last saw, which the cached
	 * copy cannot know about, and leaves out one the engine has already taken into a turn (#4257).
	 *
	 * The cached copy empties at once and is restored if the clear fails before any newer `queue_update`.
	 */
	clearEngineQueue(): Promise<ClearedQueue> {
		const { removed } = this.beginQueueClear();
		return removed;
	}

	/** Empty the cached queue and ask the engine to clear its own, answering with the engine's removed messages. */
	private beginQueueClear(): { snapshot: QueueSnapshot; removed: Promise<ClearedQueue> } {
		const snapshot: QueueSnapshot = {
			steering: [...this.steeringMessages],
			followUp: [...this.followUpMessages],
		};
		const pendingClear = this.pendingQueueClear ?? {
			snapshot,
			queueUpdateGeneration: this.queueUpdateGeneration,
			count: 0,
			succeeded: false,
		};
		this.pendingQueueClear = pendingClear;
		pendingClear.count += 1;
		this.steeringMessages = [];
		this.followUpMessages = [];
		const removed = this.health
			.trackControlRequest(() => this.client.requestInternal<ClearedQueue>({ type: "clear_queue" }))
			.then(
				(engineRemoved) => {
					this.settleQueueClear(pendingClear, true);
					return engineRemoved;
				},
				(error: Error) => {
					this.settleQueueClear(pendingClear, false);
					throw error;
				},
			);
		return { snapshot, removed };
	}

	private settleQueueClear(pendingClear: PendingQueueClear, succeeded: boolean): void {
		if (this.pendingQueueClear !== pendingClear) return;

		pendingClear.count -= 1;
		pendingClear.succeeded ||= succeeded;
		if (pendingClear.count > 0) return;

		this.pendingQueueClear = undefined;
		if (pendingClear.succeeded || this.queueUpdateGeneration !== pendingClear.queueUpdateGeneration) return;

		this.steeringMessages = [...pendingClear.snapshot.steering];
		this.followUpMessages = [...pendingClear.snapshot.followUp];
	}

	private async resetUnpersistedSessionView(): Promise<void> {
		const session = super.session;
		const manager = await SessionManager.create(
			session.sessionManager.getSessionStore(),
			session.sessionManager.getCwd(),
		);
		Object.defineProperty(session, "sessionManager", { configurable: true, value: manager });
		this.patchSessionManager(manager);
		session.agent.state.messages = [];
	}

	private patchSessionManager(manager: SessionManager): void {
		Object.defineProperty(manager, "appendLabelChange", {
			configurable: true,
			value: async (entryId: string, label?: string): Promise<string> => {
				return serializeSessionMutation(super.session, async () => {
					const receipt = await this.client.requestInternal<{ entryId: string }>({
						type: "set_label",
						entryId,
						label,
					});
					await this.refreshSessionView();
					return receipt.entryId;
				});
			},
		});
	}

	private patchSettingsManager(settingsManager: AgentSession["settingsManager"]): void {
		if (this.patchedSettingsManagers.has(settingsManager)) return;
		this.patchedSettingsManagers.add(settingsManager);
		const setEnabledModels = settingsManager.setEnabledModels.bind(settingsManager);
		Object.defineProperty(settingsManager, "setEnabledModels", {
			configurable: true,
			value: (patterns: string[] | undefined) => {
				setEnabledModels(patterns);
				if (!this.mirroringPersistedModelDefault) {
					this.pendingEnabledModelsSync = { patterns: patterns ? [...patterns] : null };
				}
			},
		});
	}

	private async syncPersistedModelCatalog(
		session: AgentSession,
		model: Model<Api>,
		persistedDefaults?: RpcPersistedModelDefaults,
	): Promise<RpcSessionState> {
		const persistedModel = persistedDefaults
			? { provider: persistedDefaults.provider, id: persistedDefaults.modelId }
			: model;
		const alreadyInScope = session.scopedModels.some(
			(scoped) => scoped.model.provider === persistedModel.provider && scoped.model.id === persistedModel.id,
		);
		const scope = this.remoteModelCatalog.getScopeSnapshot();
		const catalog = await this.client.requestInternal<RpcModelCatalog>({ type: "get_available_models" });
		this.remoteModelCatalog.apply(catalog, scope);
		this.mirroringPersistedModelDefault = true;
		try {
			applyPersistedModelDefault(session, persistedModel, alreadyInScope);
		} finally {
			this.mirroringPersistedModelDefault = false;
		}
		const state = await this.getEngineState();
		if (persistedDefaults !== undefined) {
			session.settingsManager.setModelThinkingLevel(
				persistedDefaults.provider,
				persistedDefaults.modelId,
				persistedDefaults.thinkingLevel,
			);
			session.settingsManager.setDefaultThinkingLevel(persistedDefaults.defaultThinkingLevel);
		} else if (state.model?.provider === model.provider && state.model.id === model.id) {
			applyPersistedThinkingDefault(session, state.thinkingLevel, { provider: model.provider, modelId: model.id });
		}
		return state;
	}

	private async refreshSessionView(): Promise<void> {
		const session = super.session;
		const currentManager = session.sessionManager;
		const unchanged =
			currentManager.isPersisted() &&
			typeof currentManager.refreshFromStore === "function" &&
			(await currentManager.refreshFromStore());
		const refreshed = unchanged
			? currentManager
			: currentManager.isPersisted()
				? await SessionManager.open(
						currentManager.getSessionStore(),
						currentManager.getSessionId(),
						currentManager.getCwd(),
						{ history: "tail" },
					)
				: await this.openUnpersistedSessionView(currentManager);
		Object.defineProperty(session, "sessionManager", { configurable: true, value: refreshed });
		this.patchSessionManager(refreshed);
		session.agent.state.messages = refreshed.buildSessionContext().messages;
	}

	/**
	 * A saved session's entries reach the host through the store it shares with the engine. An unsaved one exists only
	 * in the engine's memory, so its view is rebuilt from the engine's entries and leaf, under the engine's session id
	 * (#4703).
	 */
	private async openUnpersistedSessionView(current: SessionManager): Promise<SessionManager> {
		const { entries, leafId } = await this.client.getEntries();
		const header = current.getHeader();
		const view = SessionManager.inMemory(
			current.getCwd(),
			undefined,
			header ? [{ ...header, id: this.remoteSessionId ?? header.id }, ...entries] : entries,
		);
		if (leafId === null) await view.resetLeaf();
		else if (leafId !== view.getLeafId()) await view.branch(leafId);
		return view;
	}

	private observeEvent(event: RpcEvent): void {
		const session = super.session;
		// The engine reports its session's extension errors on this stream. They are this host session's errors, and
		// its error listeners show them; a message the engine could not save is reported only this way (#4226).
		const record: unknown = event;
		if (isEngineExtensionError(record)) {
			// A load failure is part of the engine's resource state, which the host shows with its resource diagnostics.
			if (isExtensionLoadError(record)) return;
			const error = {
				extensionPath: record.extensionPath,
				event: record.event,
				error: record.error,
				...(typeof record.stack === "string" && { stack: record.stack }),
			};
			// An engine that loads its resources eagerly starts its extensions while this host is still starting up.
			if (this.errorReportingSessions.has(session)) session.extensionRunner.emitError(error);
			else this.heldExtensionErrors.push(error);
			return;
		}
		const status = retryStatusUpdate(event);
		if (status !== undefined) {
			this.retryStatus = status ?? undefined;
			this.retryStatusEpoch++;
		}
		switch (event.type) {
			case "agent_start":
				this.turnStartedAt = event.turnStartedAt;
				this.streamingEpoch++;
				this.streaming = true;
				break;
			case "agent_end":
				this.streamingEpoch++;
				this.streaming = false;
				this.retrying = event.retryPending === true;
				this.dispatchBestEffort("refresh session view", this.refreshSessionView());
				break;
			case "agent_settled":
				this.streamingEpoch++;
				this.retrying = false;
				this.turnStartedAt = undefined;
				break;
			case "compaction_start":
				this.compacting = true;
				this.compactionReason = event.reason;
				this.compactionStartedAt = Date.now();
				break;
			case "compaction_end":
				this.compacting = false;
				this.compactionReason = undefined;
				this.compactionStartedAt = undefined;
				if (!event.aborted && event.errorMessage === undefined) this.sessionStats.refresh();
				break;
			case "auto_retry_start":
			case "model_fallback_start":
				this.retrying = true;
				break;
			case "auto_retry_end":
			case "model_fallback_end":
				this.retrying = false;
				break;
			case "message_end":
			// An appended entry can carry usage of its own, as a session summary or a cache warm does (#4726).
			case "entry_appended":
				this.sessionStats.refresh();
				break;
			case "queue_update":
				this.queueUpdateGeneration += 1;
				this.pendingQueueClear = undefined;
				this.steeringMessages = [...event.steering];
				this.followUpMessages = [...event.followUp];
				break;
			case "model_changed":
				this.modelEpoch += 1;
				session.agent.state.model = event.model;
				this.sessionStats.refresh();
				break;
			case "thinking_level_changed":
				this.thinkingEpoch += 1;
				session.agent.state.thinkingLevel = event.level;
				break;
			case "session_info_changed":
				this.remoteSessionName = event.name;
				break;
		}
	}
}
