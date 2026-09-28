import { basename, dirname } from "node:path";
import { resetApiProviders } from "@bastani/pi-ai/compat";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { recoverProtectedStreamingCustomMessages } from "./agent-session-persistent-custom-messages.ts";
import { replaceSessionTaskOwner } from "./agent-session-tasks.js";
import type { AgentSessionReloadOptions, ExtensionBindings } from "./agent-session-types.js";
import { hostInputError } from "./extensions/host-input.js";
import { ExtensionRunner } from "./extensions/index.js";
import {
	factoryAcquisitions,
	factoryRollbackError,
	rollbackFactoryAcquisitions,
} from "./extensions/loader-rollback.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { bindExtensionContextPublication } from "./extensions/runner-context.ts";
import type { ExtensionRuntime } from "./extensions/types.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ExtensionProviderTransaction, ModelRuntime } from "./model-runtime.js";
import type { PathMetadata } from "./package-manager.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import {
	abortSessionWork,
	assertSessionOpen,
	drainSessionWork,
	hasSessionReload,
	renewSessionWork,
	retireSessionReloadGeneration,
	sessionGenerationClosing,
	trackSessionReload,
	trackSessionWork,
} from "./session-lifecycle-work.ts";
import { completeStartup, rollbackStartup } from "./session-startup-rollback.ts";
import { getSkillCatalog } from "./skill-catalog.ts";
import type { SlashCommandInfo } from "./slash-commands.js";

class ExtensionPublicationGate {
	readonly resourceLoader: ResourceLoader;
	private readonly effects: Array<() => void | Promise<void>> = [];
	private readonly startEffects: Array<() => void | Promise<void>> = [];
	readonly providerTransaction: ExtensionProviderTransaction;
	readonly providerIds = new Set<string>();
	private readonly isClosed: () => boolean;
	private readonly runner: ExtensionRunner;
	private discarded = false;

	constructor(
		resourceLoader: ResourceLoader,
		runner: ExtensionRunner,
		modelRuntime: ModelRuntime,
		isClosed: () => boolean,
		replacedProviderIds: Iterable<string>,
	) {
		this.isClosed = isClosed;
		this.resourceLoader = resourceLoader;
		this.runner = runner;
		this.providerTransaction = modelRuntime.createExtensionProviderTransaction(replacedProviderIds);
	}

	defer(effect: () => void | Promise<void>): void {
		if (!this.discarded) this.effects.push(effect);
	}

	stageStart(effect: () => void | Promise<void>): void {
		if (!this.discarded) this.startEffects.push(effect);
	}

	async activateStarts(): Promise<void> {
		await this.publish(this.startEffects);
	}

	async publishProviders(): Promise<void> {
		await this.providerTransaction.commit();
	}

	discard(): void {
		this.discarded = true;
		this.effects.length = 0;
		this.startEffects.length = 0;
	}

	async release(): Promise<void> {
		await this.publish(this.effects);
	}

	private async publish(effects: Array<() => void | Promise<void>>): Promise<void> {
		if (this.isClosed()) throw hostInputError("SessionClosed");
		for (const effect of effects.splice(0)) {
			try {
				await effect();
			} catch (error) {
				this.report(error, "session_start");
			}
			if (this.isClosed()) throw hostInputError("SessionClosed");
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
	if (session._disposed) throw hostInputError("SessionClosed");
	if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) return;
	const extensionPaths: ResourceExtensionPaths = {
		skillPaths: buildExtensionResourcePathsForLoader(session, loader, skillPaths),
		promptPaths: buildExtensionResourcePathsForLoader(session, loader, promptPaths),
		themePaths: buildExtensionResourcePathsForLoader(session, loader, themePaths),
	};
	await loader.extendResources(extensionPaths);
}

const extensionStarts = new WeakMap<ExtensionRunner, Promise<void>>();
const failedExtensionStarts = new WeakSet<ExtensionRunner>();
// Binding intent is session-local and survives runner reloads, even when a host object is reused.
const humanInputBindingRevisions = new WeakMap<AgentSession, number>();

function startExtensions(
	session: AgentSession,
	runner: ExtensionRunner,
	loader: ResourceLoader,
	event: AgentSession["_sessionStartEvent"],
	finalize?: () => Promise<void>,
): Promise<void> {
	const existing = extensionStarts.get(runner);
	if (existing) return finalize ? existing.then(finalize) : existing;
	const start = trackSessionWork(session, () =>
		Promise.resolve().then(async () => {
			const failures: Error[] = [];
			const unsubscribe = runner.onError((error) => {
				if (error.event === "session_start" || error.event === "resources_discover") {
					failures.push(new Error(`${error.extensionPath}: ${error.error}`));
				}
			});
			try {
				await runner.emit(event);
				await extendRunnerResources(session, runner, loader, event.reason === "reload" ? "reload" : "startup");
				if (failures.length) throw new AggregateError(failures, "Extension startup failed");
				await finalize?.();
				completeStartup(runner);
			} finally {
				unsubscribe();
			}
		}),
	).catch(async (error: unknown) => {
		failedExtensionStarts.add(runner);
		return rollbackStartup(runner, error instanceof Error ? error : new Error(String(error)), async (cause) => {
			try {
				if (!hasSessionReload(session)) await session.dispose();
			} catch (cleanupError) {
				throw Object.assign(new AggregateError([cause, cleanupError], "Extension startup and cleanup failed"), {
					code: "ShutdownFailed",
				});
			}
			throw cause;
		});
	});
	extensionStarts.set(runner, start);
	return start;
}

export async function bindExtensions(this: AgentSession, bindings: ExtensionBindings): Promise<void> {
	if (this._disposed) {
		// Failed creation retains its original rejection; it never admits another startup.
		if (failedExtensionStarts.has(this._extensionRunner)) return extensionStarts.get(this._extensionRunner)!;
		throw hostInputError("SessionClosed");
	}
	if (bindings.humanInput !== undefined) {
		this._extensionHumanInput = bindings.humanInput;
		humanInputBindingRevisions.set(this, (humanInputBindingRevisions.get(this) ?? 0) + 1);
	}
	if (bindings.onDiagnostic !== undefined) this._extensionDiagnosticListener = bindings.onDiagnostic;
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
	await startExtensions(this, this._extensionRunner, this._resourceLoader, this._sessionStartEvent, async () => {
		if (this._disposed) throw hostInputError("SessionClosed");
		this._rebuildSystemPrompt(this.getActiveToolNames());
		if (recoverProtectedStreamingCustomMessages(this) > 0) {
			await this._continueQueuedAgentMessages();
		}
	});
}

export async function extendResourcesFromExtensions(this: AgentSession, reason: "startup" | "reload"): Promise<void> {
	assertSessionOpen(this);
	return trackSessionWork(this, async () => {
		await extendRunnerResources(this, this._extensionRunner, this._resourceLoader, reason);
		assertSessionOpen(this);
		this._rebuildSystemPrompt(this.getActiveToolNames());
	});
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
	runner.setHostBindings(
		this._extensionHumanInput,
		this._extensionDiagnosticListener,
		humanInputBindingRevisions.get(this),
	);
	runner.setUIContext(this._extensionUIContext, this._extensionMode);
	runner.bindCommandContext(this._extensionCommandContextActions);
	runner.bindChildSessionOptions(this._childSessionOptions);

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
	runner.bindWorkOwner(this);
	bindExtensionContextPublication(runner.createContext(), publication && ((effect) => publication.stageStart(effect)));
	runner.bindTaskHost(() => this.getAgentTaskHost());
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
			getRouterModel: () => this.settingsManager.getRouterModel(),
			getModelRouting: () => this.settingsManager.getModelRouting(),
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
	if (this._disposed || sessionGenerationClosing.has(this) || hasSessionReload(this))
		throw hostInputError("SessionClosed");
	sessionGenerationClosing.add(this);
	return trackSessionReload(this, () => reloadAdmitted.call(this, options));
}

async function reloadAdmitted(this: AgentSession, options?: AgentSessionReloadOptions): Promise<void> {
	const retiringRunner = this._extensionRunner;
	try {
		abortSessionWork(this);
		this.abortBash();
		this._extensionRunner.sealHostInput();
		if (this.isStreaming || this._activePromptCount > 0) await this.abort();
		await this.closeSessionTasks();
		await drainSessionWork(this, true);
		renewSessionWork(this);
		replaceSessionTaskOwner(this);
		if (this._disposed) throw hostInputError("SessionClosed");
		await reloadGeneration.call(this, options);
	} catch (error) {
		if (!this._disposed && this._extensionRunner === retiringRunner) retiringRunner.resumeAfterRejectedReload();
		throw error;
	} finally {
		sessionGenerationClosing.delete(this);
	}
}

async function cleanupReloadRunner(runner: ExtensionRunner, reason: string): Promise<void> {
	const failures: unknown[] = [];
	for (const cleanup of [
		() => runner.drainWork(),
		() => reason === "reload" && emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "reload" }),
		() => runner.invalidate(),
	]) {
		try {
			await cleanup();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length)
		throw Object.assign(new AggregateError(failures, "Reload retiring cleanup failed"), { code: "ShutdownFailed" });
}

async function reloadGeneration(this: AgentSession, options?: AgentSessionReloadOptions): Promise<void> {
	return factoryAcquisitions.run({ pending: new Map(), replacement: true }, async () => {
		// Record ownership at transfer, never by rereading a possibly failed loader view.
		const retainedRuntimes = new Set<ExtensionRuntime>();
		try {
			await reloadOwnedGeneration.call(this, retainedRuntimes, options);
		} catch (error) {
			throw factoryRollbackError(error, await rollbackFactoryAcquisitions(retainedRuntimes));
		}
		// Custom discovery may be re-instantiated rather than adopted by the runner.
		const failures = await rollbackFactoryAcquisitions(retainedRuntimes);
		if (failures.length)
			throw Object.assign(new AggregateError(failures, "Reload discovery cleanup failed"), {
				code: "ShutdownFailed",
			});
	});
}

async function reloadOwnedGeneration(
	this: AgentSession,
	retainedRuntimes: Set<ExtensionRuntime>,
	options?: AgentSessionReloadOptions,
): Promise<void> {
	const reason = options?.reason ?? "reload";
	const oldRunner = this._extensionRunner;
	const previousFlagValues = oldRunner.getExplicitFlagValues();
	const activeToolNames = this.getActiveToolNames();
	const prepareResourceReload = this._resourceLoader.prepareReload?.bind(this._resourceLoader);
	if (prepareResourceReload === undefined || this._resourceLoader.supportsTransactionalReload?.() === false) {
		if (options?.failOnExtensionErrors) {
			throw new Error("Strict extension reload requires a transactional resource loader");
		}
		oldRunner.revokeAuthority();
		await retireSessionReloadGeneration(this, () => cleanupReloadRunner(oldRunner, reason));
		await this.settingsManager.reload();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({ activeToolNames, flagValues: previousFlagValues, includeAllExtensionTools: true });
		retainedRuntimes.add(this._resourceLoader.getExtensions().runtime);
		for (const extension of this._resourceLoader.getExtensions().extensions)
			factoryAcquisitions.getStore()?.pending?.delete(extension);
		const discoveryFailures = await rollbackFactoryAcquisitions(
			new Set([this._resourceLoader.getExtensions().runtime]),
		);
		if (discoveryFailures.length)
			throw Object.assign(new AggregateError(discoveryFailures, "Reload discovery cleanup failed"), {
				code: "ShutdownFailed",
			});
		if (this._disposed) throw hostInputError("SessionClosed");
		await options?.beforeSessionStart?.();
		if (this._disposed) throw hostInputError("SessionClosed");
		sessionGenerationClosing.delete(this);
		await startExtensions(this, this._extensionRunner, this._resourceLoader, { type: "session_start", reason });
		if (this._disposed) throw hostInputError("SessionClosed");
		this._rebuildSystemPrompt(this.getActiveToolNames());
		return;
	}

	const settingsTransaction = await this.settingsManager.prepareReload();
	const resourceTransaction = await prepareResourceReload(settingsTransaction.settingsManager);
	const errors = resourceTransaction.loader.getExtensions().errors;
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
		() => this._disposed,
		this._extensionProviderIds,
	);
	let commitPreparedResources: (() => void) | undefined;
	let rollbackPreparedResources: (() => void) | undefined;
	try {
		// The rollback below now owns these factories; discovery-only acquisitions
		// remain in the enclosing ledger until the entire reload settles.
		for (const extension of extensionsResult.extensions) factoryAcquisitions.getStore()?.pending?.delete(extension);
		const discoveryFailures = await rollbackFactoryAcquisitions(new Set([extensionsResult.runtime]));
		if (discoveryFailures.length)
			throw Object.assign(new AggregateError(discoveryFailures, "Reload discovery cleanup failed"), {
				code: "ShutdownFailed",
			});
		this._bindExtensionCore(candidateRunner, publication);
		candidateRunner.setHostBindings(
			this._extensionHumanInput,
			this._extensionDiagnosticListener,
			humanInputBindingRevisions.get(this),
		);
		candidateRunner.setUIContext(this._extensionUIContext, this._extensionMode);
		candidateRunner.bindCommandContext(this._extensionCommandContextActions);
		candidateRunner.bindChildSessionOptions(this._childSessionOptions);
		if (options?.failOnExtensionErrors && errors.length > 0)
			throw new Error(
				`Failed to load extensions: ${errors.map(({ path, error }) => `${path}: ${error}`).join("; ")}`,
			);
		if (this._disposed) throw hostInputError("SessionClosed");
		await options?.beforeSessionStart?.();
		if (this._disposed) throw hostInputError("SessionClosed");
		await startExtensions(this, candidateRunner, resourceTransaction.loader, { type: "session_start", reason });
		if (this._disposed) throw hostInputError("SessionClosed");
		const preparedResources = resourceTransaction.prepareCommit?.();
		if (preparedResources) {
			commitPreparedResources = () => preparedResources.commit();
			rollbackPreparedResources = () => preparedResources.rollback();
		}
		await publication.publishProviders();
		if (this._disposed) throw hostInputError("SessionClosed");
		settingsTransaction.commit();
		resourceTransaction.activate(this.settingsManager);
		if (commitPreparedResources) commitPreparedResources();
		else resourceTransaction.commit();
	} catch (error) {
		const failures: unknown[] = [];
		for (const cleanup of [
			() => rollbackPreparedResources?.(),
			() => publication.discard(),
			() => candidateRunner.sealHostInput(),
			() => candidateRunner.drainWork(),
			() => emitSessionShutdownEvent(candidateRunner, { type: "session_shutdown", reason: "reload" }),
			() => candidateRunner.invalidate(),
		]) {
			try {
				await cleanup();
			} catch (failure) {
				failures.push(failure);
			}
		}
		if (failures.length)
			throw Object.assign(new AggregateError([error, ...failures], "Reload rollback failed"), {
				code: "ShutdownFailed",
			});
		throw error;
	}

	// Publication transferred ownership: keep the started candidate reachable even
	// when reconstruction fails, and retain retiring cleanup through every step.
	this._extensionRunner = candidateRunner;
	retainedRuntimes.add(extensionsResult.runtime);
	const failures: unknown[] = [];
	try {
		resetApiProviders();
		this._extensionProviderIds = new Set(publication.providerIds);
		extensionsResult.runtime.extensionProviderIds = new Set(publication.providerIds);
		this.refreshCurrentModelFromRegistry();
		if (this._extensionRunnerRef) this._extensionRunnerRef.current = candidateRunner;
		this._bindExtensionCore(candidateRunner);
		this._applyExtensionBindings(candidateRunner);
		this._buildRuntime({
			activeToolNames,
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
			preserveRunner: true,
		});
	} catch (error) {
		failures.push(error);
	}
	const setupFailed = failures.length > 0;
	try {
		oldRunner.revokeAuthority();
		await retireSessionReloadGeneration(this, () => cleanupReloadRunner(oldRunner, reason));
	} catch (error) {
		failures.push(error);
	}
	if (failures.length > (setupFailed ? 1 : 0))
		throw Object.assign(new AggregateError(failures, "Reload retiring cleanup failed"), { code: "ShutdownFailed" });
	if (setupFailed) throw failures[0];
	if (this._disposed) throw hostInputError("SessionClosed");
	sessionGenerationClosing.delete(this);
	// Startup observers need the successor task host. Keep admission sealed until
	// retiring callbacks are invalidated, then publish reporters before queued user effects.
	await publication.activateStarts();
	await publication.release();
}

/** Publish approved startup resources without replacing the session or restarting safe reporters. */
export async function completeStartupResources(this: AgentSession, resourceLoader: ResourceLoader): Promise<void> {
	assertSessionOpen(this);
	return trackSessionWork(this, async () => {
		this._resourceLoader = resourceLoader;
		const startNewcomers = this._extensionRunner.attachStartupExtensions(resourceLoader.getExtensions().extensions);
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			includeAllExtensionTools: true,
			preserveRunner: true,
		});
		this.refreshCurrentModelFromRegistry();
		await startNewcomers();
		assertSessionOpen(this);
		await this.extendResourcesFromExtensions("startup");
	});
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
	completeStartupResources,
	extendResourcesFromExtensions,
	buildExtensionResourcePaths,
	getExtensionSourceLabel,
	_applyExtensionBindings,
	refreshCurrentModelFromRegistry,
	_refreshCurrentModelFromRegistry,
	_bindExtensionCore,
	reload,
};
