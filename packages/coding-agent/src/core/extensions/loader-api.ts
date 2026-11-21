import type { Provider } from "@bastani/atomic-ai";
import type { KeyId } from "@bastani/atomic-tui";
import { type AsyncScope, asyncScope } from "../async-scope.ts";
import { canonicalEventBusFor, type EventBus, registerCanonicalEventBus } from "../event-bus.js";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import { getNativeMcpToolIdentity, markNativeMcpToolDefinition } from "../mcp-child-policy.ts";
import type { McpServerConfig, McpServerContribution } from "../mcp-servers.ts";
import { lifecycleScopeForOwner } from "../session-lifecycle-scope.ts";
import { drainSessionWork, hasCallingSessionWork, trackSessionWork } from "../session-lifecycle-work.ts";
import { checkedCustomMessage, checkedCustomType, checkedLabel } from "../session-manager-entries.ts";
import type { AgentPanelSource } from "../tasks/agent-panel-source.ts";
import {
	assertExtensionAction,
	extensionWorkOpen,
	inExtensionCleanup,
	isRetiredExtensionCleanup,
	onExtensionSessionQuit,
	trackExtensionWork,
} from "./extension-work.ts";
import { hostInputError } from "./host-input.js";
import {
	captureRegistrationInvocation as captureInvocation,
	invocationExtension,
	invocationRuntime,
	originalRegistrationCallback,
	registerFactoryStartupHandler,
	resolveInvocationRuntime,
	startupSourceId,
} from "./loader-bindings.ts";
import type { PackageMcpServerSource, ResourceLoaderInheritanceSnapshotProvider } from "./loader-resources.ts";
import { boundExtensionRuntimes } from "./loader-runtime.ts";
import { STALE_EXTENSION_CONTEXT_MESSAGE } from "./stale-context.ts";
import { projectTrustHandlerRegistered } from "./startup-trust-inventory.ts";
import type {
	EntryRenderer,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionRuntime,
	MarkdownMessageType,
	MarkdownTransformer,
	MarkdownTransformerOptions,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
	ToolRendererResolver,
} from "./types.ts";

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

const DEFAULT_MARKDOWN_MESSAGE_TYPES: readonly MarkdownMessageType[] = ["user", "assistant", "assistant-thinking"];

const apiLifetime = Symbol.for("atomic.extension-api-lifetime.v1");
type ExtensionWithLifetime = Extension & {
	[apiLifetime]?: { retired: boolean; releases: Set<() => void>; cleanup?: AsyncScope<{ active: boolean }> };
};

/** Factory receipts must not include selected siblings sharing the runtime. */
export async function drainExtensionAPIWork(extension: Extension): Promise<void> {
	const lifetime = (extension as ExtensionWithLifetime)[apiLifetime];
	if (lifetime) await drainSessionWork(lifetime);
}

export function sealExtensionAPI(extension: Extension): boolean {
	const lifetime = (extension as ExtensionWithLifetime)[apiLifetime];
	if (lifetime?.retired) return false;
	if (lifetime) lifetime.cleanup ??= asyncScope<{ active: boolean }>();
	return true;
}

/** Seal one unadopted factory without sealing its selected siblings' runtime. */
export async function runExtensionAPICleanup(extension: Extension, operation: () => Promise<void>): Promise<void> {
	const lifetime = (extension as ExtensionWithLifetime)[apiLifetime];
	if (!lifetime) return operation();
	lifetime.cleanup ??= asyncScope<{ active: boolean }>();
	const scope = { active: true };
	try {
		await lifetime.cleanup.run(scope, operation);
	} finally {
		scope.active = false;
	}
}

/** Retire one factory without invalidating a runtime shared with selected factories. */
export function retireExtensionAPI(extension: Extension): void {
	const lifetime = (extension as ExtensionWithLifetime)[apiLifetime];
	if (!lifetime || lifetime.retired) return;
	lifetime.retired = true;
	const failures: unknown[] = [];
	for (const release of lifetime.releases) {
		try {
			release();
		} catch (error) {
			failures.push(error);
		}
	}
	lifetime.releases.clear();
	if (failures.length) throw new AggregateError(failures, "Extension subscription retirement failed");
}

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
	packageSource?: PackageMcpServerSource,
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
	registrationSource: object | string = extension,
): { api: ExtensionAPI; commit: () => void; discard: () => void } {
	const originalRuntime = runtime;
	const startupOwner = startupSourceId(registrationSource);
	(extension as ExtensionWithLifetime)[apiLifetime] = { retired: false, releases: new Set() };
	const captureRegistrationInvocation = <T>(value: T): T => captureInvocation(value, originalRuntime);
	runtime = invocationRuntime(runtime);
	extension = invocationExtension(extension);
	if (packageSource) originalRuntime.mcpServerRegistry.addPackageSource(packageSource);
	const pendingRuntimeChanges: Array<{ apply: () => void; rollback: () => void }> = [];
	const loadingUnsubscribers: Array<() => void> = [];
	const nextStartupHandlerSlot = new Map<string, number>();
	const initialFlagValues = new Map(runtime.flagValues);
	const initialFlagOwners = new Map(runtime.flagOwners);
	const initialFlagOwnerOrigins = new Map(runtime.flagOwnerOrigins);
	let state: "loading" | "active" | "failed" = "loading";
	const assertActive = (inspection = false) => {
		const lifetime = (extension as ExtensionWithLifetime)[apiLifetime];
		if (lifetime?.retired) throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
		if (lifetime?.cleanup && !lifetime.cleanup.getStore()?.active && !hasCallingSessionWork(lifetime))
			throw hostInputError("SessionClosed");
		if (state === "failed")
			throw new Error(`Extension "${extension.path}" failed to load and its API is no longer active.`);
		runtime.assertActive();
		if (!inspection) assertExtensionAction(resolveInvocationRuntime(originalRuntime));
	};
	const trackAPIWork = <T>(operation: () => Promise<T>): Promise<T> => {
		const lifetime = (extension as ExtensionWithLifetime)[apiLifetime]!;
		return trackExtensionWork(resolveInvocationRuntime(originalRuntime), () => trackSessionWork(lifetime, operation));
	};
	const applyRuntimeChange = (change: { apply: () => void; rollback: () => void }) => {
		if (state === "loading") pendingRuntimeChanges.push(change);
		else if (state === "active") change.apply();
		else assertActive();
	};
	// Both ownership ledgers must forget a completed release, including on throw.
	// Clearing the capture also makes a retained public unsubscribe handle harmless.
	const trackRelease = (cleanup: () => void): (() => void) => {
		const lifetime = (extension as ExtensionWithLifetime)[apiLifetime];
		let pending: (() => void) | undefined = cleanup;
		const release = runtime.trackEventBusSubscription(() => {
			const callback = pending;
			pending = undefined;
			lifetime?.releases.delete(release);
			callback?.();
		});
		lifetime?.releases.add(release);
		if (state === "loading") loadingUnsubscribers.push(release);
		return release;
	};
	// Successive load generations of one session each build a new facade over
	// the same shared bus; mapping the facade back to that bus lets
	// session-scoped state re-bind across module re-evaluation.
	const events: EventBus = {
		emit(channel, data) {
			if (isRetiredExtensionCleanup(resolveInvocationRuntime(originalRuntime))) return;
			assertActive();
			eventBus.emit(channel, data);
		},
		on(channel, handler) {
			const ownerRuntime = resolveInvocationRuntime(originalRuntime);
			const ownerLifetime = (extension as ExtensionWithLifetime)[apiLifetime];
			const deliver = captureRegistrationInvocation(handler);
			assertActive();
			const unsubscribe = trackRelease(
				eventBus.on(channel, (data) => {
					if (ownerLifetime?.retired || ownerLifetime?.cleanup || !extensionWorkOpen(ownerRuntime)) return;
					if (state === "loading" || boundExtensionRuntimes.has(ownerRuntime))
						return trackExtensionWork(ownerRuntime, () =>
							trackSessionWork(ownerLifetime!, async () => deliver(data)),
						);
				}),
			);
			return unsubscribe;
		},
	};
	registerCanonicalEventBus(events, canonicalEventBusFor(eventBus));
	// Capture explicit creation/reload lineage before invocation leaves its construction scope.
	lifecycleScopeForOwner(originalRuntime);
	const api = {
		get lifecycleScope() {
			return lifecycleScopeForOwner(resolveInvocationRuntime(originalRuntime));
		},
		registerAgentPanelSource(source: AgentPanelSource) {
			assertActive();
			const registration = runtime.agentPanelSourceHub.register(source);
			return { dispose: trackRelease(() => registration.dispose()) };
		},
		on(event: string, handler: HandlerFn): () => void {
			assertActive();
			const registeredHandler = captureRegistrationInvocation((...args: Parameters<HandlerFn>) => handler(...args));
			if (event === "session_start" || event === "resources_discover") {
				const slot = nextStartupHandlerSlot.get(event) ?? 0;
				nextStartupHandlerSlot.set(event, slot + 1);
				registerFactoryStartupHandler(registeredHandler, startupOwner, event, slot);
			}
			const list = extension.handlers.get(event) ?? [];
			list.push(registeredHandler);
			const handlers = extension.handlers;
			handlers.set(event, list);
			if (event === "project_trust")
				projectTrustHandlerRegistered(resolveInvocationRuntime(originalRuntime), handlers);
			return () => {
				const handlers = extension.handlers.get(event);
				if (!handlers) return;
				const index = handlers.findIndex(
					(candidate) =>
						originalRegistrationCallback(candidate) === originalRegistrationCallback(registeredHandler),
				);
				if (index === -1) return;
				handlers.splice(index, 1);
				if (handlers.length === 0) extension.handlers.delete(event);
			};
		},

		registerTool(tool: ToolDefinition): void {
			assertActive();
			if (runtime.canRegisterResource?.(extension, "tool", tool.name) === false) return;
			if (typeof tool.parameters !== "object" || tool.parameters === null || Array.isArray(tool.parameters)) {
				throw new Error(
					`Tool "${tool.name}" registered by extension "${extension.path}" must define an object parameter schema.`,
				);
			}
			const registration = { definition: captureRegistrationInvocation(tool), sourceInfo: extension.sourceInfo };
			const nativeMcpIdentity = getNativeMcpToolIdentity(tool);
			if (nativeMcpIdentity) markNativeMcpToolDefinition(registration.definition, nativeMcpIdentity);
			if (extension.tools.has(tool.name)) {
				extension.duplicateToolNames ??= new Set();
				extension.duplicateToolNames.add(tool.name);
			}
			if (runtime.stageToolRegistration?.(extension, tool.name, registration)) return;
			extension.tools.set(tool.name, registration);
			if (runtime.refreshToolsAfterRegistration) runtime.refreshToolsAfterRegistration();
			else runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			assertActive();
			if (typeof name !== "string" || name.length === 0) {
				throw new Error(
					`Command registered by extension "${extension.path}" must have a non-empty string name. Use pi.registerCommand("name", { description, handler }).`,
				);
			}
			if (typeof options?.handler !== "function") {
				throw new Error(`Command "/${name}" registered by extension "${extension.path}" must define handler().`);
			}
			if (runtime.canRegisterResource?.(extension, "command", name) === false) return;
			const registration = { name, sourceInfo: extension.sourceInfo, ...captureRegistrationInvocation(options) };
			if (runtime.stageCommandRegistration?.(extension, name, registration)) return;
			extension.commands.set(name, registration);
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				keybinding?: import("../keybindings.ts").Keybinding;
				preferEditor?: boolean;
				handler: (ctx: ExtensionContext) => Promise<void> | void;
			},
		): void {
			assertActive();
			if (runtime.canRegisterResource?.(extension, "shortcut", shortcut) === false) return;
			const registration = { shortcut, extensionPath: extension.path, ...captureRegistrationInvocation(options) };
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
			extension.messageRenderers.set(customType, captureRegistrationInvocation(renderer) as MessageRenderer);
		},

		registerMarkdownTransformer(transformer: MarkdownTransformer, options?: MarkdownTransformerOptions): void {
			assertActive();
			extension.markdownTransformer = captureRegistrationInvocation({
				transformer,
				messageTypes: new Set(options?.messageTypes ?? DEFAULT_MARKDOWN_MESSAGE_TYPES),
			});
		},

		registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
			assertActive();
			extension.entryRenderers.set(customType, captureRegistrationInvocation(renderer) as EntryRenderer);
		},

		registerToolRenderer(resolver: ToolRendererResolver): void {
			assertActive();
			extension.toolRenderers ??= [];
			extension.toolRenderers.push(
				captureRegistrationInvocation((toolName, next) => captureRegistrationInvocation(resolver(toolName, next))),
			);
		},

		getFlag(name: string): boolean | string | undefined {
			assertActive(true);
			const pendingDefault = runtime.getPendingFlagDefault?.(extension.path, name);
			if (!extension.flags.has(name) && pendingDefault === undefined) return undefined;
			return runtime.flagValues.get(name) ?? pendingDefault;
		},

		registerMcpServer(name: string, config: McpServerConfig): void {
			assertActive();
			if (typeof name !== "string" || name.trim() === "") {
				throw new Error(`MCP server registered by extension "${extension.path}" must have a non-empty name.`);
			}
			if (typeof config !== "object" || config === null || Array.isArray(config)) {
				throw new Error(`MCP server "${name}" registered by extension "${extension.path}" must be an object.`);
			}
			const contribution: McpServerContribution = {
				name,
				config: { ...config },
				origin: "extension",
				sourceInfo: extension.sourceInfo,
			};
			let previous: McpServerContribution | undefined;
			applyRuntimeChange({
				apply: () => {
					previous = runtime.mcpServerRegistry.register(contribution);
				},
				rollback: () => runtime.mcpServerRegistry.restore(name, previous),
			});
		},

		getMcpServerContributions() {
			assertActive(true);
			return runtime.mcpServerRegistry.list();
		},

		onMcpServerContributionsChanged(listener: () => void) {
			const ownerRuntime = resolveInvocationRuntime(originalRuntime);
			const ownerLifetime = (extension as ExtensionWithLifetime)[apiLifetime];
			const deliver = captureRegistrationInvocation(listener);
			assertActive();
			return trackRelease(
				ownerRuntime.mcpServerRegistry.subscribe(() => {
					if (ownerLifetime?.retired || ownerLifetime?.cleanup || !extensionWorkOpen(ownerRuntime)) return;
					if (state !== "loading" && !boundExtensionRuntimes.has(ownerRuntime)) return;
					void trackExtensionWork(ownerRuntime, () =>
						trackSessionWork(ownerLifetime!, async () => deliver()),
					).catch((error: Error) => {
						console.error(`MCP server contribution listener error (${extension.path}):`, error);
					});
				}),
			);
		},

		getResourceLoaderInheritanceSnapshot() {
			assertActive(true);
			return resourceLoaderInheritanceSnapshotProvider?.() ?? {};
		},
		getChildSessionOptions(options) {
			assertActive();
			return runtime.getChildSessionOptions?.(options) ?? options;
		},
		getStorageAgentDir() {
			assertActive(true);
			return runtime.storageAgentDir;
		},

		sendMessage(message, options): void | Promise<void> {
			assertActive();
			return runtime.sendMessage(checkedCustomMessage(message), options);
		},

		sendMessages(messages, options): void | Promise<void> {
			assertActive();
			return runtime.sendMessages(
				messages.map((message) => checkedCustomMessage(message)),
				options,
			);
		},

		sendUserMessage(content, options): void {
			assertActive();
			runtime.sendUserMessage(content, options);
		},

		async appendEntry<T>(customType: string, data?: T): Promise<void> {
			assertActive();
			checkedCustomType(customType, "custom entry");
			await trackAPIWork(() => runtime.appendEntry(customType, data));
		},

		async setSessionName(name: string): Promise<void> {
			assertActive();
			await runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			assertActive(true);
			return runtime.getSessionName();
		},

		async setLabel(entryId: string, label: string | undefined): Promise<void> {
			assertActive();
			checkedLabel(label);
			await runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			assertActive();
			// A command started before its session quits ends with the quit, so it cannot keep the session's shutdown
			// handlers from running. One a shutdown handler starts runs to its end.
			const ownerRuntime = resolveInvocationRuntime(originalRuntime);
			const lifetime = (extension as ExtensionWithLifetime)[apiLifetime];
			const onQuit =
				inExtensionCleanup(ownerRuntime) || lifetime?.cleanup?.getStore()?.active
					? undefined
					: (stop: () => void) => onExtensionSessionQuit(ownerRuntime, stop);
			return trackAPIWork(() => execCommand(command, args, options?.cwd ?? cwd, options, onQuit));
		},

		getSettings() {
			assertActive(true);
			return runtime.getSettings?.() ?? {};
		},

		getActiveTools(): string[] {
			assertActive(true);
			return runtime.getActiveToolsAfterRegistration?.(extension) ?? runtime.getActiveTools();
		},

		getAllTools() {
			assertActive(true);
			return runtime.getAllToolsAfterRegistration?.(extension) ?? runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			assertActive();
			if (!runtime.setActiveToolsAfterRegistration?.(extension, toolNames)) runtime.setActiveTools(toolNames);
		},

		getCommands() {
			assertActive(true);
			return runtime.getCommandsAfterRegistration?.(extension) ?? runtime.getCommands();
		},

		setModel(model) {
			assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			assertActive(true);
			return runtime.getThinkingLevel();
		},

		async setThinkingLevel(level) {
			assertActive();
			await runtime.setThinkingLevel(level);
		},

		async registerProviderAlias({ id, name, provider }) {
			await api.registerProvider(id, { aliasOf: provider, name });
		},

		async registerProvider(nameOrProvider: string | Provider, config?: ProviderConfig): Promise<void> {
			assertActive();
			if (typeof nameOrProvider === "string" && !config) throw new Error("Provider config is required");
			if (state === "loading") {
				const providerId = typeof nameOrProvider === "string" ? nameOrProvider : nameOrProvider.id;
				applyRuntimeChange({
					apply: () => {
						if (typeof nameOrProvider === "string")
							runtime.registerProvider(nameOrProvider, config!, extension.path);
						else runtime.registerProvider(nameOrProvider, extension.path);
					},
					rollback: () => {
						runtime.unregisterProvider(providerId, extension.path);
					},
				});
				return;
			}
			if (typeof nameOrProvider === "string")
				await runtime.registerProvider(nameOrProvider, config!, extension.path);
			else await runtime.registerProvider(nameOrProvider, extension.path);
		},

		async unregisterProvider(name: string): Promise<void> {
			assertActive();
			if (state !== "loading") {
				await runtime.unregisterProvider(name);
				return;
			}
			let prior = originalRuntime.pendingProviderRegistrations;
			applyRuntimeChange({
				apply: () => {
					prior = originalRuntime.pendingProviderRegistrations;
					originalRuntime.pendingProviderRegistrations = prior.filter(
						(entry) => ("provider" in entry ? entry.provider.id : entry.name) !== name,
					);
				},
				rollback: () => {
					originalRuntime.pendingProviderRegistrations = prior;
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
			const failures: unknown[] = [];
			for (const unsubscribe of loadingUnsubscribers) {
				try {
					unsubscribe();
				} catch (error) {
					failures.push(error);
				}
			}
			pendingRuntimeChanges.length = 0;
			loadingUnsubscribers.length = 0;
			runtime.flagValues = initialFlagValues;
			runtime.flagOwners = initialFlagOwners;
			runtime.flagOwnerOrigins = initialFlagOwnerOrigins;
			if (failures.length) throw new AggregateError(failures, "Extension subscription rollback failed");
		},
	};
}
