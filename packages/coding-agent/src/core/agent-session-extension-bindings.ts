import { basename, dirname } from "node:path";
import { resetApiProviders } from "@earendil-works/pi-ai/compat";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { ExtensionBindings } from "./agent-session-types.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import type { ResourceExtensionPaths } from "./resource-loader.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";

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
}


export async function extendResourcesFromExtensions(this: AgentSession, reason: "startup" | "reload"): Promise<void> {
	if (!this._extensionRunner.hasHandlers("resources_discover")) {
		return;
	}

	const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
		this._cwd,
		reason,
	);

	if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
		return;
	}

	const extensionPaths: ResourceExtensionPaths = {
		skillPaths: this.buildExtensionResourcePaths(skillPaths),
		promptPaths: this.buildExtensionResourcePaths(promptPaths),
		themePaths: this.buildExtensionResourcePaths(themePaths),
	};

	this._resourceLoader.extendResources(extensionPaths);
	this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
	this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
}


export function buildExtensionResourcePaths(this: AgentSession, entries: Array<{ path: string; extensionPath: string }>): Array<{
	path: string;
	metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
}> {
	return entries.map((entry) => {
		const source = this.getExtensionSourceLabel(entry.extensionPath);
		const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
		return {
			path: entry.path,
			metadata: {
				source,
				scope: "temporary",
				origin: "top-level",
				baseDir,
			},
		};
	});
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

	const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
	if (!refreshedModel || refreshedModel === currentModel) {
		return;
	}

	const previousModel = currentModel;
	const previousThinkingLevel = this.thinkingLevel;
	const replay = this._getResumeContextWindowReplayForModel(refreshedModel);
	this.agent.state.model = replay.model;
	if (currentModel.contextWindow !== replay.contextWindow) {
		this._emit({ type: "context_window_changed", contextWindow: replay.contextWindow });
	}
	this.setThinkingLevel(previousThinkingLevel);
	this._refreshBaseSystemPromptFromActiveTools();
	this._emit({ type: "model_changed", model: replay.model, previousModel, source: "restore" });
}


export function _bindExtensionCore(this: AgentSession, runner: ExtensionRunner): void {
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

		const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
			name: `skill:${skill.name}`,
			description: skill.description,
			source: "skill",
			sourceInfo: skill.sourceInfo,
		}));

		return [...extensionCommands, ...templates, ...skills];
	};

	runner.bindCore(
		{
			sendMessage: (message, options) => {
				this.sendCustomMessage(message, options).catch((err) => {
					runner.emitError({
						extensionPath: "<runtime>",
						event: "send_message",
						error: err instanceof Error ? err.message : String(err),
					});
				});
			},
			sendUserMessage: (content, options) => {
				this.sendUserMessage(content, options).catch((err) => {
					runner.emitError({
						extensionPath: "<runtime>",
						event: "send_user_message",
						error: err instanceof Error ? err.message : String(err),
					});
				});
			},
			appendEntry: (customType, data) => {
				this.sessionManager.appendCustomEntry(customType, data);
			},
			setSessionName: (name) => {
				this.setSessionName(name);
			},
			getSessionName: () => {
				return this.sessionManager.getSessionName();
			},
			setLabel: (entryId, label) => {
				this.sessionManager.appendLabelChange(entryId, label);
			},
			getActiveTools: () => this.getActiveToolNames(),
			getAllTools: () => this.getAllTools(),
			setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
			refreshTools: () => this._refreshToolRegistry(),
			getCommands,
			setModel: async (model) => {
				if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
				await this.setModel(model);
				return true;
			},
			getThinkingLevel: () => this.thinkingLevel,
			setThinkingLevel: (level) => this.setThinkingLevel(level),
		},
		{
			getModel: () => this.model,
			isIdle: () => !this.isStreaming,
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
			getSignal: () => this.agent.signal,
			abort: () => this.abort(),
			hasPendingMessages: () => this.pendingMessageCount > 0,
			shutdown: () => {
				this._extensionShutdownHandler?.();
			},
			getContextUsage: () => this.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.compact({
							...(options?.compression_ratio === undefined ? {} : { compression_ratio: options.compression_ratio }),
							...(options?.preserve_recent === undefined ? {} : { preserve_recent: options.preserve_recent }),
							...(options?.query === undefined ? {} : { query: options.query }),
						});
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.systemPrompt,
			getSystemPromptOptions: () => this._baseSystemPromptOptions,
		},
		{
			registerProvider: (name, config) => {
				this._modelRegistry.registerProvider(name, config);
				this.refreshCurrentModelFromRegistry();
			},
			unregisterProvider: (name) => {
				this._modelRegistry.unregisterProvider(name);
				this.refreshCurrentModelFromRegistry();
			},
		},
	);
}


export async function reload(this: AgentSession, options?: { reason?: "startup" | "reload" }): Promise<void> {
	const reason = options?.reason ?? "reload";
	const previousFlagValues = this._extensionRunner.getFlagValues();
	if (reason === "reload") {
		await emitSessionShutdownEvent(this._extensionRunner, { type: "session_shutdown", reason: "reload" });
	}
	await this.settingsManager.reload();
	resetApiProviders();
	await this._resourceLoader.reload();
	this._buildRuntime({
		activeToolNames: this.getActiveToolNames(),
		flagValues: previousFlagValues,
		includeAllExtensionTools: true,
	});

	const hasBindings =
		this._extensionUIContext ||
		this._extensionCommandContextActions ||
		this._extensionShutdownHandler ||
		this._extensionErrorListener;
	if (hasBindings) {
		await this._extensionRunner.emit({ type: "session_start", reason });
		await this.extendResourcesFromExtensions(reason);
	}
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
