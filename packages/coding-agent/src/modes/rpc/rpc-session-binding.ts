import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { FooterDataProvider } from "../../core/footer-data-provider.ts";
import { waitForRawStdoutBackpressure } from "../../core/output-guard.ts";
import type { EngineCustomUiService } from "../interactive-engine/engine-custom-ui.ts";
import type { EngineInputFormService } from "../interactive-engine/engine-input-form.ts";
import type { EngineRenderService } from "../interactive-engine/engine-render-service.ts";
import type { EngineSessionPickerService } from "../interactive-engine/engine-session-picker.ts";
import { createRpcExtensionUIContext, type RpcPendingExtensionRequests } from "./rpc-extension-ui.ts";
import type { KeybindingsReloadCoordinator } from "./rpc-keybindings-reload.ts";
import type { RpcOutput } from "./rpc-responses.ts";

interface RpcSessionBindingOptions {
	runtimeHost: AgentSessionRuntime;
	output: RpcOutput;
	pendingExtensionRequests: RpcPendingExtensionRequests;
	customUi?: EngineCustomUiService;
	renderService?: EngineRenderService;
	sessionPicker?: EngineSessionPickerService;
	inputForm?: EngineInputFormService;
	requestShutdown: () => void;
	reloadCoordinator?: KeybindingsReloadCoordinator<AgentSession>;
}

export class RpcSessionBinding {
	private session: AgentSession;
	private unsubscribe?: () => void;
	private unsubscribeBackpressure?: () => void;
	private readonly runtimeHost: AgentSessionRuntime;
	private readonly output: RpcOutput;
	private readonly pendingExtensionRequests: RpcPendingExtensionRequests;
	private readonly customUi: EngineCustomUiService | undefined;
	private readonly renderService: EngineRenderService | undefined;
	private readonly sessionPicker: EngineSessionPickerService | undefined;
	private readonly inputForm: EngineInputFormService | undefined;
	private readonly requestShutdown: () => void;
	private readonly reloadCoordinator: KeybindingsReloadCoordinator<AgentSession> | undefined;

	private footerDataProvider: FooterDataProvider | undefined;
	constructor({ runtimeHost, output, pendingExtensionRequests, requestShutdown, customUi, renderService, sessionPicker, inputForm, reloadCoordinator }: RpcSessionBindingOptions) {
		this.runtimeHost = runtimeHost;
		this.output = output;
		this.pendingExtensionRequests = pendingExtensionRequests;
		this.requestShutdown = requestShutdown;
		this.customUi = customUi;
		this.renderService = renderService;
		this.sessionPicker = sessionPicker;
		this.inputForm = inputForm;
		this.reloadCoordinator = reloadCoordinator;
		this.session = runtimeHost.session;
	}

	get currentSession(): AgentSession {
		return this.session;
	}

	async rebindSession(): Promise<void> {
		this.session = this.runtimeHost.session;
		this.disposeSubscriptions();
		const session = this.session;
		this.renderService?.bindSession(session);
		this.footerDataProvider = new FooterDataProvider(session.sessionManager.getCwd());
		// Seed the provider count from the current catalog snapshot, mirroring
		// updateProviderCountFromSnapshot() in interactive startup, so the
		// embedded footer shows the (provider) model prefix in multi-provider
		// sessions instead of defaulting to 0.
		const models = session.scopedModels.length > 0
			? session.scopedModels.map((scoped) => scoped.model)
			: session.modelRegistry.getAvailable();
		this.footerDataProvider.setAvailableProviderCount(new Set(models.map((model) => model.provider)).size);

		try {
			await session.bindExtensions({
				uiContext: createRpcExtensionUIContext({
					output: this.output,
					pendingExtensionRequests: this.pendingExtensionRequests,
					customUi: this.customUi,
					sessionPicker: this.sessionPicker,
					inputForm: this.inputForm,
					footerDataProvider: this.footerDataProvider,
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
						return this.runtimeHost.switchSession(sessionPath, options);
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
				onError: (err) => {
					this.output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
				},
			});
			this.footerDataProvider.startGitWatcher();
		} catch (error) {
			// Leave no partially-initialized footer state behind if extension
			// binding fails; dispose the provider and rethrow.
			this.footerDataProvider.dispose();
			this.footerDataProvider = undefined;
			throw error;
		}

		this.unsubscribe = session.subscribe((event) => {
			this.output(event);
		});
		this.unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
		this.reloadCoordinator?.publishCurrentState(session);
	}

	disposeSubscriptions(): void {
		this.unsubscribe?.();
		this.unsubscribeBackpressure?.();
		this.footerDataProvider?.dispose();
		this.unsubscribe = undefined;
		this.unsubscribeBackpressure = undefined;
		this.footerDataProvider = undefined;
	}
}
