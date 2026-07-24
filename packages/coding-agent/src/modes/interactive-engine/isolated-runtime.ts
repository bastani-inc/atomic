import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../../core/agent-session-runtime.ts";
import type { PromptOptions } from "../../core/agent-session-types.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type { ResourceOverlap } from "../../core/diagnostics.ts";
import type { RpcClient } from "../rpc/rpc-client.ts";
import type { RpcAutocompleteItem, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcModelCatalog, RpcEvent, RpcSlashCommand } from "../rpc/rpc-types.ts";
import type { ActivityWatchdogDiagnostic } from "./activity-watchdog.ts";
import type { EngineKeybindingState, InteractiveEngineCommand, InteractiveEngineMessage } from "./protocol.ts";
import { RemoteCommandCatalog, type RemoteCommandsListener } from "./remote-command-catalog.ts";
import { RemoteModelCatalog } from "./remote-model-catalog.ts";
import { RemoteQueuePause } from "./remote-queue-pause.js";
import { sleep } from "../../utils/sleep.ts";

export class IsolatedInteractiveRuntime extends AgentSessionRuntime {
	private readonly client: RpcClient;
	private readonly patchedSessions = new WeakSet<AgentSession>();
	private streaming = false;
	private compacting = false;
	private bashRunning = false;
	private steeringMessages: string[] = [];
	private followUpMessages: string[] = [];
	private engineCallbackActive = false;
	private readonly queuePause: RemoteQueuePause;
	private readonly diagnosticListeners = new Set<(diagnostic: ActivityWatchdogDiagnostic) => void>();
	private pendingDiagnostics: ActivityWatchdogDiagnostic[] = [];
	private lastDiagnostic: ActivityWatchdogDiagnostic | undefined;
	private autoCompactionEnabled = true;
	private autoRetryEnabled = true;
	private remoteSessionName: string | undefined;
	private remoteSessionFile: string | undefined;
	private restartPromise: Promise<void> | undefined;
	private readonly remoteCommands: RemoteCommandCatalog;
	private readonly remoteModelCatalog: RemoteModelCatalog;
	private resourceOverlaps: ResourceOverlap[] = [];

	constructor(
		localRuntime: AgentSessionRuntime,
		createRuntime: CreateAgentSessionRuntimeFactory,
		client: RpcClient,
	) {
		super(
			localRuntime.session,
			localRuntime.services,
			createRuntime,
			[...localRuntime.diagnostics],
			localRuntime.modelFallbackMessage,
		);
		this.client = client;
		this.remoteCommands = new RemoteCommandCatalog(client);
		this.remoteModelCatalog = new RemoteModelCatalog(client);
		this.queuePause = new RemoteQueuePause(client);
		this.client.onEvent((event) => this.observeEvent(event));
	}

	override get session(): AgentSession {
		const session = super.session;
		this.patchSession(session);
		return session;
	}
	async initializeFromEngine(): Promise<void> {
		const state = await this.client.getState();
		const session = super.session;
		const catalog = await this.client.requestInternal<RpcModelCatalog>({ type: "get_available_models" });
		this.remoteModelCatalog.apply(catalog);
		this.remoteModelCatalog.patch(session);
		if (state.model) session.agent.state.model = state.model;
		session.agent.state.thinkingLevel = state.thinkingLevel;
		session.agent.steeringMode = state.steeringMode;
		session.agent.followUpMode = state.followUpMode;
		this.autoCompactionEnabled = state.autoCompactionEnabled;
		this.resourceOverlaps = state.resourceOverlaps ?? [];
		this.remoteSessionName = state.sessionName;
		this.remoteSessionFile = state.sessionFile;
		this.streaming = state.isStreaming;
		this.compacting = state.isCompacting;
		this.queuePause.synchronize(state.queuedMessagesPaused === true);
		if (state.sessionFile && session.sessionFile !== state.sessionFile) await super.switchSession(state.sessionFile);
		this.refreshSessionView();
		this.engineCallbackActive = false;
		// Non-blocking refresh so isolated autocomplete lists engine-only extension
		// commands after bind/restart/reload/new/resume/fork. See RemoteCommandCatalog.
		this.remoteCommands.refresh();
	}

	override async logoutProvider(provider: string) {
		const result = await this.client.logoutProvider(provider);
		this.remoteModelCatalog.applyModels({ models: result.models, scopedModels: result.scopedModels ?? [] });
		await super.session.modelRegistry.authStorage.logoutAsync(provider);
		return result;
	}

	onDiagnostic(listener: (diagnostic: ActivityWatchdogDiagnostic) => void): () => void {
		for (const diagnostic of this.pendingDiagnostics.splice(0)) listener(diagnostic);
		this.diagnosticListeners.add(listener);
		return () => this.diagnosticListeners.delete(listener);
	}

	onEngineMessage(listener: (message: InteractiveEngineMessage) => void): () => void {
		return this.client.onInteractiveEngineMessage(listener);
	}
	onKeybindingState(listener: (state: EngineKeybindingState) => void): () => void {
		return this.client.onInteractiveEngineKeybindingState(listener);
	}

	sendEngineCommand(command: InteractiveEngineCommand): void {
		this.client.sendInteractiveEngineCommand(command);
	}

	getRemoteCommands(): readonly RpcSlashCommand[] { return this.remoteCommands.getCommands(); }
	onRemoteCommandsChanged(listener: RemoteCommandsListener): () => void { return this.remoteCommands.onChange(listener); }
	getRemoteCommandCompletions(commandName: string, argumentPrefix: string): Promise<RpcAutocompleteItem[] | null> {
		return this.client.getCommandCompletions(commandName, argumentPrefix);
	}


	async invokeRemoteShortcut(key: string): Promise<void> {
		await this.client.requestInternal<void>({ type: "invoke_shortcut", key });
	}

	waitUntilBound(): Promise<void> { return this.client.waitForInteractiveEngineBound(); }
	getEnginePid(): number | undefined { return this.client.getEnginePid(); }
	getEngineGeneration(): number { return this.client.getGeneration(); }
	isRecovering(): boolean { return this.restartPromise !== undefined; }
	getResourceOverlaps(): readonly ResourceOverlap[] { return this.resourceOverlaps; }
	async synchronize(): Promise<void> {
		const state = await this.client.getState();
		this.remoteSessionFile = state.sessionFile;
		this.remoteSessionName = state.sessionName;
		this.resourceOverlaps = state.resourceOverlaps ?? [];
	}

	setEngineCallbackActive(active: boolean): void { this.engineCallbackActive = active; }

	interruptBlockedCallback(): boolean {
		if (!this.engineCallbackActive) return false;
		this.dispatchBestEffort("interrupt", this.session.abort());
		return true;
	}

	setExtensionUIHandler(
		handler: (request: RpcExtensionUIRequest) => Promise<RpcExtensionUIResponse | undefined>,
	): () => void {
		return this.client.onExtensionUIRequest((request) => {
			void handler(request).then(async (response) => {
				if (response) await this.client.respondExtensionUI(response);
			}).catch((error: Error) => {
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
		this.lastDiagnostic = diagnostic;
		this.engineCallbackActive = true;
		if (this.diagnosticListeners.size === 0) this.pendingDiagnostics.push(diagnostic);
		for (const listener of this.diagnosticListeners) listener(diagnostic);
	}

	override async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const result = await this.client.switchSession(sessionPath);
		if (!result.cancelled) {
			await super.switchSession(sessionPath);
			await this.initializeFromEngine();
		}
		return result;
	}

	override async newSession(options?: { parentSession?: string }): Promise<{ cancelled: boolean }> {
		const result = await this.client.newSession(options?.parentSession);
		if (result.cancelled) return result;
		const state = await this.client.getState();
		if (state.sessionFile) await super.switchSession(state.sessionFile);
		else this.resetUnpersistedSessionView();
		await this.initializeFromEngine();
		return result;
	}

	override async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const result = await this.client.requestInternal<{ cancelled: boolean }>({
			type: "import_session", inputPath, cwdOverride,
		});
		if (result.cancelled) return result;
		const state = await this.client.getState();
		if (state.sessionFile) await super.switchSession(state.sessionFile);
		await this.initializeFromEngine();
		return result;
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
		const state = await this.client.getState();
		if (state.sessionFile) await super.switchSession(state.sessionFile);
		await this.initializeFromEngine();
		return { cancelled: false, selectedText };
	}

	override async dispose(): Promise<void> {
		await this.client.stop();
		await super.dispose();
	}

	private patchSession(session: AgentSession): void {
		if (this.patchedSessions.has(session)) return;
		this.patchedSessions.add(session);
		this.patchSessionManager(session.sessionManager);
		Object.defineProperties(session, {
			isStreaming: { configurable: true, get: () => this.streaming },
			isCompacting: { configurable: true, get: () => this.compacting },
			isBashRunning: { configurable: true, get: () => this.bashRunning },
			sessionName: { configurable: true, get: () => this.remoteSessionName },
			sessionFile: { configurable: true, get: () => this.remoteSessionFile },
			autoCompactionEnabled: { configurable: true, get: () => this.autoCompactionEnabled },
			autoRetryEnabled: { configurable: true, get: () => this.autoRetryEnabled },
			queuedMessagesPaused: { configurable: true, get: () => this.queuePause.isPaused },
			subscribe: {
				configurable: true,
				value: (listener: (event: AgentSessionEvent) => void) => this.client.onEvent(listener),
			},
			prompt: {
				configurable: true,
				value: async (text: string, options?: PromptOptions) => {
					await this.client.prompt(text, options?.images, options?.streamingBehavior);
					options?.preflightResult?.(true);
				},
			},
			steer: { configurable: true, value: (text: string) => this.client.steer(text) },
			followUp: { configurable: true, value: (text: string) => this.client.followUp(text) },
			abort: { configurable: true, value: () => this.abortAndRecover() },
			executeBash: {
				configurable: true,
				value: async (
					command: string,
					onChunk?: (chunk: string) => void,
					options?: { excludeFromContext?: boolean },
				) => {
					this.bashRunning = true;
					try {
						const result = await this.client.requestInternal<Awaited<ReturnType<AgentSession["executeBash"]>>>({
							type: "user_bash", command, excludeFromContext: options?.excludeFromContext,
						});
						if (result.output) onChunk?.(result.output);
						return result;
					} finally {
						this.bashRunning = false;
					}
				},
			},
			recordBashResult: { configurable: true, value: () => {} },
			abortBash: { configurable: true, value: () => this.dispatchBestEffort("abort bash", this.client.abortBash()) },
			compact: { configurable: true, value: () => this.client.compact() },
			abortCompaction: { configurable: true, value: () => this.dispatchBestEffort("abort compaction", this.client.requestInternal<void>({ type: "abort_compaction" })) },
			abortRetry: { configurable: true, value: () => this.dispatchBestEffort("abort retry", this.client.abortRetry()) },
			navigateTree: {
				configurable: true,
				value: async (targetId: string, options?: Parameters<AgentSession["navigateTree"]>[1]) =>
					this.client.requestInternal<Awaited<ReturnType<AgentSession["navigateTree"]>>>({
						type: "navigate_tree", targetId, options,
					}),
			},
			reload: {
				configurable: true,
				value: async () => {
					await this.client.requestInternal<void>({ type: "reload" });
					await this.initializeFromEngine();
				},
			},
			setSessionName: {
				configurable: true,
				value: (name: string) => {
					this.remoteSessionName = name;
					this.dispatchBestEffort("set session name", this.client.setSessionName(name).then(() => this.refreshSessionView()));
				},
			},
			getSteeringMessages: { configurable: true, value: () => [...this.steeringMessages] },
			getFollowUpMessages: { configurable: true, value: () => [...this.followUpMessages] },
			clearQueue: {
				configurable: true,
				value: () => {
					const queued = { steering: [...this.steeringMessages], followUp: [...this.followUpMessages] };
					this.steeringMessages = [];
					this.followUpMessages = [];
					this.dispatchBestEffort("clear queue", this.client.requestInternal({ type: "clear_queue" }));
					return queued;
				},
			},
			pauseQueuedMessages: { configurable: true, value: () => this.queuePause.pause() },
			resumeQueuedMessages: { configurable: true, value: () => this.queuePause.resume() },
			setModel: {
				configurable: true,
				value: async (model: Model<Api>) => {
					const selected = await this.client.setModel(model.provider, model.id);
					session.agent.state.model = session.modelRegistry.find(selected.provider, selected.id) ?? model;
				},
			},
			setThinkingLevel: {
				configurable: true,
				value: (level: AgentSession["thinkingLevel"]) => {
					session.agent.state.thinkingLevel = level;
					this.dispatchBestEffort("set thinking level", this.client.setThinkingLevel(level));
				},
			},
			cycleModel: {
				configurable: true,
				value: async (direction?: "forward" | "backward") => {
					const result = await this.client.cycleModel(direction);
					if (!result) return undefined;
					const model = session.modelRegistry.find(result.model.provider, result.model.id) ?? result.model;
					session.agent.state.model = model;
					session.agent.state.thinkingLevel = result.thinkingLevel;
					return { ...result, model };
				},
			},
			cycleThinkingLevel: {
				configurable: true,
				value: () => {
					const levels = session.getAvailableThinkingLevels();
					if (levels.length <= 1) return undefined;
					const current = levels.indexOf(session.thinkingLevel);
					const level = levels[(current + 1) % levels.length]!;
					session.agent.state.thinkingLevel = level;
					this.dispatchBestEffort("cycle thinking level", this.client.setThinkingLevel(level));
					return level;
				},
			},
			setContextWindow: {
				configurable: true,
				value: (tokens: number) => {
					if (session.agent.state.model) session.agent.state.model = { ...session.agent.state.model, contextWindow: tokens };
					this.dispatchBestEffort("set context window", this.client.setContextWindow(tokens));
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

	private async abortAndRecover(): Promise<void> {
		if (this.restartPromise) return this.restartPromise;
		await this.queuePause.settleBeforeAbort();
		const cooperativeAbort = this.client.abort().then(() => true, () => false);
		if (await Promise.race([cooperativeAbort, sleep(250).then(() => false)])) {
			this.engineCallbackActive = false;
			return;
		}
		const activity = this.lastDiagnostic?.activity;
		const label = activity ? `${activity.kind} ${activity.name}` : "engine callback";
		const diagnostic: ActivityWatchdogDiagnostic = {
			activity,
			elapsedMs: this.lastDiagnostic?.elapsedMs ?? 0,
			level: "unresponsive",
			message: `Engine terminated; ${label} result unknown; inspect side effects before retrying`,
		};
		this.streaming = false;
		this.compacting = false;
		this.engineCallbackActive = false;
		for (const listener of this.diagnosticListeners) listener(diagnostic);
		this.restartPromise = (async () => {
			await this.client.restart(this.remoteSessionFile);
			await this.initializeFromEngine();
		})().catch((error: Error) => {
			this.emitDiagnostic({ ...diagnostic, message: `${diagnostic.message}; engine restart failed: ${error.message}` });
		}).finally(() => { this.restartPromise = undefined; });
		await this.restartPromise;
	}

	private dispatchBestEffort(label: string, operation: Promise<unknown>): void {
		void operation.catch((error: Error) => {
			if (this.restartPromise) return;
			this.emitDiagnostic({
				activity: undefined,
				elapsedMs: 0,
				level: "unresponsive",
				message: `Interactive engine ${label} failed: ${error.message}`,
			});
		});
	}

	private resetUnpersistedSessionView(): void {
		const session = super.session;
		const manager = SessionManager.create(session.sessionManager.getCwd(), session.sessionManager.getSessionDir());
		Object.defineProperty(session, "sessionManager", { configurable: true, value: manager });
		this.patchSessionManager(manager);
		session.agent.state.messages = [];
	}

	private patchSessionManager(manager: SessionManager): void {
		Object.defineProperty(manager, "appendLabelChange", {
			configurable: true,
			value: (entryId: string, label?: string) => {
				this.dispatchBestEffort(
					"set label",
					this.client.requestInternal<void>({ type: "set_label", entryId, label }).then(() => this.refreshSessionView()),
				);
			},
		});
	}

	private refreshSessionView(): void {
		const session = super.session;
		const sessionFile = session.sessionFile;
		if (!sessionFile) return;
		const currentManager = session.sessionManager;
		const refreshed = SessionManager.open(sessionFile, currentManager.getSessionDir(), currentManager.getCwd());
		Object.defineProperty(session, "sessionManager", { configurable: true, value: refreshed });
		this.patchSessionManager(refreshed);
		session.agent.state.messages = refreshed.buildSessionContext().messages;
	}

	private observeEvent(event: RpcEvent): void {
		const session = super.session;
		switch (event.type) {
			case "agent_start":
				this.streaming = true;
				break;
			case "agent_end":
				this.streaming = false;
				this.refreshSessionView();
				break;
			case "compaction_start":
				this.compacting = true;
				break;
			case "compaction_end":
				this.compacting = false;
				break;
			case "queue_update":
				this.steeringMessages = [...event.steering];
				this.followUpMessages = [...event.followUp];
				break;
			case "model_changed":
				session.agent.state.model = event.model;
				break;
			case "thinking_level_changed":
				session.agent.state.thinkingLevel = event.level;
				break;
			case "context_window_changed":
				if (session.agent.state.model) session.agent.state.model = { ...session.agent.state.model, contextWindow: event.contextWindow };
				break;
			case "session_info_changed":
				this.remoteSessionName = event.name;
				break;
		}
	}
}
