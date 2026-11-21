import { setCapabilityOverrides } from "@bastani/atomic-tui";
import type { AgentSession } from "../../core/agent-session.js";
import type { AgentSessionInternalSurface } from "../../core/agent-session-methods.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { chatReceipt } from "../../core/chat-receipts.js";
import type { ProjectTrustContext } from "../../core/extensions/index.js";
import { FooterDataProvider } from "../../core/footer-data-provider.ts";
import { waitForRawStdoutBackpressure } from "../../core/output-guard.ts";
import {
	keepDroppedQueuedMessages,
	type QueuedDeliveryRelay,
	withQueuedDeliveryChange,
} from "../../core/queued-message-delivery.ts";
import type { EngineCustomUiService } from "../interactive-engine/engine-custom-ui.ts";
import type { EngineInputFormService } from "../interactive-engine/engine-input-form.ts";
import type { EngineRenderService } from "../interactive-engine/engine-render-service.ts";
import type { EngineSessionPickerService } from "../interactive-engine/engine-session-picker.ts";
import { serializeInteractiveEngineMessage } from "../interactive-engine/protocol.ts";
import { toJsonEvent } from "../json-event.ts";
import { bindAgentPanel } from "./agent-panel-bridge.ts";
import { bindEngineAgentView } from "./agent-view-rpc.ts";
import { outputExtensionLoadErrors } from "./rpc-extension-load-errors.ts";
import {
	createRpcExtensionUIContext,
	type RpcExtensionUICapabilities,
	type RpcPendingExtensionRequests,
} from "./rpc-extension-ui.ts";
import type { KeybindingsReloadCoordinator } from "./rpc-keybindings-reload.ts";
import type { RpcOutput } from "./rpc-responses.ts";
import { engineTaskInspectorUi } from "./task-ui-bridge.js";

interface RpcSessionBindingOptions {
	runtimeHost: AgentSessionRuntime;
	output: RpcOutput;
	pendingExtensionRequests: RpcPendingExtensionRequests;
	extensionUICapabilities?: RpcExtensionUICapabilities;
	customUi?: EngineCustomUiService;
	renderService?: EngineRenderService;
	sessionPicker?: EngineSessionPickerService;
	inputForm?: EngineInputFormService;
	/** Send terminal UI updates from the interactive engine child to its host. */
	writeEngineLine?: (line: string) => void;
	/** Tells a host that asked for them which queued messages the session is delivering, on its event lines. */
	queuedDeliveries?: QueuedDeliveryRelay;
	requestShutdown: () => void;
	checkShutdownRequested?: () => void;
	reloadCoordinator?: KeybindingsReloadCoordinator<AgentSession>;
	onStartupReload?: (session: AgentSession) => Promise<void>;
}

export class RpcSessionBinding {
	private session: AgentSession;
	private boundRunner: AgentSession["extensionRunner"] | undefined;
	private unsubscribe?: () => void;
	/** Ends this binding's taking of what the bound session's runs drop from its queue (see `keepDroppedQueuedMessages`). */
	private releaseDroppedQueuedMessages?: () => void;
	private unsubscribeBackpressure?: () => void;
	private unsubscribeTasks?: () => void;
	private stopAgentView?: () => void;
	private readonly runtimeHost: AgentSessionRuntime;
	private readonly output: RpcOutput;
	private readonly pendingExtensionRequests: RpcPendingExtensionRequests;
	private readonly extensionUICapabilities: RpcExtensionUICapabilities | undefined;
	private readonly customUi: EngineCustomUiService | undefined;
	private readonly renderService: EngineRenderService | undefined;
	private readonly sessionPicker: EngineSessionPickerService | undefined;
	private readonly inputForm: EngineInputFormService | undefined;
	private readonly writeEngineLine: ((line: string) => void) | undefined;
	private readonly queuedDeliveries: QueuedDeliveryRelay | undefined;
	private readonly requestShutdown: () => void;
	private readonly checkShutdownRequested: (() => void) | undefined;
	private readonly reloadCoordinator: KeybindingsReloadCoordinator<AgentSession> | undefined;
	private readonly onStartupReload: ((session: AgentSession) => Promise<void>) | undefined;

	private footerDataProvider: FooterDataProvider | undefined;
	constructor({
		runtimeHost,
		output,
		pendingExtensionRequests,
		extensionUICapabilities,
		requestShutdown,
		checkShutdownRequested,
		customUi,
		renderService,
		sessionPicker,
		inputForm,
		writeEngineLine,
		queuedDeliveries,
		reloadCoordinator,
		onStartupReload,
	}: RpcSessionBindingOptions) {
		this.runtimeHost = runtimeHost;
		this.output = output;
		this.pendingExtensionRequests = pendingExtensionRequests;
		this.extensionUICapabilities = extensionUICapabilities;
		this.requestShutdown = requestShutdown;
		this.checkShutdownRequested = checkShutdownRequested;
		this.customUi = customUi;
		this.renderService = renderService;
		this.sessionPicker = sessionPicker;
		this.inputForm = inputForm;
		this.writeEngineLine = writeEngineLine;
		this.queuedDeliveries = queuedDeliveries;
		this.reloadCoordinator = reloadCoordinator;
		this.onStartupReload = onStartupReload;
		this.session = runtimeHost.session;
		this.runtimeHost.setProjectTrustContextFactory?.((cwd) => this.createProjectTrustContext(cwd));
	}

	private createProjectTrustContext(cwd: string): ProjectTrustContext {
		const runner = this.runtimeHost.session.extensionRunner;
		const ui = runner.getUIContext();
		const hasUI = this.customUi !== undefined;
		return {
			cwd,
			mode: hasUI ? "tui" : "rpc",
			hasUI,
			ui: {
				select: (title, options, opts) =>
					hasUI
						? runner.withProjectTrustPrompt("select", title, () => ui.select(title, options, opts))
						: Promise.resolve(undefined),
				confirm: (title, message, opts) =>
					hasUI
						? runner.withProjectTrustPrompt("confirm", title, () => ui.confirm(title, message, opts))
						: Promise.resolve(false),
				input: (title, placeholder, opts) =>
					hasUI
						? runner.withProjectTrustPrompt("input", title, () => ui.input(title, placeholder, opts))
						: Promise.resolve(undefined),
				notify: (message, type) => ui.notify(message, type),
			},
		};
	}

	get currentSession(): AgentSession {
		return this.session;
	}

	/** The bound session is being replaced: its later events tell the host nothing about queued messages. */
	retireQueuedDeliveries(): void {
		this.queuedDeliveries?.retire(this.session);
		this.releaseDroppedQueuedMessages?.();
		this.releaseDroppedQueuedMessages = undefined;
	}

	async rebindSession(): Promise<void> {
		if (this.session === this.runtimeHost.session && this.boundRunner === this.session.extensionRunner) return;
		this.session = this.runtimeHost.session;
		this.disposeSubscriptions();
		const session = this.session;
		setCapabilityOverrides(session.settingsManager.getTerminalCapabilityOverrides());
		this.renderService?.bindSession(session);
		const footerDataProvider = new FooterDataProvider(session.sessionManager.getCwd());
		this.footerDataProvider = footerDataProvider;
		// Seed the provider count from the current catalog snapshot, mirroring
		// updateProviderCountFromSnapshot() in interactive startup, so the
		// embedded footer shows the (provider) model prefix in multi-provider
		// sessions instead of defaulting to 0.
		const models =
			session.scopedModels.length > 0
				? session.scopedModels.map((scoped) => scoped.model)
				: session.modelRuntime.getAvailableSnapshot();
		footerDataProvider.setAvailableProviderCount(new Set(models.map((model) => model.provider)).size);

		try {
			await session.bindExtensions({
				onUIPrompt: (event) => {
					if (event.reason === "ui_prompt") {
						this.writeEngineLine?.(serializeInteractiveEngineMessage({ type: "engine_ui_prompt", event }));
					}
				},
				uiContext: createRpcExtensionUIContext({
					output: this.output,
					pendingExtensionRequests: this.pendingExtensionRequests,
					customUi: this.customUi,
					sessionPicker: this.sessionPicker,
					inputForm: this.inputForm,
					footerDataProvider,
					capabilities: this.extensionUICapabilities,
					getToolDefinition: (name) =>
						session.extensionRunner.resolveToolRenderers(name, () => session.getToolDefinition(name)),
					getCustomMessageRenderer: (name) => session.extensionRunner.getMessageRenderer(name),
				}),
				mode: this.customUi ? "tui" : "rpc",
				commandContextActions: {
					waitForIdle: () => this.session.agent.waitForIdle(),
					newSession: async (options) => this.runtimeHost.newSession(options),
					fork: async (entryId, forkOptions) => {
						const result = await this.runtimeHost.fork(entryId, forkOptions);
						return { cancelled: result.cancelled };
					},
					navigateTree: async (targetId, options) => {
						const result = await this.session.navigateTree(targetId, {
							summarize: options?.summarize,
							customInstructions: options?.customInstructions,
							replaceInstructions: options?.replaceInstructions,
							label: options?.label,
						});
						return { cancelled: result.cancelled };
					},
					switchSession: async (sessionPath, options) => {
						return this.runtimeHost.switchSession(sessionPath, { ...options, history: "tail" });
					},
					reload: async () => {
						const steeringMode = this.session.steeringMode;
						const followUpMode = this.session.followUpMode;
						if (this.reloadCoordinator) await this.reloadCoordinator.reload(this.session);
						else await this.session.reload();
						this.session.setSteeringMode(steeringMode);
						this.session.setFollowUpMode(followUpMode);
					},
				},
				shutdownHandler: this.requestShutdown,
				// The interactive engine's user sees extension errors on the host; a standalone RPC client keeps failed starts.
				reportStartupErrors: this.customUi !== undefined,
				onError: (err) => {
					this.output({
						type: "extension_error",
						extensionPath: err.extensionPath,
						event: err.event,
						error: err.error,
						...(this.customUi &&
						(err.event === "session_start" || err.event === "resources_discover") &&
						err.stack
							? { stack: err.stack }
							: {}),
					});
				},
			});
			footerDataProvider.startGitWatcher();
		} catch (error) {
			// Leave no partially-initialized footer state behind if extension
			// binding fails. A concurrent rebind may already own the binding's
			// footer, so only clear the one this bind created.
			footerDataProvider.dispose();
			if (this.footerDataProvider === footerDataProvider) this.footerDataProvider = undefined;
			// RPC admits commands while the startup bind is still starting extensions, so a
			// replacement (or shutdown) can close this session mid-start (#4711). Its successor,
			// if any, is bound by its own rebind; nothing is left to bind here.
			if (isSessionClosed(error) && (session as unknown as AgentSessionInternalSurface)._disposed) return;
			throw error;
		}
		// A replacement bound its own session while this bind was pending; its state is not ours.
		if (session !== this.session) {
			footerDataProvider.dispose();
			return;
		}

		if (this.customUi) {
			const customUi = this.customUi;
			const ui = session.extensionRunner.getUIContext();
			// The host shows this engine's subagents on its own screen through these views.
			this.stopAgentView?.();
			this.stopAgentView = bindEngineAgentView({
				session,
				send: (message) => this.writeEngineLine?.(serializeInteractiveEngineMessage(message)),
				customUi,
				ui,
			});
			this.unsubscribeTasks = bindAgentPanel(
				session,
				ui,
				(counts) => {
					this.writeEngineLine?.(
						serializeInteractiveEngineMessage({ type: "engine_agent_panel_state", ...counts }),
					);
				},
				engineTaskInspectorUi(ui, {
					custom: customUi.custom.bind(customUi),
					getHostRenderSettings: () => customUi.getHostRenderSettings(),
				}),
			);
		}
		// The host gives back to its editor what the session's runs drop from its queue.
		this.releaseDroppedQueuedMessages?.();
		this.releaseDroppedQueuedMessages =
			this.queuedDeliveries === undefined ? undefined : keepDroppedQueuedMessages(session);
		this.unsubscribe = session.subscribe((event) => {
			// A finished message carries its save receipt, so a host can tell which saved entry its rows show.
			const saved = event.type === "message_end" ? session.entryReceipt?.(event.message) : undefined;
			const receipt = this.writeEngineLine && chatReceipt(event);
			const json = toJsonEvent(event);
			const withSaved = saved === undefined ? json : { ...json, entryId: saved.entryId, seq: saved.seq };
			const record = withQueuedDeliveryChange(withSaved, this.queuedDeliveries?.note(session, event));
			this.output(receipt ? { ...record, atomicChatReceipt: receipt } : record);
			if (event.type === "agent_settled") this.checkShutdownRequested?.();
		});
		this.unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
		this.reloadCoordinator?.publishCurrentState(session);
		this.boundRunner = session.extensionRunner;
	}

	/** Load and atomically publish the optional resource set after the minimal interactive engine binds. */
	async loadDeferredResources(): Promise<void> {
		const session = this.session;
		try {
			if (!(await this.runtimeHost.completeStartup?.())) {
				await session.reload({ reason: "startup" });
				await this.onStartupReload?.(session);
			}
		} finally {
			outputExtensionLoadErrors(session, "startup", this.output);
		}
		if (session !== this.session) return;
		this.reloadCoordinator?.publishCurrentState(session);
	}

	disposeSubscriptions(): void {
		this.boundRunner = undefined;
		this.unsubscribe?.();
		this.releaseDroppedQueuedMessages?.();
		this.releaseDroppedQueuedMessages = undefined;
		this.unsubscribeBackpressure?.();
		this.unsubscribeTasks?.();
		this.unsubscribeTasks = undefined;
		this.stopAgentView?.();
		this.stopAgentView = undefined;
		this.writeEngineLine?.(
			serializeInteractiveEngineMessage({
				type: "engine_ui_prompt",
				event: { type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" },
			}),
		);
		this.footerDataProvider?.dispose();
		this.unsubscribe = undefined;
		this.unsubscribeBackpressure = undefined;
		this.footerDataProvider = undefined;
	}
}

function isSessionClosed(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "SessionClosed";
}
