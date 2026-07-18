import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { waitForRawStdoutBackpressure } from "../../core/output-guard.ts";
import type { EngineCustomUiService } from "../interactive-engine/engine-custom-ui.ts";
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
	private readonly requestShutdown: () => void;
	private readonly reloadCoordinator: KeybindingsReloadCoordinator<AgentSession> | undefined;

	constructor({ runtimeHost, output, pendingExtensionRequests, requestShutdown, customUi, renderService, sessionPicker, reloadCoordinator }: RpcSessionBindingOptions) {
		this.runtimeHost = runtimeHost;
		this.output = output;
		this.pendingExtensionRequests = pendingExtensionRequests;
		this.requestShutdown = requestShutdown;
		this.customUi = customUi;
		this.renderService = renderService;
		this.sessionPicker = sessionPicker;
		this.reloadCoordinator = reloadCoordinator;
		this.session = runtimeHost.session;
	}

	get currentSession(): AgentSession {
		return this.session;
	}

	async rebindSession(): Promise<void> {
		this.session = this.runtimeHost.session;
		const session = this.session;
		this.renderService?.bindSession(session);

		await session.bindExtensions({
			uiContext: createRpcExtensionUIContext({
				output: this.output,
				pendingExtensionRequests: this.pendingExtensionRequests,
				customUi: this.customUi,
				sessionPicker: this.sessionPicker,
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

		this.disposeSubscriptions();
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
		this.unsubscribe = undefined;
		this.unsubscribeBackpressure = undefined;
	}
}
