import { basename, dirname } from "node:path";
import { resetApiProviders } from "@bastani/pi-ai/compat";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { recoverProtectedStreamingCustomMessages } from "./agent-session-persistent-custom-messages.ts";
import type { AgentSessionReloadOptions, ExtensionBindings } from "./agent-session-types.ts";
import { ExtensionRunner } from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ExtensionProviderTransaction, ModelRuntime } from "./model-runtime.js";
import type { PathMetadata } from "./package-manager.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { getSkillCatalog } from "./skill-catalog.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";

class ExtensionPublicationGate {
	readonly resourceLoader: ResourceLoader;
	private readonly effects: Array<() => void | Promise<void>> = [];
	readonly providerTransaction: ExtensionProviderTransaction;
	readonly providerIds = new Set<string>();
	private readonly runner: ExtensionRunner;
	private discarded = false;

	constructor(
		resourceLoader: ResourceLoader,
		runner: ExtensionRunner,
		modelRuntime: ModelRuntime,
		replacedProviderIds: Iterable<string>,
	) {
		this.resourceLoader = resourceLoader;
		this.runner = runner;
		this.providerTransaction = modelRuntime.createExtensionProviderTransaction(replacedProviderIds);
	}

	defer(effect: () => void | Promise<void>): void {
		if (!this.discarded) this.effects.push(effect);
	}

	async publishProviders(): Promise<void> {
		await this.providerTransaction.commit();
	}

	discard(): void {
		this.discarded = true;
		this.effects.length = 0;
	}

	async release(): Promise<void> {
		const effects = this.effects.splice(0);
		for (const effect of effects) {
			try {
				await effect();
			} catch (error) {
				this.report(error, "session_start");
			}
		}
	}

	private report(error: unknown, event: string): void {
		this.runner.emitError({
			extensionPath: "<runtime>",
			event,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function buildExtensionResourcePathsForLoader(
	session: AgentSession,
	loader: ResourceLoader,
	entries: Array<{ path: string; extensionPath: string }>,
): Array<{ path: string; metadata: PathMetadata }> {
	return entries.map((entry) => {
		const extension = loader
			.getExtensions()
			.extensions.find(
				(candidate) =>
					candidate.path === entry.extensionPath ||
					candidate.resolvedPath === entry.extensionPath ||
					candidate.sourceInfo.path === entry.extensionPath,
			);
		const sourceInfo = extension?.sourceInfo;
		return {
			path: entry.path,
			metadata: {
				source: sourceInfo?.source ?? session.getExtensionSourceLabel(entry.extensionPath),
				scope: sourceInfo?.scope ?? "temporary",
				origin: sourceInfo?.origin ?? "top-level",
				baseDir:
					sourceInfo?.baseDir ?? (entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath)),
				configurationOrigin: sourceInfo?.configurationOrigin,
			},
		};
	});
}

async function extendRunnerResources(
	session: AgentSession,
	runner: ExtensionRunner,
	loader: ResourceLoader,
	reason: "startup" | "reload",
): Promise<void> {
	if (!runner.hasHandlers("resources_discover")) return;
	const { skillPaths, promptPaths, themePaths } = await runner.emitResourcesDiscover(session._cwd, reason);
	if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) return;
	const extensionPaths: ResourceExtensionPaths = {
		skillPaths: buildExtensionResourcePathsForLoader(session, loader, skillPaths),
		promptPaths: buildExtensionResourcePathsForLoader(session, loader, promptPaths),
		themePaths: buildExtensionResourcePathsForLoader(session, loader, themePaths),
	};
	await loader.extendResources(extensionPaths);
}

export async function bindExtensions(this: AgentSession, bindings: ExtensionBindings): Promise<void> {
	if (bindings.uiContext !== undefined) {
		this._extensionUIContext = bindings.uiContext;
	}
	if (bindings.mode !== undefined) {
		this._extensionMode = bindings.mode;
	}
	if (bindings.commandContextActions !== undefined) {
		this._extensionCommandContextActions = bindings.commandContextActions;
	}
	if (bindings.shutdownHandler !== undefined) {
		this._extensionShutdownHandler = bindings.shutdownHandler;
	}
	if (bindings.onError !== undefined) {
		this._extensionErrorListener = bindings.onError;
	}

	this._applyExtensionBindings(this._extensionRunner);
	await this._extensionRunner.emit(this._sessionStartEvent);
	await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	if (recoverProtectedStreamingCustomMessages(this) > 0) {
		await this._continueQueuedAgentMessages();
	}
}

export async function extendResourcesFromExtensions(this: AgentSession, reason: "startup" | "reload"): Promise<void> {
	await extendRunnerResources(this, this._extensionRunner, this._resourceLoader, reason);
	this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
	this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
}

export function buildExtensionResourcePaths(
	this: AgentSession,
	entries: Array<{ path: string; extensionPath: string }>,
): Array<{
	path: string;
	metadata: PathMetadata;
}> {
	return buildExtensionResourcePathsForLoader(this, this._resourceLoader, entries);
}

export function getExtensionSourceLabel(this: AgentSession, extensionPath: string): string {
	if (extensionPath.startsWith("<")) {
		return `extension:${extensionPath.replace(/[<>]/g, "")}`;
	}
	const base = basename(extensionPath);
	const name = base.replace(/\.(ts|js)$/, "");
	return `extension:${name}`;
}

export function _applyExtensionBindings(this: AgentSession, runner: ExtensionRunner): void {
	runner.setUIContext(this._extensionUIContext, this._extensionMode);
	runner.bindCommandContext(this._extensionCommandContextActions);

	this._extensionErrorUnsubscriber?.();
	this._extensionErrorUnsubscriber = this._extensionErrorListener
		? runner.onError(this._extensionErrorListener)
		: undefined;
}

export function refreshCurrentModelFromRegistry(this: AgentSession): void {
	this._refreshCurrentModelFromRegistry();
}

export function _refreshCurrentModelFromRegistry(this: AgentSession): void {
	const currentModel = this.model;
	if (!currentModel) {
		return;
	}

	const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
	if (!refreshedModel || refreshedModel === currentModel) {
		return;
	}

	const previousModel = currentModel;
	const previousThinkingLevel = this.thinkingLevel;
	this.agent.state.model = refreshedModel;
	this.setThinkingLevel(previousThinkingLevel);
	this._refreshBaseSystemPromptFromActiveTools();
	this._emit({ type: "model_changed", model: refreshedModel, previousModel, source: "restore" });
}

export function _bindExtensionCore(
	this: AgentSession,
	runner: ExtensionRunner,
	publication?: ExtensionPublicationGate,
): void {
	const getCommands = (): SlashCommandInfo[] => {
		const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
			name: command.invocationName,
			description: command.description,
			source: "extension",
			sourceInfo: command.sourceInfo,
		}));

		const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
			name: template.name,
			description: template.description,
			source: "prompt",
			sourceInfo: template.sourceInfo,
		}));

		const skills: SlashCommandInfo[] = getSkillCatalog(
			publication?.resourceLoader ?? this._resourceLoader,
		).commands.map((command) => ({
			name: `skill:${command.name}`,
			description: command.description,
			source: "skill",
			sourceInfo: command.sourceInfo,
		}));

		return [...extensionCommands, ...templates, ...skills];
	};

	runner.bindCore(
		{
			sendMessage: (message, options) => {
				if (publication) {
					publication.defer(() => this.sendCustomMessage(message, options));
					return Promise.resolve();
				}
				const delivery = this.sendCustomMessage(message, options);
				void delivery.catch((err) => {
					runner.emitError({
						extensionPath: "<runtime>",
						event: "send_message",
						error: err instanceof Error ? err.message : String(err),
					});
				});
				return delivery;
			},
			sendMessages: (messages, options) => {
				if (publication) {
					publication.defer(() => this.sendCustomMessages(messages, options));
					return Promise.resolve();
				}
				const delivery = this.sendCustomMessages(messages, options);
				void delivery.catch((err) => {
					runner.emitError({
						extensionPath: "<runtime>",
						event: "send_messages",
						error: err instanceof Error ? err.message : String(err),
					});
				});
				return delivery;
			},
			sendUserMessage: (content, options) => {
				const send = () =>
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				if (publication) publication.defer(send);
				else void send();
			},
			appendEntry: (customType, data) => {
				const append = () => {
					const id = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(id);
					if (entry) this._emit({ type: "entry_appended", entry });
				};
				if (publication) publication.defer(append);
				else append();
			},
			setSessionName: (name) => {
				if (publication) publication.defer(() => this.setSessionName(name));
				else this.setSessionName(name);
			},
			getSessionName: () => {
				return this.sessionManager.getSessionName();
			},
			setLabel: (entryId, label) => {
				if (publication) {
					publication.defer(() => {
						this.sessionManager.appendLabelChange(entryId, label);
					});
				} else this.sessionManager.appendLabelChange(entryId, label);
			},
			getActiveTools: () => this.getActiveToolNames(),
			getAllTools: () => this.getAllTools(),
			setActiveTools: (toolNames) => {
				if (publication) publication.defer(() => this.setActiveToolsByName(toolNames));
				else this.setActiveToolsByName(toolNames);
			},
			refreshTools: () => {
				if (!publication) this._refreshToolRegistry();
			},
			getCommands,
			setModel: async (model) => {
				const hasConfiguredAuth =
					publication?.providerTransaction.hasConfiguredAuth(model.provider) ??
					this.modelRuntime.hasConfiguredAuth(model.provider);
				if (!hasConfiguredAuth) return false;
				if (publication) publication.defer(() => this.setModel(model));
				else await this.setModel(model);
				return true;
			},
			getThinkingLevel: () => this.thinkingLevel,
			setThinkingLevel: (level) => {
				if (publication) publication.defer(() => this.setThinkingLevel(level));
				else this.setThinkingLevel(level);
			},
		},
		{
			getModel: () => this.model,
			// Read through the public accessor, not `_scopedModels`: in the isolated
			// engine the host-side facade session has `scopedModels` redefined by
			// RemoteModelCatalog to the engine's catalogue, and the private field it
			// shadows is never refreshed.
			getScopedModels: () => this.scopedModels,
			getThinkingLevel: () => this.thinkingLevel,
			isIdle: () => !this.isStreaming,
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
			getSignal: () => this.agent.signal,
			abort: () => {
				if (publication) publication.defer(() => this.abort());
				else this.abort();
			},
			hasPendingMessages: () => this.pendingMessageCount > 0,
			shutdown: () => {
				if (publication) publication.defer(() => this._extensionShutdownHandler?.());
				else this._extensionShutdownHandler?.();
			},
			getContextUsage: () => this.getContextUsage(),
			compact: (options) => {
				const compact = async () => {
					try {
						const result = await this.compact({
							...(options?.compression_ratio === undefined
								? {}
								: { compression_ratio: options.compression_ratio }),
							...(options?.preserve_recent === undefined ? {} : { preserve_recent: options.preserve_recent }),
							...(options?.query === undefined ? {} : { query: options.query }),
						});
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				};
				if (publication) publication.defer(compact);
				else void compact();
			},
			getSystemPrompt: () => this.systemPrompt,
			getSkillCatalog: () => getSkillCatalog(publication?.resourceLoader ?? this._resourceLoader),
			getSystemPromptOptions: () => this._baseSystemPromptOptions,
		},
		{
			registerProvider: (providerOrName, config) => {
				const providerId = typeof providerOrName === "string" ? providerOrName : providerOrName.id;
				if (publication) {
					publication.providerIds.add(providerId);
					if (typeof providerOrName === "string") {
						publication.providerTransaction.registerProvider(providerOrName, config!);
					} else publication.providerTransaction.registerNativeProvider(providerOrName);
					return;
				}
				this._extensionProviderIds.add(providerId);
				this._resourceLoader.getExtensions().runtime.extensionProviderIds.add(providerId);
				if (typeof providerOrName === "string") this._modelRuntime.registerProvider(providerOrName, config!);
				else this._modelRuntime.registerNativeProvider(providerOrName);
				this.refreshCurrentModelFromRegistry();
			},
			unregisterProvider: (name) => {
				if (publication) {
					publication.providerIds.delete(name);
					publication.providerTransaction.unregisterProvider(name);
				} else {
					this._extensionProviderIds.delete(name);
					this._resourceLoader.getExtensions().runtime.extensionProviderIds.delete(name);
					this._modelRuntime.unregisterProvider(name);
					this.refreshCurrentModelFromRegistry();
				}
			},
		},
	);
}

export async function reload(this: AgentSession, options?: AgentSessionReloadOptions): Promise<void> {
	const reason = options?.reason ?? "reload";
	const oldRunner = this._extensionRunner;
	const previousFlagValues = oldRunner.getExplicitFlagValues();
	const activeToolNames = this.getActiveToolNames();
	const prepareResourceReload = this._resourceLoader.prepareReload?.bind(this._resourceLoader);
	if (prepareResourceReload === undefined || this._resourceLoader.supportsTransactionalReload?.() === false) {
		if (options?.failOnExtensionErrors) {
			throw new Error("Strict extension reload requires a transactional resource loader");
		}
		if (reason === "reload")
			await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		await this.settingsManager.reload();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({ activeToolNames, flagValues: previousFlagValues, includeAllExtensionTools: true });
		await options?.beforeSessionStart?.();
		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await this._extensionRunner.emit({ type: "session_start", reason });
			await this.extendResourcesFromExtensions(reason);
		}
		return;
	}

	const settingsTransaction = await this.settingsManager.prepareReload();
	const resourceTransaction = await prepareResourceReload(settingsTransaction.settingsManager);
	const errors = resourceTransaction.loader.getExtensions().errors;
	if (options?.failOnExtensionErrors && errors.length > 0) {
		throw new Error(`Failed to load extensions: ${errors.map(({ path, error }) => `${path}: ${error}`).join("; ")}`);
	}
	const extensionsResult = resourceTransaction.loader.getExtensions();
	for (const [name, value] of previousFlagValues) {
		extensionsResult.runtime.flagValues.set(name, value);
		extensionsResult.runtime.explicitFlagNames ??= new Set();
		extensionsResult.runtime.explicitFlagNames.add(name);
	}
	const candidateRunner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		this._cwd,
		this.sessionManager,
		new ModelRegistry(this._modelRuntime),
		this._orchestrationContext,
		this._subagentPolicy,
	);
	const publication = new ExtensionPublicationGate(
		resourceTransaction.loader,
		candidateRunner,
		this._modelRuntime,
		this._extensionProviderIds,
	);
	let commitPreparedResources: (() => void) | undefined;
	let rollbackPreparedResources: (() => void) | undefined;
	try {
		this._bindExtensionCore(candidateRunner, publication);
		candidateRunner.setUIContext(this._extensionUIContext, this._extensionMode);
		candidateRunner.bindCommandContext(this._extensionCommandContextActions);
		await options?.beforeSessionStart?.();
		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await candidateRunner.emit({ type: "session_start", reason });
			await extendRunnerResources(this, candidateRunner, resourceTransaction.loader, reason);
		}
		const preparedResources = resourceTransaction.prepareCommit?.();
		if (preparedResources) {
			commitPreparedResources = () => preparedResources.commit();
			rollbackPreparedResources = () => preparedResources.rollback();
		}
		await publication.publishProviders();
	} catch (error) {
		rollbackPreparedResources?.();
		publication.discard();
		candidateRunner.invalidate();
		throw error;
	}

	settingsTransaction.commit();
	resourceTransaction.activate(this.settingsManager);
	if (commitPreparedResources) commitPreparedResources();
	else resourceTransaction.commit();
	resetApiProviders();
	this._extensionProviderIds = new Set(publication.providerIds);
	extensionsResult.runtime.extensionProviderIds = new Set(publication.providerIds);
	this.refreshCurrentModelFromRegistry();
	this._buildRuntime({ activeToolNames, flagValues: previousFlagValues, includeAllExtensionTools: true });
	if (reason === "reload") await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
	oldRunner.invalidate();
	await publication.release();
}

// =========================================================================
// Auto-Retry
// =========================================================================

/**
 * Check if an error is retryable (overloaded, rate limit, server errors).
 * Context overflow errors are NOT retryable (handled by compaction instead).
 */

export const agentSessionExtensionBindingsMethods = {
	bindExtensions,
	extendResourcesFromExtensions,
	buildExtensionResourcePaths,
	getExtensionSourceLabel,
	_applyExtensionBindings,
	refreshCurrentModelFromRegistry,
	_refreshCurrentModelFromRegistry,
	_bindExtensionCore,
	reload,
};
