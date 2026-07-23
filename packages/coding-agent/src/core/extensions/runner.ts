/**
 * Extension runner - executes extensions and manages their lifecycle.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Provider, ProviderHeaders } from "@earendil-works/pi-ai";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai/compat";
import type { KeyId } from "@earendil-works/pi-tui";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SessionManager } from "../session-manager.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import {
	createExtensionCommandContext,
	createExtensionContext,
	type ExtensionCommandContextSource,
} from "./runner-context.ts";
import { runResourceRegistrationBatch } from "./loader-runtime.ts";
import {
	runBeforeAgentStartHandlers,
	runBeforeProviderRequestHandlers,
	runContextHandlers,
	runGenericHandlers,
	runInputHandlers,
	runMessageEndHandlers,
	runResourcesDiscoverHandlers,
	runToolCallHandlers,
	runToolResultHandlers,
	runUserBashHandlers,
	type BeforeAgentStartCombinedResult,
	type ResourcesDiscoverCombinedResult,
	type RunnerEmitEvent,
	type RunnerEmitResult,
} from "./runner-events.ts";
import type {
	ExtensionErrorListener,
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ReloadHandler,
	ShutdownHandler,
	SwitchSessionHandler,
} from "./runner-handlers.ts";
import {
	collectFlags,
	collectRegisteredTools,
	findEntryRenderer,
	findMessageRenderer,
	findToolDefinition,
	hasExtensionHandlers,
	resolveRegisteredCommands,
} from "./runner-registries.ts";
import { resolveExtensionShortcuts } from "./runner-shortcuts.ts";
import { noOpUIContext } from "./runner-ui.ts";
import type {
	CompactOptions,
	ContextUsage,
	EntryRenderer,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionFlag,
	ExtensionMode,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	InputEventResult,
	InputSource,
	MessageEndEvent,
	MessageRenderer,
	OrchestrationContext,
	ProviderConfig,
	RegisteredTool,
	ResolvedCommand,
	ResourcesDiscoverEvent,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
} from "./types.ts";

export type {
	ExtensionErrorListener,
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ReloadHandler,
	ShutdownHandler,
	SwitchSessionHandler,
} from "./runner-handlers.ts";
export { emitProjectTrustEvent } from "./runner-project-trust.ts";

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 */
export async function emitSessionShutdownEvent(
	extensionRunner: ExtensionRunner,
	event: SessionShutdownEvent,
): Promise<boolean> {
	if (extensionRunner.hasHandlers("session_shutdown")) {
		await extensionRunner.emit(event);
		return true;
	}
	return false;
}

export class ExtensionRunner {
	private extensions: Extension[];
	private runtime: ExtensionRuntime;
	private uiContext: ExtensionUIContext;
	private mode: ExtensionMode = "print";
	private cwd: string;
	private sessionManager: SessionManager;
	private modelRegistry: ModelRegistry;
	private orchestrationContext: OrchestrationContext | undefined;
	private errorListeners: Set<ExtensionErrorListener> = new Set();
	private getModel: () => Model<Api> | undefined = () => undefined;
	private isIdleFn: () => boolean = () => true;
	private isProjectTrustedFn: () => boolean = () => true;
	private getSignalFn: () => AbortSignal | undefined = () => undefined;
	private waitForIdleFn: () => Promise<void> = async () => {};
	private abortFn: () => void = () => {};
	private hasPendingMessagesFn: () => boolean = () => false;
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	private compactFn: (options?: CompactOptions) => void = () => {};
	private getSystemPromptFn: () => string = () => "";
	private getSystemPromptOptionsFn: () => BuildSystemPromptOptions = () => ({ cwd: this.cwd });
	private newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	private forkHandler: ForkHandler = async () => ({ cancelled: false });
	private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	private reloadHandler: ReloadHandler = async () => {};
	private shutdownHandler: ShutdownHandler = () => {};
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];
	private staleMessage: string | undefined;

	constructor(
		extensions: Extension[],
		runtime: ExtensionRuntime,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
		orchestrationContext?: OrchestrationContext,
	) {
		this.extensions = extensions;
		this.runtime = runtime;
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
		this.orchestrationContext = orchestrationContext;
	}

	bindCore(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		providerActions?: {
			registerProvider?: (providerOrName: Provider | string, config?: ProviderConfig) => void;
			unregisterProvider?: (name: string) => void;
		},
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendMessages = actions.sendMessages;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.setSessionName = actions.setSessionName;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setLabel = actions.setLabel;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.refreshTools = actions.refreshTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;

		// Context actions (required)
		this.getModel = contextActions.getModel;
		this.isIdleFn = contextActions.isIdle;
		this.isProjectTrustedFn = contextActions.isProjectTrusted;
		this.getSignalFn = contextActions.getSignal;
		this.abortFn = contextActions.abort;
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.shutdownHandler = contextActions.shutdown;
		this.getContextUsageFn = contextActions.getContextUsage;
		this.compactFn = contextActions.compact;
		this.getSystemPromptFn = contextActions.getSystemPrompt;
		this.getSystemPromptOptionsFn = contextActions.getSystemPromptOptions ?? (() => ({ cwd: this.cwd }));

		// Flush provider registrations queued during extension loading.
		for (const registration of this.runtime.pendingProviderRegistrations) {
			try {
				if ("provider" in registration) {
					(providerActions?.registerProvider ?? ((provider: Provider) => this.modelRegistry.registerProvider(provider)))(registration.provider);
				} else {
					(providerActions?.registerProvider ?? ((name: string, config?: ProviderConfig) => this.modelRegistry.registerProvider(name, config!)))(registration.name, registration.config);
				}
			} catch (error) {
				this.emitError({
					extensionPath: registration.extensionPath,
					event: "register_provider",
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
		this.runtime.pendingProviderRegistrations = [];

		// From this point on, provider registration/unregistration takes effect immediately
		// without requiring a /reload.
		this.runtime.registerProvider = ((providerOrName: Provider | string, configOrPath?: ProviderConfig | string) => {
			if (typeof providerOrName === "string") {
				const config = configOrPath as ProviderConfig;
				if (providerActions?.registerProvider) providerActions.registerProvider(providerOrName, config);
				else this.modelRegistry.registerProvider(providerOrName, config);
			} else if (providerActions?.registerProvider) providerActions.registerProvider(providerOrName);
			else this.modelRegistry.registerProvider(providerOrName);
		}) as ExtensionRuntime["registerProvider"];
		this.runtime.unregisterProvider = (name) => {
			if (providerActions?.unregisterProvider) {
				providerActions.unregisterProvider(name);
				return;
			}
			this.modelRegistry.unregisterProvider(name);
		};
	}

	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		if (actions) {
			this.waitForIdleFn = actions.waitForIdle;
			this.newSessionHandler = actions.newSession;
			this.forkHandler = actions.fork;
			this.navigateTreeHandler = actions.navigateTree;
			this.switchSessionHandler = actions.switchSession;
			this.reloadHandler = actions.reload;
			return;
		}

		this.waitForIdleFn = async () => {};
		this.newSessionHandler = async () => ({ cancelled: false });
		this.forkHandler = async () => ({ cancelled: false });
		this.navigateTreeHandler = async () => ({ cancelled: false });
		this.switchSessionHandler = async () => ({ cancelled: false });
		this.reloadHandler = async () => {};
	}

	setUIContext(uiContext?: ExtensionUIContext, mode: ExtensionMode = "print"): void {
		this.uiContext = uiContext ?? noOpUIContext;
		this.mode = mode;
	}

	getUIContext(): ExtensionUIContext {
		return this.uiContext;
	}

	hasUI(): boolean {
		return this.uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map((extension) => extension.path);
	}

	/** Get all registered tools from all extensions (first registration per name wins). */
	getAllRegisteredTools(): RegisteredTool[] {
		return collectRegisteredTools(this.extensions);
	}

	/** Get a tool definition by name. Returns undefined if not found. */
	getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined {
		return findToolDefinition(this.extensions, toolName);
	}

	getFlags(): Map<string, ExtensionFlag> {
		return collectFlags(this.extensions);
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
		(this.runtime.explicitFlagNames ??= new Set()).add(name);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	getExplicitFlagValues(): Map<string, boolean | string> {
		const explicitFlagNames = this.runtime.explicitFlagNames ?? new Set<string>();
		return new Map([...this.runtime.flagValues].filter(([name]) => explicitFlagNames.has(name)));
	}

	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
		const resolution = resolveExtensionShortcuts(this.extensions, resolvedKeybindings, this.hasUI());
		this.shortcutDiagnostics = resolution.diagnostics;
		return resolution.shortcuts;
	}

	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	invalidate(
		message = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
	): void {
		if (!this.staleMessage) {
			this.staleMessage = message;
			this.runtime.invalidate(message);
		}
	}

	private assertActive(): void {
		if (this.staleMessage) {
			throw new Error(this.staleMessage);
		}
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		return hasExtensionHandlers(this.extensions, eventType);
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		return findMessageRenderer(this.extensions, customType);
	}

	getEntryRenderer(customType: string): EntryRenderer | undefined {
		return findEntryRenderer(this.extensions, customType);
	}

	getRegisteredCommands(): ResolvedCommand[] {
		this.commandDiagnostics = [];
		return resolveRegisteredCommands(this.extensions);
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getCommand(name: string): ResolvedCommand | undefined {
		return resolveRegisteredCommands(this.extensions).find((command) => command.invocationName === name);
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * The actual shutdown behavior is provided by the mode via bindExtensions().
	 */
	shutdown(): void {
		this.shutdownHandler();
	}

	createContext(): ExtensionContext {
		return createExtensionContext(this.createContextSource());
	}

	createCommandContext(): ExtensionCommandContext {
		return createExtensionCommandContext(this.createContextSource());
	}

	private createContextSource(): ExtensionCommandContextSource {
		return {
			assertActive: () => this.assertActive(),
			getUIContext: () => this.uiContext,
			getMode: () => this.mode,
			hasUI: () => this.hasUI(),
			getCwd: () => this.cwd,
			getSessionManager: () => this.sessionManager,
			getModelRegistry: () => this.modelRegistry,
			getModel: () => this.getModel(),
			getOrchestrationContext: () => this.orchestrationContext,
			isIdle: () => this.isIdleFn(),
			isProjectTrusted: () => this.isProjectTrustedFn(),
			getSignal: () => this.getSignalFn(),
			abort: () => this.abortFn(),
			hasPendingMessages: () => this.hasPendingMessagesFn(),
			shutdown: () => this.shutdownHandler(),
			getContextUsage: () => this.getContextUsageFn(),
			compact: (options) => this.compactFn(options),
			getSystemPrompt: () => this.getSystemPromptFn(),
			getSystemPromptOptions: () => this.getSystemPromptOptionsFn(),
			waitForIdle: () => this.waitForIdleFn(),
			newSession: (options) => this.newSessionHandler(options),
			fork: (entryId, options) => this.forkHandler(entryId, options),
			navigateTree: (targetId, options) => this.navigateTreeHandler(targetId, options),
			switchSession: (sessionPath, options) => this.switchSessionHandler(sessionPath, options),
			reload: () => this.reloadHandler(),
		};
	}


	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runGenericHandlers(this.extensions, this.createContext(), event, (error) => this.emitError(error)));
	}

	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runMessageEndHandlers(this.extensions, this.createContext(), event, (error) => this.emitError(error)));
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runToolResultHandlers(this.extensions, this.createContext(), event, (error) => this.emitError(error)));
	}

	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		return runResourceRegistrationBatch(this.runtime, () => runToolCallHandlers(this.extensions, this.createContext(), event));
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runUserBashHandlers(this.extensions, this.createContext(), event, (error) => this.emitError(error)));
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runContextHandlers(this.extensions, this.createContext(), messages, (error) => this.emitError(error)));
	}

	emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runBeforeProviderRequestHandlers(this.extensions, this.createContext(), payload, (error) =>
				this.emitError(error)));
	}

	async emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		return runResourceRegistrationBatch(this.runtime, async () => {
			for (const extension of this.extensions) {
				for (const handler of extension.handlers.get("before_provider_headers") ?? []) {
					try {
						await handler({ type: "before_provider_headers", headers }, this.createContext());
					} catch (error) {
						this.emitError({ extensionPath: extension.path, event: "before_provider_headers", error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
					}
				}
			}
			return headers;
		});
	}

	emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		return runResourceRegistrationBatch(this.runtime, () => runBeforeAgentStartHandlers(
			this.extensions,
			this.createContext(),
			() => this.assertActive(),
			prompt,
			images,
			systemPrompt,
			systemPromptOptions,
			(error) => this.emitError(error),
		));
	}

	emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<ResourcesDiscoverCombinedResult> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runResourcesDiscoverHandlers(this.extensions, this.createContext(), cwd, reason, (error) =>
				this.emitError(error)));
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<InputEventResult> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runInputHandlers(this.extensions, this.createContext(), text, images, source, streamingBehavior, (error) =>
				this.emitError(error)));
	}
}
