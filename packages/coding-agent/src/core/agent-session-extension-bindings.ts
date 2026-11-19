import { basename, dirname } from "node:path";
import type { Provider } from "@bastani/atomic-ai";
import { clampThinkingLevel, resetApiProviders } from "@bastani/atomic-ai/compat";
import { isPowerShellAvailableAsync } from "../utils/shell.ts";
import { resolveWorkflowStageDeliveryTarget } from "./agent-session-delivery-forwarding.ts";
import { sessionCloseReason } from "./agent-session-events.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { authForStream } from "./agent-session-models.ts";
import { executeNestedToolCall, getCallableTools } from "./agent-session-nested-tools.js";
import {
	activatesAfterRecordedLoadout,
	preservesInitialToolLoadout,
	type RecordedToolLoadout,
	recordedToolLoadout,
} from "./agent-session-state.ts";
import { replaceSessionTaskOwner } from "./agent-session-tasks.js";
import type { AgentSessionReloadOptions, ExtensionBindings } from "./agent-session-types.js";
import { migrateCompactionModelSettings } from "./compaction/model-resolver.js";
import { generateWorkflowSummary } from "./compaction/session-summarization.ts";
import { claimInteractiveBind, type InitialBind, recordClosedStart } from "./extension-startup-close.ts";
import {
	ExtensionStartupError,
	type ExtensionStartupFailure,
	startupCleanupFailureMessage,
} from "./extension-startup-failure.ts";
import { hostInputError } from "./extensions/host-input.js";
import { type ExtensionError, ExtensionRunner } from "./extensions/index.js";
import {
	factoryAcquisitions,
	factoryRollbackError,
	rollbackFactoryAcquisitions,
} from "./extensions/loader-rollback.ts";
import { emitSessionShutdownEvent, stockResourceDiscovery } from "./extensions/runner.ts";
import { bindExtensionContextPublication, runSynchronousExtensionContextEffect } from "./extensions/runner-context.ts";
import { startupErrorHandlerTokens } from "./extensions/runner-events.ts";
import type { ExtensionRuntime, ProviderConfig, RegisteredTool } from "./extensions/types.ts";
import { isMandatoryRuntimeTool, isTrustedMandatoryRuntimeTool } from "./mandatory-runtime-tools.ts";
import { isSelectedNativeMcpTool } from "./mcp-child-policy.ts";
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
	sessionLifetime,
	trackSessionReload,
	trackSessionWork,
} from "./session-lifecycle-work.ts";
import { serializeSessionMutation } from "./session-mutation-queue.ts";
import { completeStartup, rollbackStartup } from "./session-startup-rollback.ts";
import { applyToolModifiers } from "./settings-merge.js";
import { getSkillCatalog } from "./skill-catalog.ts";
import type { SlashCommandInfo } from "./slash-commands.js";
import { createSyntheticSourceInfo } from "./source-info.ts";
import { notifyAgentPanelSourceHubRebound } from "./tasks/agent-panel-source.ts";
import { activatesOnRegistration, isRegisteredToolAllowed, isToolActivatable } from "./tool-selection.ts";
import { defaultToolNamesFor } from "./tools/index.js";
import { trackTerminalWorkflowSummary } from "./workflow-summary-lifecycle.ts";

class ExtensionPublicationGate {
	readonly resourceLoader: ResourceLoader;
	private readonly effects: Array<() => void | Promise<void>> = [];
	private readonly startEffects: Array<() => void | Promise<void>> = [];
	private readonly commitEffects: Array<() => void> = [];
	private readonly commitFailures: unknown[] = [];
	readonly providerTransaction: ExtensionProviderTransaction;
	private commitsActivated = false;
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

	stageCommit(effect: () => void): void {
		if (this.discarded) return;
		if (!this.commitsActivated) {
			this.commitEffects.push(effect);
			return;
		}
		try {
			runSynchronousExtensionContextEffect(effect);
		} catch (error) {
			this.commitFailures.push(error);
			try {
				this.report(error, "session_start");
			} catch (reportingError) {
				this.commitFailures.push(reportingError);
			}
		}
	}

	activateCommits(): void {
		this.commitsActivated = true;
		for (const effect of this.commitEffects.splice(0)) this.stageCommit(effect);
		this.drainCommitFailures();
	}

	drainCommitFailures(): void {
		if (this.commitFailures.length) {
			throw new AggregateError(this.commitFailures.splice(0), "Extension commit activation failed");
		}
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
		this.commitEffects.length = 0;
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

function bindClosed(session: AgentSession, bind?: InitialBind): Error {
	const error = hostInputError("SessionClosed");
	// A runtime replacement owns a successor. Only quitting this session cancels its interactive start.
	if (bind && sessionCloseReason(session) === "quit") bind.closed = error;
	return error;
}

async function extendRunnerResources(
	session: AgentSession,
	runner: ExtensionRunner,
	loader: ResourceLoader,
	reason: "startup" | "reload",
	reportError?: (error: ExtensionError) => void,
	initialBind?: InitialBind,
): Promise<void> {
	if (!runner.hasHandlers("resources_discover")) return;
	const discover = runner.emitResourcesDiscover;
	const result =
		initialBind && discover === stockResourceDiscovery && sessionCloseReason(session) === "quit"
			? stockResourceDiscovery.call(runner, session._cwd, reason, reportError, initialBind)
			: Reflect.apply(discover, runner, [session._cwd, reason, reportError]);
	const { skillPaths, promptPaths, themePaths } = await result;
	if (session._disposed) throw bindClosed(session, initialBind);
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
const presentationOnlyBindings = new WeakMap<AgentSession, boolean>();
// Sessions whose host reports startup handler errors instead of failing the start (`reportStartupErrors`).
const startupErrorReports = new WeakMap<AgentSession, boolean>();
const statusSinks = new WeakMap<AgentSession, NonNullable<ExtensionBindings["onStatus"]>>();
const sessionSummaryBackfills = new WeakSet<AgentSession>();
// The `session_start` and `resources_discover` failures each session's startup reported. One startup can run a handler
// twice: settling project trust discovers resources again for the completed extension set, and a startup that deferred
// its extensions reloads them. Its host hears each failure once; a later `/reload` reports its failures again.
const startupFailureReports = new WeakMap<AgentSession, Set<string>>();

/** Records a startup failure; false when this session's startup already reported the same one. */
function recordStartupFailure(session: AgentSession, error: ExtensionError): boolean {
	const token = startupErrorHandlerTokens.get(error);
	if (token === undefined) return true;
	const key = JSON.stringify([token, error.event, error.error]);
	const reported = startupFailureReports.get(session) ?? new Set<string>();
	startupFailureReports.set(session, reported);
	if (reported.has(key)) return false;
	reported.add(key);
	return true;
}

function startExtensions(
	session: AgentSession,
	runner: ExtensionRunner,
	loader: ResourceLoader,
	event: AgentSession["_sessionStartEvent"],
	finalize?: () => Promise<void>,
	initialBind?: InitialBind,
): Promise<void> {
	const existing = extensionStarts.get(runner);
	if (existing) {
		if (initialBind) initialBind.joinedStart = runner;
		return finalize ? existing.then(finalize) : existing;
	}
	const start = trackSessionWork(session, () =>
		Promise.resolve().then(async () => {
			const failures: ExtensionStartupFailure[] = [];
			const reportsStartupErrors = startupErrorReports.get(session) === true;
			// The session's error listener hears only the runner it is bound to. A reload's candidate runner is bound after
			// it commits, so the startup errors it reports are handed to that listener here.
			const reportStartupError =
				reportsStartupErrors && runner !== session._extensionRunner ? session._extensionErrorListener : undefined;
			const unsubscribe = runner.onError((error) => {
				if (error.event === "session_start" || error.event === "resources_discover") {
					failures.push({ extensionPath: error.extensionPath, event: error.event, message: error.error });
					if (event.reason !== "reload" && !recordStartupFailure(session, error)) return;
					reportStartupError?.(error);
				}
			});
			try {
				if (session._extensionProviderIds.size > 0) await session.refreshCurrentModelFromRegistry();
				if (
					loader
						.getExtensions()
						.extensions.some((extension) => extension.sourceInfo.configurationOrigin !== "bundled")
				)
					await session.sessionManager.loadFullHistory();
				await runner.emit(event);
				await extendRunnerResources(
					session,
					runner,
					loader,
					event.reason === "reload" ? "reload" : "startup",
					undefined,
					initialBind,
				);
				// A reported failure leaves the extension loaded, as a failing handler for any other event does.
				if (failures.length && !reportsStartupErrors) throw new ExtensionStartupError(failures);
				await finalize?.();
				if (runner === session.extensionRunner) runner.reportUnhandledMcpServers();
				completeStartup(runner);
			} finally {
				unsubscribe();
			}
		}),
	).catch(async (error: unknown) => {
		failedExtensionStarts.add(runner);
		recordClosedStart(runner, initialBind, error);
		return rollbackStartup(runner, error instanceof Error ? error : new Error(String(error)), async (cause) => {
			try {
				if (!hasSessionReload(session)) await session.dispose();
			} catch (cleanupError) {
				const errors = [cause, cleanupError];
				throw Object.assign(
					new AggregateError(errors, startupCleanupFailureMessage("Extension startup and cleanup failed", errors)),
					{ code: "ShutdownFailed" },
				);
			}
			throw cause;
		});
	});
	extensionStarts.set(runner, start);
	return start;
}

const uiPromptBindings = new WeakMap<AgentSession, NonNullable<ExtensionBindings["onUIPrompt"]>>();

export function bindExtensions(this: AgentSession, bindings: ExtensionBindings): Promise<void> {
	const initialBind = claimInteractiveBind(this, bindings);
	const binding = bindSessionExtensions.call(this, bindings, initialBind);
	if (initialBind) initialBind.binding = binding;
	return binding;
}

async function bindSessionExtensions(
	this: AgentSession,
	bindings: ExtensionBindings,
	initialBind?: InitialBind,
): Promise<void> {
	if (this._disposed) {
		// Failed creation retains its original rejection; it never admits another startup.
		const wasDelivered = initialBind?.deliveredWhileOpen === this;
		if (failedExtensionStarts.has(this._extensionRunner)) {
			if (wasDelivered) initialBind.joinedStart = this._extensionRunner;
			return extensionStarts.get(this._extensionRunner)!;
		}
		throw bindClosed(this, wasDelivered ? initialBind : undefined);
	}
	if (bindings.onUIPrompt !== undefined) uiPromptBindings.set(this, bindings.onUIPrompt);
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
	if (bindings.isPresentationOnly !== undefined) presentationOnlyBindings.set(this, bindings.isPresentationOnly);
	if (bindings.reportStartupErrors !== undefined) startupErrorReports.set(this, bindings.reportStartupErrors);
	if (bindings.onStatus !== undefined) statusSinks.set(this, bindings.onStatus);
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
	await startExtensions(
		this,
		this._extensionRunner,
		this._resourceLoader,
		this._sessionStartEvent,
		async () => {
			if (this._disposed) throw bindClosed(this, initialBind);
			this._rebuildSystemPrompt(this.getActiveToolNames());
		},
		initialBind,
	);
	migrateSavedCompactionModel(this);
	scheduleOpeningSummary(this);
	scheduleOpeningCollection(this);
}

/**
 * Reset a saved `compactionModel` naming a chat or classifier model to `auto`, again now that extensions have
 * registered their providers: a model an extension registers is unknown when the session is created.
 */
function migrateSavedCompactionModel(session: AgentSession): void {
	migrateCompactionModelSettings(session.settingsManager, session._modelRuntime.getAllModels());
}

export async function _waitForExtensionStart(this: AgentSession): Promise<void> {
	await extensionStarts.get(this._extensionRunner);
}

/**
 * Schedules the snapshot blob collection of an interactive session once it has started (#5530), as the opening summary
 * is scheduled: a session that only closes when its process quits would otherwise never collect, because a collection
 * scheduled at close starts after a delay the process does not wait for.
 */
function scheduleOpeningCollection(session: AgentSession): void {
	if (presentationOnlyBindings.get(session) || (session._extensionMode !== "tui" && session._extensionMode !== "rpc"))
		return;
	session._worktreeSnapshots.scheduleCollection();
}

function scheduleOpeningSummary(session: AgentSession): void {
	if (
		!presentationOnlyBindings.get(session) &&
		(session._extensionMode === "tui" || session._extensionMode === "rpc") &&
		!sessionSummaryBackfills.has(session)
	) {
		sessionSummaryBackfills.add(session);
		void session._maybeGenerateSessionSummary();
	}
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

/**
 * Child session defaults from this session's live successor (#3981). A child queued or restored by a workflow stage
 * session can start after model fallback replaced that session; it then inherits the replacement's current model,
 * settings and tool ceiling. A session with no successor (it was not replaced, or it closed for good) answers with its
 * own last state, which is what it had when it admitted the child.
 */
function liveChildSessionOptions(
	session: AgentSession,
): import("./child-session-options.ts").ChildSessionOptionsResolver | undefined {
	const own = session._childSessionOptions;
	if (!own) return undefined;
	return (options) => (resolveWorkflowStageDeliveryTarget(session)._childSessionOptions ?? own)(options);
}

export function _applyExtensionBindings(this: AgentSession, runner: ExtensionRunner): void {
	runner.setHostBindings(
		this._extensionHumanInput,
		this._extensionDiagnosticListener,
		humanInputBindingRevisions.get(this),
	);
	runner.setUIPromptObserver(uiPromptBindings.get(this));
	runner.setUIContext(this._extensionUIContext, this._extensionMode, presentationOnlyBindings.get(this) ?? false);
	runner.setStatusSink(statusSinks.get(this));
	runner.bindCommandContext(this._extensionCommandContextActions);
	runner.bindChildSessionOptions(liveChildSessionOptions(this));
	runner.bindInheritedHistory(this._inheritedHistory);
	runner.bindWorkflowJournal(this._workflowJournal, this._storageAgentDir);

	this._extensionErrorUnsubscriber?.();
	this._extensionErrorUnsubscriber = this._extensionErrorListener
		? runner.onError(this._extensionErrorListener)
		: undefined;
}

export async function refreshCurrentModelFromRegistry(this: AgentSession): Promise<void> {
	await this._refreshCurrentModelFromRegistry();
}

export async function _refreshCurrentModelFromRegistry(this: AgentSession): Promise<void> {
	const changedThinking = await serializeSessionMutation(this, async () => {
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
		const level = clampThinkingLevel(refreshedModel, previousThinkingLevel);
		if (level !== previousThinkingLevel) await this.sessionManager.appendThinkingLevelChange(level);
		this.agent.state.model = refreshedModel;
		this.agent.state.thinkingLevel = level;
		if (level !== previousThinkingLevel) {
			this._emit({ type: "thinking_level_changed", level });
		}
		this._refreshBaseSystemPromptFromActiveTools();
		this._emit({ type: "model_changed", model: refreshedModel, previousModel, source: "restore" });
		return level !== previousThinkingLevel ? { level, previousLevel: previousThinkingLevel } : undefined;
	});
	if (changedThinking) await this._extensionRunner.emit({ type: "thinking_level_select", ...changedThinking });
}

export function _bindExtensionCore(
	this: AgentSession,
	runner: ExtensionRunner,
	publication?: ExtensionPublicationGate,
	startupToolNames?: readonly string[],
	startupLoadout?: RecordedToolLoadout,
): void {
	runner.bindWorkOwner(this);
	if (publication) {
		bindExtensionContextPublication(runner.createContext(), (effect, phase) =>
			phase === "commit" ? publication.stageCommit(effect) : publication.stageStart(effect),
		);
	}
	runner.bindTaskHost(() => this.getAgentTaskHost());
	// A transactional successor starts before it is published. Its callbacks must inspect and
	// activate its own definitions, never the retiring session's registry. Keep this view local;
	// only accepted candidates release the deferred activation into the live session.
	const candidateDefinitions = () => {
		const definitions = new Map<string, RegisteredTool>();
		const permitted = (name: string) => isRegisteredToolAllowed(this, name);
		for (const [name, definition] of this._baseToolDefinitions) {
			if (permitted(name))
				definitions.set(name, {
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
				});
		}
		const registered = runner
			.getAllRegisteredTools()
			.filter((tool) => !isMandatoryRuntimeTool(tool.definition.name) || isTrustedMandatoryRuntimeTool(tool));
		for (const tool of registered) {
			const name = tool.definition.name;
			if (permitted(name) || (!this._excludedTools?.(name) && isSelectedNativeMcpTool(tool, this._subagentPolicy)))
				definitions.set(name, tool);
		}
		for (const definition of this._customTools) {
			if (!isMandatoryRuntimeTool(definition.name) && permitted(definition.name))
				definitions.set(definition.name, {
					definition,
					sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
				});
		}
		return definitions;
	};
	let candidateActiveTools = startupToolNames ? [...startupToolNames] : this.getActiveToolNames();
	const candidateRegistryNames = new Set(this._baseToolDefinitions.keys());
	const refreshCandidateTools = () => {
		const definitions = candidateDefinitions();
		for (const [name, { definition }] of definitions) {
			if (
				!candidateRegistryNames.has(name) &&
				(startupLoadout
					? activatesAfterRecordedLoadout(this, startupLoadout, name, definition) &&
						applyToolModifiers([name], this._defaultToolModifiers).includes(name)
					: startupToolNames === undefined &&
						activatesOnRegistration(this, name, definition, this._toolRegistry.has(name)))
			)
				candidateActiveTools.push(name);
			candidateRegistryNames.add(name);
		}
		candidateActiveTools = [...new Set(candidateActiveTools)].filter((name) => {
			const tool = definitions.get(name);
			return (
				tool &&
				tool.definition.exposure !== "hidden" &&
				isToolActivatable(this, name, tool.definition.exposure ?? "direct", definitions.has("tool_search"))
			);
		});
		return definitions;
	};
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

	const restoreProvider = (providerOrName: Provider | string, config?: ProviderConfig): void => {
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
			appendEntry: async (customType, data) => {
				const append = async () => {
					const id = await this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(id);
					if (entry) this._emit({ type: "entry_appended", entry });
				};
				if (publication) publication.defer(append);
				else await append();
			},
			setSessionName: async (name) => {
				if (publication) publication.defer(() => this.setSessionName(name));
				else await this.setSessionName(name);
			},
			getSessionName: () => this.sessionManager.getSessionName(),
			setLabel: async (entryId, label) => {
				const append = async () => {
					await this.sessionManager.appendLabelChange(entryId, label);
				};
				if (publication) publication.defer(append);
				else await append();
			},
			getActiveTools: () => {
				if (!publication) return this.getActiveToolNames();
				refreshCandidateTools();
				return [...candidateActiveTools];
			},
			getAllTools: () => {
				if (!publication) return this.getAllTools();
				return [...refreshCandidateTools().values()].map(({ definition, sourceInfo }) => ({
					name: definition.name,
					description: definition.description,
					parameters: definition.parameters,
					...(Object.hasOwn(definition, "constrainedSampling")
						? { constrainedSampling: definition.constrainedSampling }
						: {}),
					promptGuidelines: definition.promptGuidelines,
					exposure: definition.exposure ?? "direct",
					namespace: definition.namespace,
					annotations: definition.annotations,
					sourceInfo,
				}));
			},
			setActiveTools: (toolNames) => {
				if (publication) {
					const definitions = refreshCandidateTools();
					candidateActiveTools = [...new Set(toolNames)].filter((name) => {
						const tool = definitions.get(name);
						return (
							tool &&
							tool.definition.exposure !== "hidden" &&
							isToolActivatable(this, name, tool.definition.exposure ?? "direct", definitions.has("tool_search"))
						);
					});
					const accepted = [...candidateActiveTools];
					publication.defer(() => this.setActiveToolsByName(accepted));
				} else this.setActiveToolsByName(toolNames);
			},
			refreshTools: () => {
				if (publication) refreshCandidateTools();
				else this._refreshToolRegistry();
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
			setThinkingLevel: async (level) => {
				if (publication) publication.defer(async () => await this.setThinkingLevel(level));
				else await this.setThinkingLevel(level);
			},
		},
		{
			getModel: () => this.model,
			executeTool: (callerId, name, args, options) => executeNestedToolCall(this, callerId, name, args, options),
			getCallableTools: () => getCallableTools(this),
			getSettings: () => this.settingsManager.getSettings(),
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
			isSessionSummaryEnabled: () => this.settingsManager.getSessionSummarySettings().enabled,
			generateWorkflowSummary: async (text, requestSignal, options) => {
				if (this._disposed || sessionGenerationClosing.has(this)) return undefined;
				if (!this.settingsManager.getSessionSummarySettings().enabled) return undefined;
				const model = this.model;
				if (!model) return undefined;
				const generate = async (signal: AbortSignal) => {
					try {
						if (signal.aborted) return undefined;
						const auth = authForStream(this, await this._getRequiredRequestAuth(model));
						if (signal.aborted) return undefined;
						const result = await generateWorkflowSummary(text, {
							model,
							...auth,
							signal,
							streamFn: this.agent.streamFunction,
							retry: this.settingsManager.getRetrySettings(),
						});
						return signal.aborted || result.error || result.aborted ? undefined : result.summary;
					} catch {
						return undefined;
					}
				};
				return options?.terminal
					? trackTerminalWorkflowSummary(this, requestSignal, generate)
					: trackSessionWork(this, () => {
							const signal = AbortSignal.any([requestSignal, sessionLifetime(this)]);
							let abort!: () => void;
							return new Promise<string | undefined>((resolve) => {
								abort = () => resolve(undefined);
								signal.addEventListener("abort", abort, { once: true });
								if (signal.aborted) abort();
								else void generate(signal).then(resolve);
							}).finally(() => signal.removeEventListener("abort", abort));
						});
			},
			shutdown: () => {
				if (publication) publication.defer(() => this._extensionShutdownHandler?.());
				else this._extensionShutdownHandler?.();
			},
			getContextUsage: () => this.getContextUsage(),
			compact: (options) => {
				const compact = async () => {
					try {
						const result = await this.compact({
							...(options?.query === undefined ? {} : { query: options.query }),
							...(options?.compactionModel === undefined ? {} : { compactionModel: options.compactionModel }),
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
			getDecisionModel: () => this.settingsManager.getDecisionModel(),
			getHttpIdleTimeoutMs: () => this.settingsManager.getHttpIdleTimeoutMs(),
			getSkillCatalog: () => getSkillCatalog(publication?.resourceLoader ?? this._resourceLoader),
			getSystemPromptOptions: () => this._baseSystemPromptOptions,
		},
		{
			restoreProvider,
			registerProvider: async (providerOrName, config) => {
				restoreProvider(providerOrName, config);
				await this.refreshCurrentModelFromRegistry();
			},
			unregisterProvider: async (name) => {
				if (publication) {
					publication.providerIds.delete(name);
					publication.providerTransaction.unregisterProvider(name);
				} else {
					this._extensionProviderIds.delete(name);
					this._resourceLoader.getExtensions().runtime.extensionProviderIds.delete(name);
					this._modelRuntime.unregisterProvider(name);
					await this.refreshCurrentModelFromRegistry();
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
		if (!this._disposed) renewSessionWork(this);
		replaceSessionTaskOwner(this);
		if (this._disposed) throw hostInputError("SessionClosed");
		await reloadGeneration.call(this, options);
		if (
			!this._disposed &&
			!sessionGenerationClosing.has(this) &&
			!this.isStreaming &&
			!this._queuedMessagesPaused &&
			this._protectedStreamingCustomMessages?.some((entry) => entry.phase === "queued")
		) {
			this._agentRunAbortRequested = false;
			void trackSessionWork(this, () => this._runAgentPrompt([])).catch((error) => {
				this._extensionRunner.emitError({
					extensionPath: "session:reload",
					event: "reload",
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
	} catch (error) {
		if (!this._disposed && this._extensionRunner === retiringRunner) retiringRunner.resumeAfterRejectedReload();
		throw error;
	} finally {
		sessionGenerationClosing.delete(this);
	}
	migrateSavedCompactionModel(this);
	if (options?.reason === "startup") {
		sessionSummaryBackfills.delete(this);
		scheduleOpeningSummary(this);
	}
}

function failureMessages(error: unknown): string[] {
	if (error instanceof AggregateError && error.errors.length > 0) return error.errors.flatMap(failureMessages);
	return [error instanceof Error ? error.message : String(error)];
}

function retiringCleanupError(failures: unknown[]): AggregateError {
	const detail = failures.flatMap(failureMessages).join("; ");
	return Object.assign(new AggregateError(failures, `Reload retiring cleanup failed: ${detail}`), {
		code: "ShutdownFailed",
	});
}

async function cleanupReloadRunner(runner: ExtensionRunner, reason: string): Promise<void> {
	const failures: unknown[] = [];
	for (const cleanup of [
		() => runner.drainWork(),
		() =>
			(reason === "reload" || reason === "startup") &&
			emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "reload" }),
		() => runner.invalidate(),
	]) {
		try {
			await cleanup();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw retiringCleanupError(failures);
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

/**
 * Whether the session is closed, for a publication gate the new generation keeps for its whole life. Made outside the
 * reload so it does not close over the reload's scope, which holds the retiring runner: each generation would otherwise
 * keep the one before it, and every reload would stay in memory for as long as the session runs.
 */
function sessionClosedProbe(session: AgentSession): () => boolean {
	return () => session._disposed;
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
	const previousDefaultTools = this._appliedDefaultTools;
	const activeToolsAfterReload = (defaultTools: readonly string[]) => [
		...activeToolNames,
		...(this._usesDefaultTools ? defaultTools.filter((name) => !previousDefaultTools.has(name)) : []),
	];
	const prepareResourceReload = this._resourceLoader.prepareReload?.bind(this._resourceLoader);
	if (prepareResourceReload === undefined || this._resourceLoader.supportsTransactionalReload?.() === false) {
		if (options?.failOnExtensionErrors) {
			throw new Error("Strict extension reload requires a transactional resource loader");
		}
		const retiringFailures: unknown[] = [];
		try {
			oldRunner.revokeAuthority();
		} catch (error) {
			retiringFailures.push(error);
		}
		await retireSessionReloadGeneration(this, () => cleanupReloadRunner(oldRunner, reason)).catch(
			(error: unknown) => {
				retiringFailures.push(error);
			},
		);
		await this.settingsManager.reload();
		resetApiProviders();
		await this._resourceLoader.reload();
		const powerShellAvailable = await isPowerShellAvailableAsync();
		const builtinDefaultToolNames = defaultToolNamesFor(powerShellAvailable);
		const defaultTools = applyToolModifiers(
			this.settingsManager.getDefaultToolsWith(builtinDefaultToolNames) ?? builtinDefaultToolNames,
			this._defaultToolModifiers,
		);
		for (const name of this.getActiveToolNames()) this._pendingToolNames.add(name);
		this._restoredToolNames = new Set(this.getActiveToolNames());
		this._buildRuntime({
			activeToolNames: activeToolsAfterReload(defaultTools),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
			powerShellAvailable,
		});
		if (reason === "startup") this._restoreToolsFromTranscript({ startup: true });
		this._appliedDefaultTools = new Set(defaultTools);
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
		if (retiringFailures.length) throw retiringFailures[0];
		return;
	}

	const settingsTransaction = await this.settingsManager.prepareReload();
	const resourceTransaction = await prepareResourceReload(settingsTransaction.settingsManager);
	const powerShellAvailable = await isPowerShellAvailableAsync();
	const builtinDefaultToolNames = defaultToolNamesFor(powerShellAvailable);
	const defaultTools = applyToolModifiers(
		settingsTransaction.settingsManager.getDefaultToolsWith(builtinDefaultToolNames) ?? builtinDefaultToolNames,
		this._defaultToolModifiers,
	);
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
		this._intercomPolicy,
	);
	const publication = new ExtensionPublicationGate(
		resourceTransaction.loader,
		candidateRunner,
		this._modelRuntime,
		sessionClosedProbe(this),
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
		const startupLoadout =
			reason === "startup" && this._usesDefaultTools && !preservesInitialToolLoadout(this)
				? recordedToolLoadout(this)
				: undefined;
		const startupToolNames = startupLoadout
			? applyToolModifiers([...startupLoadout.current], this._defaultToolModifiers)
			: undefined;
		this._bindExtensionCore(candidateRunner, publication, startupToolNames, startupLoadout);
		candidateRunner.setHostBindings(
			this._extensionHumanInput,
			this._extensionDiagnosticListener,
			humanInputBindingRevisions.get(this),
		);
		candidateRunner.setUIContext(
			this._extensionUIContext,
			this._extensionMode,
			presentationOnlyBindings.get(this) ?? false,
		);
		candidateRunner.setStatusSink(statusSinks.get(this));
		candidateRunner.bindCommandContext(this._extensionCommandContextActions);
		candidateRunner.bindChildSessionOptions(liveChildSessionOptions(this));
		candidateRunner.bindInheritedHistory(this._inheritedHistory);
		candidateRunner.bindWorkflowJournal(this._workflowJournal, this._storageAgentDir);
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
			() => candidateRunner.retireObservation(),
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
	this._workflows?.rebindObservers();
	notifyAgentPanelSourceHubRebound(this);
	retainedRuntimes.add(extensionsResult.runtime);
	const failures: unknown[] = [];
	try {
		resetApiProviders();
		this._extensionProviderIds = new Set(publication.providerIds);
		extensionsResult.runtime.extensionProviderIds = new Set(publication.providerIds);
		await this.refreshCurrentModelFromRegistry();
		if (this._extensionRunnerRef) this._extensionRunnerRef.current = candidateRunner;
		this._bindExtensionCore(candidateRunner);
		this._applyExtensionBindings(candidateRunner);
		for (const name of this.getActiveToolNames()) this._pendingToolNames.add(name);
		this._restoredToolNames = new Set(this.getActiveToolNames());
		this._buildRuntime({
			activeToolNames: activeToolsAfterReload(defaultTools),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
			preserveRunner: true,
			powerShellAvailable,
		});
		if (reason === "startup") this._restoreToolsFromTranscript({ startup: true });
		this._appliedDefaultTools = new Set(defaultTools);
		candidateRunner.reportUnhandledMcpServers();
	} catch (error) {
		failures.push(error);
	}
	const setupFailed = failures.length > 0;
	try {
		publication.activateCommits();
	} catch (error) {
		failures.push(error);
	}
	try {
		oldRunner.revokeAuthority();
	} catch (error) {
		failures.push(error);
	}
	try {
		await retireSessionReloadGeneration(this, () => cleanupReloadRunner(oldRunner, reason));
	} catch (error) {
		failures.push(error);
	}
	bindExtensionContextPublication(candidateRunner.createContext(), undefined);
	try {
		publication.drainCommitFailures();
	} catch (error) {
		failures.push(error);
	}
	if (setupFailed) throw failures.length > 1 ? retiringCleanupError(failures) : failures[0];
	if (this._disposed) throw failures.length ? failures[0] : hostInputError("SessionClosed");
	sessionGenerationClosing.delete(this);
	// Startup observers need the successor task host. Keep admission sealed until
	// retiring callbacks are invalidated, then publish reporters before queued user effects.
	await publication.activateStarts();
	await publication.release();
	if (failures.length) throw failures.length > 1 ? retiringCleanupError(failures) : failures[0];
}

/** Publish approved startup resources without replacing the session or restarting safe reporters. */
export async function completeStartupResources(this: AgentSession, resourceLoader: ResourceLoader): Promise<void> {
	assertSessionOpen(this);
	return trackSessionWork(this, async () => {
		const powerShellAvailable = await isPowerShellAvailableAsync();
		this._resourceLoader = resourceLoader;
		const startNewcomers = this._extensionRunner.attachStartupExtensions(resourceLoader.getExtensions().extensions);
		const recorded = preservesInitialToolLoadout(this) ? undefined : recordedToolLoadout(this);
		const knownToolNames = new Set(this._toolRegistry.keys());
		this._buildRuntime({
			// Keeps the tools the session activated or deactivated before startup completed.
			activeToolNames: this.getActiveToolNames(),
			includeAllExtensionTools: !recorded,
			preserveRunner: true,
			powerShellAvailable,
		});
		if (recorded) {
			// Tools this completion registers for the first time were registered after the branch recorded its
			// loadout, like extensions installed after it: they activate unless the branch mentioned them, as in
			// `_restoreToolsFromTranscript`. Tools registered earlier keep the choices already made about them.
			const newTools = [...this._toolRegistry.keys()].filter(
				(name) =>
					!knownToolNames.has(name) &&
					activatesAfterRecordedLoadout(this, recorded, name, this._toolDefinitions.get(name)?.definition) &&
					applyToolModifiers([name], this._defaultToolModifiers).includes(name),
			);
			if (newTools.length > 0) this._setActiveTools([...this.getActiveToolNames(), ...newTools]);
		}
		await this.refreshCurrentModelFromRegistry();
		await startNewcomers();
		assertSessionOpen(this);
		// Discovery runs again for the completed extension set, so the extensions started before trust was settled run
		// their handlers a second time. A failure they already reported during this startup is not reported again.
		const runner = this._extensionRunner;
		await extendRunnerResources(this, runner, this._resourceLoader, "startup", (error) => {
			if (recordStartupFailure(this, error)) runner.emitError(error);
		});
		assertSessionOpen(this);
		this._rebuildSystemPrompt(this.getActiveToolNames());
		// Startup completes once the project's trust is settled and its extensions are loaded: a trusted project's
		// selection and a model those extensions register are both known now.
		migrateSavedCompactionModel(this);
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
	_waitForExtensionStart,
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
