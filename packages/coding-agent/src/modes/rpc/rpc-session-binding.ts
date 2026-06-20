import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { waitForRawStdoutBackpressure } from "../../core/output-guard.ts";
import { createRpcExtensionUIContext, type RpcPendingExtensionRequests } from "./rpc-extension-ui.ts";
import type { RpcOutput } from "./rpc-responses.ts";

interface RpcSessionBindingOptions {
	runtimeHost: AgentSessionRuntime;
	output: RpcOutput;
	pendingExtensionRequests: RpcPendingExtensionRequests;
	requestShutdown: () => void;
}

export class RpcSessionBinding {
	private session: AgentSession;
	private unsubscribe?: () => void;
	private unsubscribeBackpressure?: () => void;
	private readonly runtimeHost: AgentSessionRuntime;
	private readonly output: RpcOutput;
	private readonly pendingExtensionRequests: RpcPendingExtensionRequests;
	private readonly requestShutdown: () => void;

	constructor({ runtimeHost, output, pendingExtensionRequests, requestShutdown }: RpcSessionBindingOptions) {
		this.runtimeHost = runtimeHost;
		this.output = output;
		this.pendingExtensionRequests = pendingExtensionRequests;
		this.requestShutdown = requestShutdown;
		this.session = runtimeHost.session;
	}

	get currentSession(): AgentSession {
		return this.session;
	}

	async rebindSession(): Promise<void> {
		this.session = this.runtimeHost.session;
		const session = this.session;

		await session.bindExtensions({
			uiContext: createRpcExtensionUIContext({
				output: this.output,
				pendingExtensionRequests: this.pendingExtensionRequests,
			}),
			mode: "rpc",
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
					await this.session.reload();
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
	}

	disposeSubscriptions(): void {
		this.unsubscribe?.();
		this.unsubscribeBackpressure?.();
		this.unsubscribe = undefined;
		this.unsubscribeBackpressure = undefined;
	}
}
