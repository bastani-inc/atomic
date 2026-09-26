import type {
	CacheWarmingAction,
	CacheWarmingDecisionEvent,
	CacheWarmingDecisionEventResult,
} from "../cache-warmer.ts";
import { snapshotEventHandlers } from "./runner-events.ts";
/**
 * Extension runner - executes extensions and manages their lifecycle.
 */

import type { Provider, ProviderHeaders } from "@bastani/pi-ai";
import type { Api, ImageContent, Model } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { KeyId } from "@earendil-works/pi-tui";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import { lifecycleScopeForOwner, sessionLifecycleScopes } from "../session-lifecycle-scope.ts";
import type { SessionManager } from "../session-manager.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import { normalizeBuildSystemPromptOptions } from "../system-prompt.ts";
import { presentQuestionnaire } from "../tools/ask-user-question/ask-user-question.js";
import {
	assertExtensionAction,
	bindExtensionWork,
	drainExtensionWork,
	extensionWorkOpen,
	resumeExtensionWork,
	revokeExtensionAuthority,
	runExtensionCleanup,
	sealExtensionWork,
} from "./extension-work.ts";
import {
	copyHostQuestionnaire,
	type HostDiagnostic,
	type HostInput,
	HostInputBridge,
	hostInputError,
} from "./host-input.js";
import { originalRegistrationCallback } from "./loader-bindings.ts";
import { boundExtensionRuntimes, runResourceRegistrationBatch } from "./loader-runtime.ts";
import {
	createExtensionCommandContext,
	createExtensionContext,
	type ExtensionCommandContextSource,
} from "./runner-context.ts";
import {
	type BeforeAgentStartCombinedResult,
	type BoundaryBaseEvent,
	type BoundaryDispatchResult,
	type ResourcesDiscoverCombinedResult,
	type RunnerEmitEvent,
	type RunnerEmitResult,
	runBeforeAgentStartHandlers,
	runBeforeProviderRequestHandlers,
	runBoundaryHandlers,
	runContextHandlers,
	runGenericHandlers,
	runInputHandlers,
	runMessageEndHandlers,
	runResourcesDiscoverHandlers,
	runToolCallHandlers,
	runToolResultHandlers,
	runUserBashHandlers,
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
	collectMarkdownTransformers,
	collectRegisteredTools,
	findEntryRenderer,
	findMessageRenderer,
	findToolDefinition,
	hasExtensionHandlers,
	resolveRegisteredCommands,
} from "./runner-registries.ts";
import { resolveExtensionShortcuts } from "./runner-shortcuts.ts";
import { noOpUIContext } from "./runner-ui.ts";
import { STALE_EXTENSION_CONTEXT_MESSAGE } from "./stale-context.ts";
import type {
	BoundaryContextPreview,
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
	MarkdownTransformer,
	MessageEndEvent,
	MessageRenderer,
	OrchestrationContext,
	ProviderConfig,
	RegisteredTool,
	ResolvedCommand,
	ResourcesDiscoverEvent,
	SessionBoundaryDraft,
	SessionShutdownEvent,
	SubagentChildPolicy,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	UIPromptKind,
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
		const failures: Error[] = [];
		const unsubscribe = extensionRunner.onError((failure) => {
			if (failure.event === "session_shutdown")
				failures.push(new Error(`${failure.extensionPath}: ${failure.error}`));
		});
		try {
			await extensionRunner.emit(event);
		} catch (error) {
			const causes = error instanceof AggregateError ? error.errors : [error];
			failures.push(...causes.map((cause) => (cause instanceof Error ? cause : new Error(String(cause)))));
		} finally {
			unsubscribe();
		}
		// Shutdown may start tracked cleanup without returning its promise. Join it
		// after dispatch leaves its own work frame, including when a handler failed.
		try {
			await extensionRunner.drainWork();
		} catch (error) {
			failures.push(error instanceof Error ? error : new Error(String(error)));
		}
		if (failures.length)
			throw Object.assign(new AggregateError(failures, "Extension shutdown failed"), { code: "ShutdownFailed" });
		return true;
	}
	return false;
}

export class ExtensionRunner {
	private extensions: Extension[];
	private runtime: ExtensionRuntime;
	private uiContext: ExtensionUIContext;
	private presentationUI?: ExtensionUIContext;
	private presentationInput?: HostInput;
	private humanInput?: HostInput | null;
	private humanInputBindingRevision = 0;
	private inputBridge = new HostInputBridge(
		() => this.sessionManager.getSessionId(),
		() => this.getSignalFn(),
	);
	private onDiagnostic?: (diagnostic: HostDiagnostic) => void;
	private mode: ExtensionMode = "print";
	private cwd: string;
	private sessionManager: SessionManager;
	private modelRegistry: ModelRegistry;
	private orchestrationContext: OrchestrationContext | undefined;
	private subagentPolicy: SubagentChildPolicy | undefined;
	private taskHostBinding: (() => import("../tasks/agent-adapter.js").AgentTaskHost) | undefined;
	/** @internal Attach dispatch receipts to the owning session before startup. */
	bindWorkOwner(owner: object): void {
		bindExtensionWork(this.runtime, owner);
	}
	bindTaskHost(binding: () => import("../tasks/agent-adapter.js").AgentTaskHost): void {
		this.taskHostBinding = binding;
	}
	bindChildSessionOptions(
		resolver: import("../child-session-options.ts").ChildSessionOptionsResolver | undefined,
	): void {
		this.runtime.getChildSessionOptions = resolver;
	}
	getChildHostBindings(): import("../agent-session-types.js").ExtensionBindings {
		return {
			humanInput: this.humanInput === undefined ? this.presentationInput : this.humanInput,
			onDiagnostic: this.onDiagnostic,
		};
	}
	private errorListeners: Set<ExtensionErrorListener> = new Set();
	private getModel: () => Model<Api> | undefined = () => undefined;
	private getScopedModels: () => readonly ScopedModel[] = () => [];
	private isIdleFn: () => boolean = () => true;
	private isProjectTrustedFn: () => boolean = () => true;
	private getSignalFn: () => AbortSignal | undefined = () => undefined;
	private waitForIdleFn: () => Promise<void> = async () => {};
	private abortFn: () => void = () => {};
	private hasPendingMessagesFn: () => boolean = () => false;
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	private compactFn: (options?: CompactOptions) => void = () => {};
	private getSystemPromptFn: () => string = () => "";
	private getSystemPromptOptionsFn: () => BuildSystemPromptOptions = () =>
		normalizeBuildSystemPromptOptions({ cwd: this.cwd });
	private getSkillCatalogFn: ExtensionContextActions["getSkillCatalog"] = undefined;
	private getRouterModelFn: ExtensionContextActions["getRouterModel"] = undefined;
	private getModelRoutingFn: ExtensionContextActions["getModelRouting"] = undefined;
	private newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	private forkHandler: ForkHandler = async () => ({ cancelled: false });
	private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	private reloadHandler: ReloadHandler = async () => {};
	private shutdownHandler: ShutdownHandler = () => {};
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];
	private staleMessage: string | undefined;
	private authorityRevoked = false;
	private readonly contextOwner = {};
	private uiPromptBinding = 0;
	private activeUIPrompt:
		| { depth: number; reason: "ui_prompt" | "project_trust"; kind: UIPromptKind; title: string | undefined }
		| undefined;

	constructor(
		extensions: Extension[],
		runtime: ExtensionRuntime,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
		orchestrationContext?: OrchestrationContext,
		subagentPolicy?: SubagentChildPolicy,
	) {
		this.extensions = extensions;
		this.runtime = runtime;
		sessionLifecycleScopes.set(this, lifecycleScopeForOwner(runtime));
		this.runtime.workflowActivityHub.bindDispatcher((event, isCurrent) => this.emit(event, isCurrent));
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
		this.orchestrationContext = orchestrationContext;
		this.subagentPolicy = subagentPolicy;
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
		boundExtensionRuntimes.add(this.runtime);
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
		this.getScopedModels = contextActions.getScopedModels;
		this.isIdleFn = contextActions.isIdle;
		this.isProjectTrustedFn = contextActions.isProjectTrusted;
		this.getSignalFn = contextActions.getSignal;
		this.abortFn = contextActions.abort;
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.shutdownHandler = contextActions.shutdown;
		this.getContextUsageFn = contextActions.getContextUsage;
		this.compactFn = contextActions.compact;
		this.getSystemPromptFn = contextActions.getSystemPrompt;
		this.getSystemPromptOptionsFn =
			contextActions.getSystemPromptOptions ?? (() => normalizeBuildSystemPromptOptions({ cwd: this.cwd }));
		this.getSkillCatalogFn = contextActions.getSkillCatalog;
		this.getRouterModelFn = contextActions.getRouterModel;
		this.getModelRoutingFn = contextActions.getModelRouting;

		// Flush provider registrations queued during extension loading.
		for (const registration of this.runtime.pendingProviderRegistrations) {
			try {
				if ("provider" in registration) {
					(
						providerActions?.registerProvider ??
						((provider: Provider) => this.modelRegistry.registerProvider(provider))
					)(registration.provider);
				} else {
					(
						providerActions?.registerProvider ??
						((name: string, config?: ProviderConfig) => this.modelRegistry.registerProvider(name, config!))
					)(registration.name, registration.config);
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

	setHostBindings(
		humanInput: HostInput | null | undefined,
		onDiagnostic?: (diagnostic: HostDiagnostic) => void,
		bindingRevision = 0,
	): void {
		this.humanInput = humanInput;
		this.humanInputBindingRevision = bindingRevision;
		this.onDiagnostic = onDiagnostic;
		// Internal builtin bridge: no new extension API and no interception of console.
		const scope = lifecycleScopeForOwner(this.runtime);
		const report = (diagnostic: Omit<HostDiagnostic, "sessionId">) => {
			try {
				this.onDiagnostic?.({ ...diagnostic, sessionId: this.sessionManager.getSessionId() });
			} catch {
				// Observers cannot replace the primary service failure.
			}
		};
		// Rebinding replaces the reporter, not the builtin service owner.
		Object.defineProperty(report, Symbol.for("atomic.builtin-owner.v1"), { value: scope });
		Reflect.set(scope, Symbol.for("atomic.builtin-diagnostic.v1"), report);
		this.refreshHostInput();
	}

	cancelHostInput(): void {
		this.inputBridge.cancel();
	}
	/** @internal Join this generation's callbacks without draining its reload caller. */
	drainWork(): Promise<void> {
		return drainExtensionWork(this.runtime);
	}

	/** @internal Seal input admission without invalidating shutdown handlers. */
	sealHostInput(): void {
		this.inputBridge.close();
		sealExtensionWork(this.runtime);
	}

	/** @internal A rejected transaction retains the live runner, but never revives captured dialogs. */
	resumeAfterRejectedReload(): void {
		if (this.staleMessage) return;
		resumeExtensionWork(this.runtime);
		this.inputBridge = new HostInputBridge(
			() => this.sessionManager.getSessionId(),
			() => this.getSignalFn(),
		);
		this.refreshHostInput();
	}

	private refreshHostInput(): void {
		const ui = this.presentationUI;
		this.inputBridge.bind(
			this.humanInput === undefined ? this.presentationInput : (this.humanInput ?? undefined),
			this.humanInput,
			this.humanInputBindingRevision,
		);
		const bridged = this.inputBridge.wrap(
			ui ?? {
				...noOpUIContext,
				custom: async () => {
					throw hostInputError("HumanInputUnavailable");
				},
			},
			this.presentationInput,
			this.orchestrationContext?.kind === "workflow-stage"
				? {
						workflowRunId: this.orchestrationContext.workflowRunId,
						workflowStageId: this.orchestrationContext.workflowStageId,
					}
				: {},
		);
		this.uiContext = this.wrapUIPromptContext(bridged, this.uiPromptBinding);
		copyHostQuestionnaire(bridged, this.uiContext);
	}

	setUIContext(uiContext?: ExtensionUIContext, mode: ExtensionMode = "print"): void {
		if (uiContext !== this.presentationUI) {
			this.endActiveUIPrompt();
			++this.uiPromptBinding;
			this.presentationUI = uiContext;
			const ui = uiContext;
			this.presentationInput = ui
				? {
						confirm: (title, message, options) => ui.confirm(title, message, options),
						select: (title, choices, options) => ui.select(title, choices, options),
						input: (title, placeholder, options) => ui.input(title, placeholder, options),
						editor: (title, initial, options) => ui.editor(title, initial, options),
						questionnaire: (params, options) => presentQuestionnaire(ui, params, options.signal),
					}
				: undefined;
			this.refreshHostInput();
		}
		this.mode = mode;
	}

	private wrapUIPromptContext(ui: ExtensionUIContext, binding: number): ExtensionUIContext {
		return {
			...ui,
			select: (title, options, opts) =>
				this.withUIPrompt(binding, "select", title, () => ui.select(title, options, opts)),
			confirm: (title, message, opts) =>
				this.withUIPrompt(binding, "confirm", title, () => ui.confirm(title, message, opts)),
			input: (title, placeholder, opts) =>
				this.withUIPrompt(binding, "input", title, () => ui.input(title, placeholder, opts)),
			editor: (title, prefill, opts) =>
				this.withUIPrompt(binding, "editor", title, () => ui.editor(title, prefill, opts)),
			custom: (factory, options) =>
				options?.purpose === "navigation"
					? ui.custom(factory, options)
					: this.withUIPrompt(binding, "custom", options?.title, () => ui.custom(factory, options)),
		};
	}

	/** Track a host-owned trust dialog using the current session's prompt lifecycle. */
	withProjectTrustPrompt<T>(kind: UIPromptKind, title: string, run: () => Promise<T>): Promise<T> {
		return this.withUIPrompt(this.uiPromptBinding, kind, title, run, "project_trust");
	}

	/** Begin a host-owned trust span whose end arrives as a separate control frame. */
	beginProjectTrustPrompt(kind: UIPromptKind, title: string): () => void {
		return this.beginUIPrompt(kind, title, "project_trust");
	}

	private withUIPrompt<T>(
		binding: number,
		kind: UIPromptKind,
		title: string | undefined,
		run: () => Promise<T>,
		reason: "ui_prompt" | "project_trust" = "ui_prompt",
	): Promise<T> {
		if (binding !== this.uiPromptBinding) return run();
		const finish = this.beginUIPrompt(kind, title, reason);
		try {
			return run().finally(finish);
		} catch (error) {
			finish();
			throw error;
		}
	}

	private beginUIPrompt(
		kind: UIPromptKind,
		title: string | undefined,
		reason: "ui_prompt" | "project_trust",
	): () => void {
		let prompt = this.activeUIPrompt;
		if (!prompt) {
			prompt = { depth: 0, reason, kind, title };
			this.activeUIPrompt = prompt;
			this.emitUIPromptEvent({
				type: "ui_prompt_start",
				reason,
				kind,
				...(title === undefined ? {} : { title }),
			});
		}
		prompt.depth += 1;

		let finished = false;
		return () => {
			if (finished) return;
			finished = true;
			if (this.activeUIPrompt !== prompt) return;

			prompt.depth -= 1;
			if (prompt.depth === 0) this.endActiveUIPrompt(prompt);
		};
	}

	private endActiveUIPrompt(prompt = this.activeUIPrompt): void {
		if (!prompt || this.activeUIPrompt !== prompt) return;
		this.activeUIPrompt = undefined;
		prompt.depth = 0;
		this.emitUIPromptEvent({
			type: "ui_prompt_end",
			reason: prompt.reason,
			kind: prompt.kind,
			...(prompt.title === undefined ? {} : { title: prompt.title }),
		});
	}

	private readonly pendingUIPromptNotifications = new Set<Promise<void>>();

	private emitUIPromptEvent(event: Extract<RunnerEmitEvent, { type: "ui_prompt_start" | "ui_prompt_end" }>): void {
		const delivery = Promise.resolve().then(async () => {
			await this.emit(event);
		});
		this.pendingUIPromptNotifications.add(delivery);
		void delivery.finally(() => this.pendingUIPromptNotifications.delete(delivery)).catch(() => {});
	}

	/** Settle only the deliveries pending at this boundary, without delaying prompt UI. */
	async flushUIPromptNotifications(timeoutMs: number): Promise<{ timedOut: boolean }> {
		const pending = [...this.pendingUIPromptNotifications];
		if (pending.length === 0) return { timedOut: false };
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				Promise.allSettled(pending).then(() => ({ timedOut: false })),
				new Promise<{ timedOut: boolean }>((resolve) => {
					timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	getUIContext(): ExtensionUIContext {
		return this.uiContext;
	}

	hasUI(): boolean {
		return this.presentationUI !== undefined;
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
		this.runtime.explicitFlagNames ??= new Set();
		this.runtime.explicitFlagNames.add(name);
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
		for (const [key, shortcut] of resolution.shortcuts) {
			resolution.shortcuts.set(key, {
				...shortcut,
				handler: (context) => {
					if (!extensionWorkOpen(this.runtime)) return Promise.reject(hostInputError("SessionClosed"));
					return runResourceRegistrationBatch(this.runtime, async () => shortcut.handler(context));
				},
			});
		}
		return resolution.shortcuts;
	}

	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	revokeAuthority(): void {
		this.authorityRevoked = true;
		revokeExtensionAuthority(this.runtime);
	}

	invalidate(message = STALE_EXTENSION_CONTEXT_MESSAGE): void {
		this.sealHostInput();
		if (!this.staleMessage) {
			this.staleMessage = message;
			this.runtime.invalidate(message);
		}
	}

	private assertActive(): void {
		if (this.authorityRevoked) this.runtime.assertActive();
		if (this.staleMessage) {
			throw new Error(this.staleMessage);
		}
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		this.onDiagnostic?.({
			level: "error",
			source: error.extensionPath,
			message: `Extension ${error.event} failed`,
			sessionId: this.sessionManager.getSessionId(),
		});
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

	getMarkdownTransformers(): MarkdownTransformer[] {
		return collectMarkdownTransformers(this.extensions);
	}

	getEntryRenderer(customType: string): EntryRenderer | undefined {
		const renderer = findEntryRenderer(this.extensions, customType);
		return renderer ? originalRegistrationCallback(renderer) : undefined;
	}

	/** Invoke the session-owned registration without changing discovery identity. */
	renderEntry(customType: string, ...args: Parameters<EntryRenderer>): ReturnType<EntryRenderer> {
		this.assertActive();
		return findEntryRenderer(this.extensions, customType)?.(...args);
	}

	getRegisteredCommands(): ResolvedCommand[] {
		this.commandDiagnostics = [];
		return resolveRegisteredCommands(this.extensions);
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getCommand(name: string): ResolvedCommand | undefined {
		const command = resolveRegisteredCommands(this.extensions).find((entry) => entry.invocationName === name);
		if (!command) return undefined;
		return {
			...command,
			handler: (args, context) =>
				runResourceRegistrationBatch(this.runtime, async () => command.handler(args, context)),
		};
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * The actual shutdown behavior is provided by the mode via bindExtensions().
	 */
	shutdown(): void {
		this.shutdownHandler();
	}

	createContext(): ExtensionContext {
		return createExtensionContext(this.createContextSource(), this.contextOwner);
	}

	createCommandContext(): ExtensionCommandContext {
		return createExtensionCommandContext(this.createContextSource(), this.contextOwner);
	}

	private createContextSource(): ExtensionCommandContextSource {
		return {
			assertActive: () => this.assertActive(),
			assertAction: () => assertExtensionAction(this.runtime),
			getChildSessionOptions: (options) => this.runtime.getChildSessionOptions?.(options) ?? options,
			getExtensionPaths: () => this.getExtensionPaths(),
			observeWorkflowActivity: (observer) => this.runtime.workflowActivityHub.observeWorkflowActivity(observer),
			...(this.taskHostBinding ? { getAgentTaskHost: this.taskHostBinding } : {}),
			getUIContext: () => this.uiContext,
			getMode: () => this.mode,
			hasUI: () => this.hasUI(),
			hasHumanInput: () => this.inputBridge.available,
			getCwd: () => this.cwd,
			getSessionManager: () => this.sessionManager,
			getModelRegistry: () => this.modelRegistry,
			getModel: () => this.getModel(),
			getSubagentPolicy: () => this.subagentPolicy,
			getScopedModels: () => this.getScopedModels(),
			getThinkingLevel: () => this.runtime.getThinkingLevel(),
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
			...(this.getSkillCatalogFn ? { getSkillCatalog: () => this.getSkillCatalogFn!() } : {}),
			...(this.getRouterModelFn ? { getRouterModel: () => this.getRouterModelFn!() } : {}),
			...(this.getModelRoutingFn ? { getModelRouting: () => this.getModelRoutingFn!() } : {}),
			getSystemPromptOptions: () => this.getSystemPromptOptionsFn(),
			waitForIdle: () => this.waitForIdleFn(),
			newSession: (options) => this.newSessionHandler(options),
			fork: (entryId, options) => this.forkHandler(entryId, options),
			navigateTree: (targetId, options) => this.navigateTreeHandler(targetId, options),
			switchSession: (sessionPath, options) => this.switchSessionHandler(sessionPath, options),
			reload: () => this.reloadHandler(),
		};
	}

	/** Keep startup reporters bound while adding the now-authorized extension set. */
	attachStartupExtensions(extensions: Extension[]): () => Promise<void> {
		const newcomers = extensions.filter((extension) => !this.extensions.includes(extension));
		this.extensions = [...this.extensions, ...newcomers];
		return async () => {
			await runResourceRegistrationBatch(this.runtime, () =>
				runGenericHandlers(
					this.extensions.filter((extension) => newcomers.includes(extension)),
					this.createContext(),
					{ type: "session_start", reason: "startup" },
					(error) => this.emitError(error),
				),
			);
		};
	}

	async emit<TEvent extends RunnerEmitEvent>(
		event: TEvent,
		isCurrent?: () => boolean,
		admitted = false,
	): Promise<RunnerEmitResult<TEvent>> {
		if (!admitted && event.type !== "session_shutdown" && !extensionWorkOpen(this.runtime))
			return undefined as RunnerEmitResult<TEvent>;
		const observerFailures: Error[] = [];
		const dispatch = () =>
			runGenericHandlers(
				this.extensions,
				this.createContext(),
				event,
				(error) => {
					try {
						this.emitError(error);
					} catch (cause) {
						if (event.type !== "session_shutdown") throw cause;
						observerFailures.push(
							new Error(`${error.extensionPath}: ${error.error}`),
							new Error("Shutdown observer failed", { cause }),
						);
					}
				},
				isCurrent,
			);
		const result = await runResourceRegistrationBatch(
			this.runtime,
			() => (event.type === "session_shutdown" ? runExtensionCleanup(this.runtime, dispatch) : dispatch()),
			admitted || event.type === "session_shutdown",
		);
		if (observerFailures.length)
			throw Object.assign(new AggregateError(observerFailures, "Shutdown observers failed"), {
				code: "ShutdownFailed",
			});
		return result;
	}

	async emitMessageEnd(event: MessageEndEvent, admitted = false): Promise<AgentMessage | undefined> {
		return runResourceRegistrationBatch(
			this.runtime,
			() => runMessageEndHandlers(this.extensions, this.createContext(), event, (error) => this.emitError(error)),
			admitted,
		);
	}

	async emitToolResult(event: ToolResultEvent, admitted = false): Promise<ToolResultEventResult | undefined> {
		return runResourceRegistrationBatch(
			this.runtime,
			() => runToolResultHandlers(this.extensions, this.createContext(), event, (error) => this.emitError(error)),
			admitted,
		);
	}

	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runToolCallHandlers(this.extensions, this.createContext(), event),
		);
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runUserBashHandlers(this.extensions, this.createContext(), event, (error) => this.emitError(error)),
		);
	}

	async emitBoundary(
		baseEvent: BoundaryBaseEvent,
		buildContext: (entries: SessionBoundaryDraft[]) => BoundaryContextPreview | Promise<BoundaryContextPreview>,
	): Promise<BoundaryDispatchResult> {
		return runResourceRegistrationBatch(
			this.runtime,
			() =>
				runBoundaryHandlers(this.extensions, this.createContext(), baseEvent, buildContext, (error) =>
					this.emitError(error),
				),
			true,
		);
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runContextHandlers(this.extensions, this.createContext(), messages, (error) => this.emitError(error)),
		);
	}

	emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runBeforeProviderRequestHandlers(this.extensions, this.createContext(), payload, (error) =>
				this.emitError(error),
			),
		);
	}

	async emitCacheWarmingDecision(event: CacheWarmingDecisionEvent): Promise<CacheWarmingAction> {
		let action = event.action;
		const ctx = this.createContext();
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, event.type)) {
			for (const handler of handlers) {
				try {
					const result = (await handler({ ...event, action }, ctx)) as CacheWarmingDecisionEventResult | undefined;
					if (result?.action === "warm" || result?.action === "stop") action = result.action;
				} catch (error) {
					this.emitError({
						extensionPath: ext.path,
						event: event.type,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
		return action;
	}

	async emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		return runResourceRegistrationBatch(this.runtime, async () => {
			for (const { ext: extension, handlers } of snapshotEventHandlers(this.extensions, "before_provider_headers")) {
				for (const handler of handlers) {
					try {
						await handler({ type: "before_provider_headers", headers }, this.createContext());
					} catch (error) {
						this.emitError({
							extensionPath: extension.path,
							event: "before_provider_headers",
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined,
						});
					}
				}
			}
			return headers;
		});
	}

	emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPromptOptions: BuildSystemPromptOptions,
	): Promise<BeforeAgentStartCombinedResult> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runBeforeAgentStartHandlers(
				this.extensions,
				this.createContext(),
				() => this.assertActive(),
				prompt,
				images,
				systemPromptOptions,
				(error) => this.emitError(error),
			),
		);
	}

	emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<ResourcesDiscoverCombinedResult> {
		return runResourceRegistrationBatch(this.runtime, () =>
			runResourcesDiscoverHandlers(this.extensions, this.createContext(), cwd, reason, (error) =>
				this.emitError(error),
			),
		);
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
				this.emitError(error),
			),
		);
	}
}
