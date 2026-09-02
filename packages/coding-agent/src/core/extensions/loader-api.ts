import type { Provider } from "@bastani/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import { canonicalEventBusFor, type EventBus, registerCanonicalEventBus } from "../event-bus.ts";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import {
	emptyWorkflowResourceProvider,
	normalizeWorkflowResourceProvider,
	type ResourceLoaderInheritanceSnapshotProvider,
	type WorkflowResourceProviderInput,
} from "./loader-resources.ts";
import type {
	EntryRenderer,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionRuntime,
	MarkdownTransformer,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.ts";

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
export function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
	workflowResourceProvider: WorkflowResourceProviderInput = emptyWorkflowResourceProvider,
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
): { api: ExtensionAPI; commit: () => void; discard: () => void } {
	const workflowResources = normalizeWorkflowResourceProvider(workflowResourceProvider);
	const pendingRuntimeChanges: Array<{ apply: () => void; rollback: () => void }> = [];
	const loadingUnsubscribers: Array<() => void> = [];
	const initialFlagValues = new Map(runtime.flagValues);
	const initialFlagOwners = new Map(runtime.flagOwners);
	const initialFlagOwnerOrigins = new Map(runtime.flagOwnerOrigins);
	let state: "loading" | "active" | "failed" = "loading";
	const assertActive = () => {
		if (state === "failed")
			throw new Error(`Extension "${extension.path}" failed to load and its API is no longer active.`);
		runtime.assertActive();
	};
	const applyRuntimeChange = (change: { apply: () => void; rollback: () => void }) => {
		if (state === "loading") pendingRuntimeChanges.push(change);
		else if (state === "active") change.apply();
		else assertActive();
	};
	// Successive load generations of one session each build a new facade over
	// the same shared bus; mapping the facade back to that bus lets
	// session-scoped state re-bind across module re-evaluation.
	const events: EventBus = {
		emit(channel, data) {
			assertActive();
			eventBus.emit(channel, data);
		},
		on(channel, handler) {
			assertActive();
			const unsubscribe = runtime.trackEventBusSubscription(eventBus.on(channel, handler));
			if (state === "loading") loadingUnsubscribers.push(unsubscribe);
			return unsubscribe;
		},
	};
	registerCanonicalEventBus(events, canonicalEventBusFor(eventBus));
	const api = {
		on(event: string, handler: HandlerFn): void {
			assertActive();
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			assertActive();
			if (runtime.canRegisterResource?.(extension, "tool", tool.name) === false) return;
			const registration = { definition: tool, sourceInfo: extension.sourceInfo };
			if (runtime.stageToolRegistration?.(extension, tool.name, registration)) return;
			extension.tools.set(tool.name, registration);
			if (runtime.refreshToolsAfterRegistration) runtime.refreshToolsAfterRegistration();
			else runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			assertActive();
			if (runtime.canRegisterResource?.(extension, "command", name) === false) return;
			const registration = { name, sourceInfo: extension.sourceInfo, ...options };
			if (runtime.stageCommandRegistration?.(extension, name, registration)) return;
			extension.commands.set(name, registration);
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: ExtensionContext) => Promise<void> | void;
			},
		): void {
			assertActive();
			if (runtime.canRegisterResource?.(extension, "shortcut", shortcut) === false) return;
			const registration = { shortcut, extensionPath: extension.path, ...options };
			if (runtime.stageShortcutRegistration?.(extension, shortcut, registration)) return;
			extension.shortcuts.set(shortcut, registration);
		},

		registerFlag(
			name: string,
			options: {
				description?: string;
				type: "boolean" | "string";
				default?: boolean | string;
			},
		): void {
			assertActive();
			if (options.default !== undefined && typeof options.default !== options.type) {
				throw new Error(
					`Invalid default for flag "${name}": expected ${options.type}, got ${typeof options.default}`,
				);
			}
			if (runtime.canRegisterResource?.(extension, "flag", name) === false) return;
			const registration = { name, extensionPath: extension.path, ...options };
			if (runtime.stageFlagRegistration?.(extension, name, registration, options.default)) return;
			extension.flags.set(name, registration);
			runtime.flagOwners ??= new Map();
			const flagOwners = runtime.flagOwners;
			runtime.flagOwnerOrigins ??= new Map();
			const flagOwnerOrigins = runtime.flagOwnerOrigins;
			if (!flagOwners.has(name)) {
				flagOwners.set(name, extension.path);
				flagOwnerOrigins.set(name, extension.sourceInfo.configurationOrigin);
			}
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				if (runtime.applyFlagDefaultAfterRegistration) {
					runtime.applyFlagDefaultAfterRegistration(
						name,
						extension.path,
						options.default,
						extension.sourceInfo.configurationOrigin,
					);
				} else {
					runtime.flagValues.set(name, options.default);
				}
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		registerMarkdownTransformer(transformer: MarkdownTransformer): void {
			assertActive();
			extension.markdownTransformer = transformer;
		},

		registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
			assertActive();
			extension.entryRenderers.set(customType, renderer as EntryRenderer);
		},

		getFlag(name: string): boolean | string | undefined {
			assertActive();
			const pendingDefault = runtime.getPendingFlagDefault?.(extension.path, name);
			if (!extension.flags.has(name) && pendingDefault === undefined) return undefined;
			return runtime.flagValues.get(name) ?? pendingDefault;
		},

		getWorkflowResources() {
			assertActive();
			return [...workflowResources.get()];
		},

		async refreshWorkflowResources() {
			assertActive();
			const refreshed = await workflowResources.refresh?.();
			return [...(refreshed ?? workflowResources.get())];
		},

		getResourceLoaderInheritanceSnapshot() {
			assertActive();
			return resourceLoaderInheritanceSnapshotProvider?.() ?? {};
		},

		sendMessage(message, options): void | Promise<void> {
			assertActive();
			return runtime.sendMessage(message, options);
		},

		sendMessages(messages, options): void | Promise<void> {
			assertActive();
			return runtime.sendMessages(messages, options);
		},

		sendUserMessage(content, options): Promise<void> {
			assertActive();
			return runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			assertActive();
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			assertActive();
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			assertActive();
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			assertActive();
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			assertActive();
			return runtime.getActiveToolsAfterRegistration?.(extension) ?? runtime.getActiveTools();
		},

		getAllTools() {
			assertActive();
			return runtime.getAllToolsAfterRegistration?.(extension) ?? runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			assertActive();
			if (!runtime.setActiveToolsAfterRegistration?.(extension, toolNames)) runtime.setActiveTools(toolNames);
		},

		getCommands() {
			assertActive();
			return runtime.getCommandsAfterRegistration?.(extension) ?? runtime.getCommands();
		},

		setModel(model) {
			assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			assertActive();
			runtime.setThinkingLevel(level);
		},

		registerProvider(nameOrProvider: string | Provider, config?: ProviderConfig) {
			assertActive();
			if (typeof nameOrProvider === "string") {
				if (!config) throw new Error("Provider config is required");
				const name = nameOrProvider;
				applyRuntimeChange({
					apply: () => runtime.registerProvider(name, config, extension.path),
					rollback: () => runtime.unregisterProvider(name, extension.path),
				});
			} else {
				const provider = nameOrProvider;
				applyRuntimeChange({
					apply: () => runtime.registerProvider(provider, extension.path),
					rollback: () => runtime.unregisterProvider(provider.id, extension.path),
				});
			}
		},

		unregisterProvider(name: string) {
			assertActive();
			const prior = runtime.pendingProviderRegistrations.filter((registration) =>
				"provider" in registration ? registration.provider.id === name : registration.name === name,
			);
			applyRuntimeChange({
				// Explicit unregistration stays name-wide: its rollback below
				// restores every prior registration, so a narrower removal here
				// would re-register entries that were never taken away.
				apply: () => runtime.unregisterProvider(name),
				rollback: () => {
					for (const registration of prior) {
						if ("provider" in registration) {
							runtime.registerProvider(registration.provider, registration.extensionPath);
						} else {
							runtime.registerProvider(registration.name, registration.config, registration.extensionPath);
						}
					}
				},
			});
		},

		events,
	} as ExtensionAPI;

	return {
		api,
		commit: () => {
			if (state !== "loading") return;
			const applied: Array<{ apply: () => void; rollback: () => void }> = [];
			try {
				for (const change of pendingRuntimeChanges) {
					change.apply();
					applied.push(change);
				}
				state = "active";
				pendingRuntimeChanges.length = 0;
				loadingUnsubscribers.length = 0;
			} catch (error) {
				for (const change of applied.reverse()) {
					try {
						change.rollback();
					} catch {
						// Best-effort undo of provider ops already applied in this commit.
					}
				}
				throw error;
			}
		},
		discard: () => {
			if (state !== "loading") return;
			state = "failed";
			for (const unsubscribe of loadingUnsubscribers) unsubscribe();
			pendingRuntimeChanges.length = 0;
			loadingUnsubscribers.length = 0;
			runtime.flagValues = initialFlagValues;
			runtime.flagOwners = initialFlagOwners;
			runtime.flagOwnerOrigins = initialFlagOwnerOrigins;
		},
	};
}
