import { join } from "node:path";
import { normalizeProviderId } from "@bastani/atomic-ai";
import type { Api, Model } from "@bastani/atomic-ai/compat";
import type { KeyId } from "@bastani/atomic-tui";
import type { AgentSession } from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { THINKING_LEVELS } from "../../core/agent-session-types.js";
import { runCallback } from "../../core/callback-activity.ts";
import { setDebugSetting } from "../../core/debug-setting.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import type { SessionTrustDecisions } from "../../core/project-trust-state.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { isLeafMoveEntry } from "../../core/session-manager-history.ts";
import { settingsWriteOwner } from "../../core/settings-write-ownership.ts";
import { getSkillCatalog } from "../../core/skill-catalog.ts";
import { sourceError } from "../../core/tasks/agent-panel-source.ts";
import { stopAllBackgroundWork } from "../../core/tasks/stop-all.ts";
import {
	deleteWorkflowFromPicker,
	listWorkflowResumeEntries,
	resumeWorkflowFromPicker,
} from "../../core/workflow-resume.ts";
import { isInteractiveEngineChild } from "../../utils/interactive-engine-env.ts";
import { STOP_ALL_STATUS_KEY } from "../interactive/interactive-stop-all.ts";
import { showAgentPanel } from "./agent-panel-bridge.ts";
import { RpcBashRequestOwners } from "./rpc-bash-request-owners.ts";
import { outputExtensionLoadErrors } from "./rpc-extension-load-errors.ts";
import type { RpcExtensionUICapabilities, RpcPendingExtensionRequests } from "./rpc-extension-ui.ts";
import type { KeybindingsReloadCoordinator } from "./rpc-keybindings-reload.ts";
import { createRpcModelCatalog } from "./rpc-model-catalog.ts";
import { rejectUnsupportedProviderPrompt } from "./rpc-model-fallback-prompt.ts";
import { type ProviderLoginInput, RpcProviderAuth } from "./rpc-provider-auth.ts";
import {
	createRpcErrorResponse,
	createRpcSuccessResponse,
	formatRpcErrorMessage,
	type RpcOutput,
} from "./rpc-responses.ts";
import type {
	RpcCommand,
	RpcForkMessagePage,
	RpcPersistedModelDefaults,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
	RpcTreePage,
} from "./rpc-types.ts";
import { type EngineTaskInspectorMount, engineTaskInspectorUi, showEngineTaskInspector } from "./task-ui-bridge.js";

export type RpcCommandHandler = (command: RpcCommand) => Promise<RpcResponse | undefined>;

export type ManagedRpcCommandHandler = RpcCommandHandler & { disposeActiveBash(): Promise<void> };

interface RpcCommandHandlerOptions {
	runtimeHost: AgentSessionRuntime;
	getSession: () => AgentSession;
	rebindSession: () => Promise<void>;
	output: RpcOutput;
	keybindings?: KeybindingsManager;
	taskInspectorUi?: EngineTaskInspectorMount;
	reloadCoordinator?: KeybindingsReloadCoordinator<AgentSession>;
	inputForm?: ProviderLoginInput;
	pendingExtensionRequests?: RpcPendingExtensionRequests;
	extensionUICapabilities?: RpcExtensionUICapabilities;
	waitForResources?: () => Promise<void> | undefined;
	reloadResources?: () => Promise<void>;
	shouldRetryResources?: () => boolean;
	/**
	 * Answer `compact` when it settles without holding the ordered command lane, so an interactive
	 * host can still run UI and admin commands meanwhile. The host keeps prompts queued itself.
	 */
	detachCompaction?: boolean;
	beginCommand?: () => () => void;
}

function persistedModelDefaults(session: AgentSession, persist?: boolean): RpcPersistedModelDefaults | undefined {
	if (!persist) return undefined;
	const settings = session.settingsManager.getGlobalSettings();
	const provider = settings.defaultProvider;
	const modelId = settings.defaultModel;
	const defaultThinkingLevel = settings.defaultThinkingLevel;
	if (!provider || !modelId || defaultThinkingLevel === undefined) return undefined;
	const thinkingLevel = settings.modelThinkingLevels?.[`${normalizeProviderId(provider)}/${modelId}`];
	if (thinkingLevel === undefined) return undefined;
	return { provider, modelId, thinkingLevel, defaultThinkingLevel };
}

/** Commands of removed features that still succeed without effect, so older clients keep working. */
const REMOVED_NO_OP_COMMANDS: ReadonlySet<string> = new Set([
	"set_background_compaction",
	"set_background_compaction_threshold",
]);

function compactOptions(instructions: string | undefined): { query?: string } {
	return typeof instructions === "string" && instructions.trim() ? { query: instructions } : {};
}

/** The trust decisions an interactive engine child made, which its host hands to an engine that replaces it. */
function trustDecisionsState(decisions: SessionTrustDecisions | undefined): Pick<RpcSessionState, "trustDecisions"> {
	if (!decisions || !isInteractiveEngineChild()) return {};
	const count = Object.keys(decisions.projects).length + Object.keys(decisions.extensionSources).length;
	return count > 0 ? { trustDecisions: decisions } : {};
}

function canRunBeforeOptionalResources(command: RpcCommand): boolean {
	switch (command.type) {
		case "abort":
		case "abort_bash":
		case "abort_compaction":
		case "abort_branch_summary":
		case "abort_retry":
		case "cancel_login_provider":
		case "clear_queue":
		case "get_entries":
		case "get_context_window":
		case "get_history_chunk":
		case "get_messages":
		case "get_state":
		case "pause_queued_messages":
		case "resume_queued_messages":
		case "set_auto_compaction":
		case "set_auto_retry":
		case "set_debug":
		case "set_extension_ui_capabilities":
		case "set_follow_up_mode":
		case "set_steering_mode":
			return true;
		case "get_available_models":
			return command.allowPartialResources === true;
		default:
			return REMOVED_NO_OP_COMMANDS.has((command as { type: string }).type);
	}
}

export function createRpcCommandHandler({
	runtimeHost,
	getSession,
	rebindSession,
	output,
	keybindings,
	taskInspectorUi,
	reloadCoordinator,
	inputForm,
	pendingExtensionRequests,
	extensionUICapabilities,
	waitForResources,
	reloadResources,
	shouldRetryResources,
	detachCompaction,
	beginCommand,
}: RpcCommandHandlerOptions): ManagedRpcCommandHandler {
	let fallbackShortcutKeybindings: KeybindingsManager | undefined;
	/** The session whose queue hold an `abort` established; the next `prompt` releases it, as a TUI submission does. */
	let abortPausedSession: AgentSession | undefined;
	const providerAuth = new RpcProviderAuth(inputForm, {
		output,
		pending: pendingExtensionRequests ?? new Map(),
	});
	const bashOwners = new RpcBashRequestOwners(output);
	let agentPanelShowing = false;
	const getShortcutBindings = async () => {
		if (keybindings) return keybindings.getEffectiveConfig();
		fallbackShortcutKeybindings ??= new KeybindingsManager(
			{},
			join(runtimeHost.services.agentDir, "keybindings.json"),
		);
		await fallbackShortcutKeybindings.reloadAsync();
		return fallbackShortcutKeybindings.getEffectiveConfig();
	};
	const handleCommand = (async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;
		const retryFailedResources = command.type === "reload" && shouldRetryResources?.() === true;
		if (command.type !== "prompt" && !retryFailedResources && !canRunBeforeOptionalResources(command)) {
			const pendingResources = waitForResources?.();
			if (pendingResources) await pendingResources;
		}
		const session = getSession();
		switch (command.type) {
			case "open_task_inspector": {
				if (!keybindings || !taskInspectorUi)
					return createRpcErrorResponse(id, command.type, "Task inspection requires an interactive host");
				const ui = session.extensionRunner.getUIContext();
				void showEngineTaskInspector(session, engineTaskInspectorUi(ui, taskInspectorUi), command.taskId).catch(
					(error: unknown) => ui.notify(sourceError(error).message, "error"),
				);
				return createRpcSuccessResponse(id, command.type);
			}
			case "open_agent_panel": {
				if (!keybindings || !taskInspectorUi)
					return createRpcErrorResponse(id, command.type, "The agent panel requires an interactive host");
				if (agentPanelShowing) return createRpcSuccessResponse(id, command.type);
				agentPanelShowing = true;
				const ui = session.extensionRunner.getUIContext();
				void showAgentPanel(session, engineTaskInspectorUi(ui, taskInspectorUi))
					.catch((error: unknown) => ui.notify(sourceError(error).message, "error"))
					.finally(() => {
						agentPanelShowing = false;
					});
				return createRpcSuccessResponse(id, command.type);
			}
			case "set_stop_all_notice": {
				session.extensionRunner.getUIContext().setStatus(STOP_ALL_STATUS_KEY, command.text);
				return createRpcSuccessResponse(id, command.type);
			}
			case "stop_all_background": {
				return createRpcSuccessResponse(id, command.type, await stopAllBackgroundWork(session));
			}
			case "prompt": {
				const finishCommand = beginCommand?.();
				let preflightSucceeded = false;
				let acceptedAsQueued = false;
				void (async () => {
					const pendingResources = waitForResources?.();
					if (pendingResources) await pendingResources;
					if (rejectUnsupportedProviderPrompt(runtimeHost, output, id)) return;
					const promptSession = getSession();
					if (abortPausedSession === promptSession) {
						abortPausedSession = undefined;
						await promptSession.resumeQueuedMessages();
					}
					await promptSession.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed, disposition) => {
							if (didSucceed) {
								preflightSucceeded = true;
								acceptedAsQueued = disposition === "queued";
								output(createRpcSuccessResponse(id, "prompt", { disposition }));
							}
						},
					});
				})()
					.catch((promptError: unknown) => {
						if (!preflightSucceeded) {
							output(createRpcErrorResponse(id, "prompt", formatRpcErrorMessage(promptError), promptError));
						} else if (acceptedAsQueued) {
							// Input held during compaction is answered as queued before its turn is prepared. If that
							// preparation fails, the session keeps the input queued; tell the client why, once (#4251).
							output({
								type: "agent_continue_error",
								source: "post_compaction",
								errorMessage: `Failed to send queued message: ${formatRpcErrorMessage(promptError)}`,
							});
						}
					})
					.finally(() => finishCommand?.());
				return undefined;
			}

			case "steer": {
				const disposition = await session.steer(command.message, command.images, { source: "rpc" });
				return createRpcSuccessResponse(id, "steer", { disposition });
			}

			case "follow_up": {
				const disposition = await session.followUp(command.message, command.images, { source: "rpc" });
				return createRpcSuccessResponse(id, "follow_up", { disposition });
			}

			case "abort": {
				// Hold queued messages before aborting, as the TUI does, so a protected notice still queued is saved
				// when the session closes instead of failing its disposal (#5166).
				if (!session.queuedMessagesPaused) abortPausedSession = session;
				await session.abort({ pauseQueuedMessages: true });
				return createRpcSuccessResponse(id, "abort");
			}
			case "new_session": {
				const options = command.parentSession !== undefined ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return createRpcSuccessResponse(id, "new_session", result);
			}
			case "delete_session": {
				const sessionId = command.sessionId ?? id;
				if (!sessionId) return createRpcErrorResponse(id, "delete_session", "delete_session requires sessionId");
				await session.sessionManager.deleteSession(sessionId);
				return createRpcSuccessResponse(id, "delete_session");
			}

			case "get_session_summary": {
				// An unsaved (--no-session) session never appears in /resume, so it has no summary to report (#4726).
				const summary = session.sessionManager.isPersisted() ? (session.sessionSummary ?? null) : null;
				return createRpcSuccessResponse(id, command.type, { summary });
			}
			case "list_sessions": {
				const sessions = await SessionManager.list(
					runtimeHost.services.cwd,
					session.sessionManager.getSessionStore(),
				);
				return createRpcSuccessResponse(id, command.type, {
					sessions: sessions.map((info) => ({
						...info,
						created: info.created.toISOString(),
						modified: info.modified.toISOString(),
					})),
				});
			}
			case "list_workflow_runs":
				return createRpcSuccessResponse(id, command.type, {
					runs: await session.workflows.listRuns({ status: command.status, includeDurable: true }),
				});
			case "get_workflow_run_summary":
				return createRpcSuccessResponse(id, command.type, await session.workflows.getRun(command.runId));
			case "get_workflow_resume_entries": {
				try {
					return createRpcSuccessResponse(id, command.type, {
						entries: await listWorkflowResumeEntries(session, command.target),
					});
				} catch (error: unknown) {
					return createRpcErrorResponse(id, command.type, formatRpcErrorMessage(error), error);
				}
			}
			case "resume_workflow_from_picker": {
				try {
					return createRpcSuccessResponse(id, command.type, {
						handled: await resumeWorkflowFromPicker(session, command.target),
					});
				} catch (error: unknown) {
					return createRpcErrorResponse(id, command.type, formatRpcErrorMessage(error), error);
				}
			}
			case "delete_workflow_from_picker": {
				try {
					await deleteWorkflowFromPicker(session, command.runId);
					return createRpcSuccessResponse(id, command.type);
				} catch (error: unknown) {
					return createRpcErrorResponse(id, command.type, formatRpcErrorMessage(error), error);
				}
			}

			case "get_state": {
				const extensionResult = session.resourceLoader.getExtensions();
				const state: RpcSessionState = {
					model: session.model,
					modelFallbackMessage: runtimeHost.modelFallbackMessage,
					modelFallbackReason: runtimeHost.modelFallbackReason,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					retryStatus: session.retryStatus,
					isCompacting: session.isCompacting,
					compactionReason: session.compactionReason,
					...(session.compactionStartedAt === undefined
						? {}
						: { compactionStartedAt: session.compactionStartedAt }),
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					...(session.sessionFile ? { sessionLocation: session.sessionFile } : {}),
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
					queuedMessagesPaused: session.queuedMessagesPaused,
					// No report while startup is still deciding: the settings read untrusted until then (see isProjectTrustPending).
					...(runtimeHost.isProjectTrustPending?.()
						? {}
						: { projectTrusted: session.settingsManager.isProjectTrusted?.() === true }),
					...trustDecisionsState(runtimeHost.trustDecisions?.()),
					resourceOverlaps: extensionResult.overlaps ?? [],
					resourceErrors: extensionResult.errors,
					resourceWarnings: extensionResult.warnings ?? [],
					resourceExtensions: extensionResult.extensions.map((extension) => ({
						path: extension.path,
						sourceInfo: extension.sourceInfo,
						hidden: extension.hidden === true,
					})),
				};
				return createRpcSuccessResponse(id, "get_state", state);
			}
			case "set_model": {
				if (command.thinkingLevel !== undefined && !THINKING_LEVELS.includes(command.thinkingLevel)) {
					return createRpcErrorResponse(
						id,
						"set_model",
						`Invalid thinkingLevel: expected one of ${THINKING_LEVELS.join(", ")}`,
					);
				}
				const models = await session.modelRuntime.getAvailableSnapshot();
				const model = models.find(
					(candidate) => candidate.provider === command.provider && candidate.id === command.modelId,
				);
				if (!model) {
					return createRpcErrorResponse(
						id,
						"set_model",
						`Model not found: ${command.provider}/${command.modelId}`,
					);
				}
				await session.setModel(model, {
					...(command.persist === true ? { persist: true } : {}),
					...(command.thinkingLevel !== undefined ? { thinkingLevel: command.thinkingLevel } : {}),
				});
				runtimeHost.resolveModelFallback();
				const persistedDefaults = persistedModelDefaults(session, command.persist === true);
				return createRpcSuccessResponse(id, "set_model", {
					...(session.model ?? model),
					...(persistedDefaults ? { persistedDefaults } : {}),
				});
			}
			case "cycle_model": {
				const previousModel = session.model;
				const result = await session.cycleModel(
					command.direction,
					command.persist === true ? { persist: true } : {},
				);
				runtimeHost.resolveModelFallbackAfterExplicitModelSelection(previousModel, result?.model);
				const persistedDefaults = result ? persistedModelDefaults(session, command.persist === true) : undefined;
				return createRpcSuccessResponse(
					id,
					"cycle_model",
					result ? { ...result, ...(persistedDefaults ? { persistedDefaults } : {}) } : null,
				);
			}
			case "get_available_models":
				return createRpcSuccessResponse(id, "get_available_models", createRpcModelCatalog(session));

			case "set_scoped_models": {
				const models = await session.modelRuntime.getAvailableSnapshot();
				const scopedModels: Array<{ model: Model<Api>; thinkingLevel?: (typeof THINKING_LEVELS)[number] }> = [];
				for (const entry of command.models) {
					if (entry.thinkingLevel !== undefined && !THINKING_LEVELS.includes(entry.thinkingLevel)) {
						return createRpcErrorResponse(
							id,
							"set_scoped_models",
							`Invalid thinkingLevel: expected one of ${THINKING_LEVELS.join(", ")}`,
						);
					}
					const model =
						models.find((candidate) => candidate.provider === entry.provider && candidate.id === entry.modelId) ??
						session.modelRuntime.getModel(entry.provider, entry.modelId);
					if (model) {
						scopedModels.push({
							model,
							...(entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}),
						});
					}
				}
				session.setScopedModels(scopedModels);
				if (command.enabledModels !== undefined) {
					const nextEnabledModels = command.enabledModels === null ? undefined : [...command.enabledModels];
					const currentEnabledModels = session.settingsManager.getGlobalSettings().enabledModels;
					const unchanged =
						nextEnabledModels === undefined
							? currentEnabledModels === undefined
							: currentEnabledModels !== undefined &&
								currentEnabledModels.length === nextEnabledModels.length &&
								currentEnabledModels.every((value, index) => value === nextEnabledModels[index]);
					if (!unchanged) {
						settingsWriteOwner.run(session, () => session.settingsManager.setEnabledModels(nextEnabledModels));
					}
				}
				return createRpcSuccessResponse(id, "set_scoped_models", createRpcModelCatalog(session));
			}

			case "login_provider": {
				const result =
					command.authType === "oauth"
						? await providerAuth.loginOAuth(session, command.provider, command.loginId)
						: await providerAuth.login(session, command.provider, command.loginId);
				return createRpcSuccessResponse(id, "login_provider", result);
			}

			case "save_provider_credential":
				return createRpcSuccessResponse(
					id,
					"save_provider_credential",
					await providerAuth.save(session, command.provider, command.credential, {
						refreshCatalog: command.refreshCatalog,
					}),
				);

			case "cancel_login_provider":
				providerAuth.cancel(command.provider, command.loginId);
				return createRpcSuccessResponse(id, "cancel_login_provider");

			case "logout_provider": {
				const result = await runtimeHost.logoutProvider(command.provider);
				return createRpcSuccessResponse(id, "logout_provider", result);
			}
			case "refresh_models": {
				const controller = command.timeoutMs === undefined ? undefined : new AbortController();
				const timedOut = Symbol("model refresh timed out");
				let timeout: ReturnType<typeof setTimeout> | undefined;
				const timeoutResult =
					controller && command.timeoutMs !== undefined
						? new Promise<typeof timedOut>((resolve) => {
								timeout = setTimeout(() => {
									controller.abort();
									resolve(timedOut);
								}, command.timeoutMs);
							})
						: undefined;
				try {
					const refresh = (async () => {
						await session.modelRuntime.reloadCredentials({ refreshAvailability: false });
						if (controller?.signal.aborted) return { aborted: true, errors: new Map<string, Error>() };
						return session.modelRuntime.refresh({
							allowNetwork: command.allowNetwork,
							force: command.force,
							signal: controller?.signal,
						});
					})();
					const outcome = timeoutResult ? await Promise.race([refresh, timeoutResult]) : await refresh;
					const result = outcome === timedOut ? { aborted: true, errors: new Map<string, Error>() } : outcome;
					return createRpcSuccessResponse(id, "refresh_models", {
						aborted: result.aborted,
						errors: [...result.errors].map(([provider, error]) => ({ provider, message: error.message })),
						...createRpcModelCatalog(session),
					});
				} finally {
					if (timeout) clearTimeout(timeout);
				}
			}

			case "set_thinking_level": {
				await session.setThinkingLevel(command.level, command.persist === true ? { persist: true } : {});
				const model = session.model;
				return createRpcSuccessResponse(id, "set_thinking_level", {
					level: session.thinkingLevel,
					...(model ? { provider: model.provider, modelId: model.id } : {}),
				});
			}

			case "cycle_thinking_level": {
				const level = await session.cycleThinkingLevel();
				return createRpcSuccessResponse(id, "cycle_thinking_level", level ? { level } : null);
			}

			case "get_available_thinking_levels": {
				return createRpcSuccessResponse(id, "get_available_thinking_levels", {
					levels: session.getAvailableThinkingLevels(),
				});
			}

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return createRpcSuccessResponse(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return createRpcSuccessResponse(id, "set_follow_up_mode");
			}

			case "compact": {
				if (detachCompaction) {
					const finishCommand = beginCommand?.();
					void session
						.compact(compactOptions(command.instructions))
						.then(
							(result) => output(createRpcSuccessResponse(id, "compact", result)),
							(compactError: unknown) =>
								output(
									createRpcErrorResponse(id, "compact", formatRpcErrorMessage(compactError), compactError),
								),
						)
						.finally(() => finishCommand?.());
					return undefined;
				}
				const result = await session.compact(compactOptions(command.instructions));
				return createRpcSuccessResponse(id, "compact", result);
			}

			case "set_auto_compaction":
				session.setAutoCompactionEnabled(command.enabled);
				return createRpcSuccessResponse(id, "set_auto_compaction");
			case "abort_compaction":
				session.abortCompaction();
				return createRpcSuccessResponse(id, "abort_compaction");
			case "abort_branch_summary":
				session.abortBranchSummary();
				return createRpcSuccessResponse(id, "abort_branch_summary");
			case "set_extension_ui_capabilities":
				if (extensionUICapabilities && command.questionnaire !== undefined)
					extensionUICapabilities.questionnaire = command.questionnaire === true;
				return createRpcSuccessResponse(id, "set_extension_ui_capabilities");

			case "set_debug":
				setDebugSetting(command.enabled, "rpc");
				return createRpcSuccessResponse(id, "set_debug");

			case "set_auto_retry":
				session.setAutoRetryEnabled(command.enabled);
				return createRpcSuccessResponse(id, "set_auto_retry");
			case "abort_retry":
				session.abortRetry();
				return createRpcSuccessResponse(id, "abort_retry");

			case "clear_queue": {
				return createRpcSuccessResponse(id, "clear_queue", session.clearQueue());
			}
			case "pause_queued_messages":
				abortPausedSession = undefined;
				session.pauseQueuedMessages();
				return createRpcSuccessResponse(id, "pause_queued_messages");
			case "resume_queued_messages":
				abortPausedSession = undefined;
				return createRpcSuccessResponse(id, "resume_queued_messages", {
					released: await session.resumeQueuedMessages(),
				});
			case "bash": {
				const result = await bashOwners.run(
					{
						id,
						session,
						command: command.command,
						excludeFromContext: command.excludeFromContext,
						isCurrent: () => getSession() === session,
					},
					// A `bash` command is still a user-initiated shell request, so it must
					// reach `user_bash` handlers (sandboxes, remote shells) exactly like the
					// `user_bash` command does. Ownership, streaming correlation, and result
					// recording stay with the owning request either way.
					async (onUpdate) => {
						const intercepted = await session.extensionRunner.emitUserBash({
							type: "user_bash",
							command: command.command,
							excludeFromContext: command.excludeFromContext === true,
							cwd: session.sessionManager.getCwd(),
						});
						if (intercepted?.result) return intercepted.result;
						return session.executeBash(command.command, onUpdate, {
							excludeFromContext: command.excludeFromContext,
							id,
							operations: intercepted?.operations,
							emitEvent: false,
							recordResult: false,
						});
					},
				);
				return createRpcSuccessResponse(id, "bash", result);
			}
			case "user_bash": {
				const result = await bashOwners.run(
					{
						id,
						session,
						command: command.command,
						excludeFromContext: command.excludeFromContext,
						isCurrent: () => getSession() === session,
					},
					async (onUpdate) => {
						const intercepted = await session.extensionRunner.emitUserBash({
							type: "user_bash",
							command: command.command,
							excludeFromContext: command.excludeFromContext === true,
							cwd: session.sessionManager.getCwd(),
						});
						if (intercepted?.result) return intercepted.result;
						return session.executeBash(command.command, onUpdate, {
							excludeFromContext: command.excludeFromContext,
							id,
							operations: intercepted?.operations,
							emitEvent: false,
							recordResult: false,
						});
					},
				);
				return createRpcSuccessResponse(id, "user_bash", result);
			}
			case "abort_bash":
				bashOwners.abort(command.requestId);
				session.abortBash(command.requestId);
				return createRpcSuccessResponse(id, "abort_bash");

			case "get_session_stats": {
				return createRpcSuccessResponse(id, "get_session_stats", session.getSessionStats());
			}

			case "get_tools": {
				return createRpcSuccessResponse(id, "get_tools", await session.getToolStatusAsync());
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return createRpcSuccessResponse(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionId, {
					cwdOverride: command.cwdOverride,
					sessionDirectory: command.sessionDirectory,
					history: "tail",
				});
				if (!result.cancelled) {
					await rebindSession();
				}
				return createRpcSuccessResponse(id, "switch_session", {
					...result,
					notices: runtimeHost.takeResumeNotices(),
				});
			}

			case "import_session": {
				const result = await runtimeHost.importFromJsonl(command.inputPath, command.cwdOverride);
				if (!result.cancelled) await rebindSession();
				return createRpcSuccessResponse(id, "import_session", {
					...result,
					notices: runtimeHost.takeResumeNotices(),
				});
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return createRpcSuccessResponse(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return createRpcErrorResponse(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await rebindSession();
				}
				return createRpcSuccessResponse(id, "clone", { cancelled: result.cancelled });
			}

			case "get_context_window":
				return createRpcSuccessResponse(id, command.type, {
					entries: session.sessionManager.getEntries(),
					leafId: session.sessionManager.getLeafId(),
				});

			case "get_history_chunk": {
				const next = await session.sessionManager
					.readHistoryChunks(command.reference, { offset: command.offset })
					.next();
				const bytes = next.done ? new Uint8Array() : next.value;
				const end = command.offset + bytes.byteLength;
				return createRpcSuccessResponse(id, command.type, {
					data: Buffer.from(bytes).toString("base64"),
					...(end < command.reference.bytes ? { nextOffset: end } : {}),
				});
			}
			case "get_entries":
			case "get_fork_messages":
			case "get_tree": {
				const manager = session.sessionManager;
				const leafId = manager.getLeafId();
				let fromSeq = command.type === "get_entries" ? command.fromSeq : undefined;
				if (command.type === "get_entries" && command.since !== undefined) {
					if (command.cursor !== undefined || fromSeq !== undefined)
						return createRpcErrorResponse(id, command.type, "Use since, fromSeq or cursor, not a combination");
					const at = await manager.findEntrySeq(command.since);
					if (at === undefined)
						return createRpcErrorResponse(id, command.type, `Entry not found: ${command.since}`);
					fromSeq = at + 1;
				}
				const reader = manager.readHistory({
					fromSeq,
					toSeq: command.type === "get_entries" ? command.toSeq : undefined,
					cursor: command.cursor,
				});
				const first = await reader.next();
				const page = first.done ? { items: [] } : first.value;
				if (command.type === "get_entries") return createRpcSuccessResponse(id, command.type, { ...page, leafId });
				if (command.type === "get_tree") {
					const items: RpcTreePage["items"][number][] = [];
					for (const item of page.items) {
						if (!("entry" in item)) items.push(item);
						else if (!isLeafMoveEntry(item.entry))
							items.push({
								...item,
								label: manager.getLabel(item.entry.id),
								labelTimestamp: manager.getLabelTimestamp(item.entry.id),
							});
					}
					return createRpcSuccessResponse(id, command.type, { ...page, items, leafId });
				}
				const items: RpcForkMessagePage["items"][number][] = [];
				for (const item of page.items) {
					if (!("entry" in item)) {
						items.push(item);
						continue;
					}
					const { entry, seq } = item;
					if (entry.type !== "message" || entry.message.role !== "user") continue;
					const text =
						typeof entry.message.content === "string"
							? entry.message.content
							: entry.message.content
									.filter((block) => block.type === "text")
									.map((block) => block.text)
									.join("");
					if (text) items.push({ entryId: entry.id, seq, text });
				}
				return createRpcSuccessResponse(id, command.type, { ...page, items });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return createRpcSuccessResponse(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return createRpcErrorResponse(id, "set_session_name", "Session name cannot be empty");
				}
				await session.setSessionName(name);
				return createRpcSuccessResponse(id, "set_session_name");
			}

			case "navigate_tree": {
				const result = await session.navigateTree(command.targetId, command.options);
				return createRpcSuccessResponse(id, "navigate_tree", {
					cancelled: result.cancelled,
					aborted: result.aborted,
					editorText: result.editorText,
					summaryEntry: result.summaryEntry,
				});
			}

			case "set_label": {
				const entryId = await session.sessionManager.appendLabelChange(command.entryId, command.label);
				return createRpcSuccessResponse(id, "set_label", { entryId });
			}

			case "reload": {
				// Retrying failed startup resources reports its load errors as the startup load does.
				if (retryFailedResources && reloadResources) await reloadResources();
				else {
					try {
						if (reloadCoordinator) await reloadCoordinator.reload(session);
						else await session.reload();
					} finally {
						outputExtensionLoadErrors(session, "reload", output);
					}
				}
				return createRpcSuccessResponse(id, "reload");
			}

			case "start_pending_recovery": {
				return createRpcSuccessResponse(
					id,
					"start_pending_recovery",
					await session.startPendingRecovery(command.reason),
				);
			}

			case "get_shortcuts": {
				const effectiveBindings = await getShortcutBindings();
				const shortcuts = session.extensionRunner.getShortcuts(effectiveBindings);
				return createRpcSuccessResponse(id, "get_shortcuts", {
					shortcuts: [...shortcuts].map(([key, shortcut]) => ({ key, description: shortcut.description })),
				});
			}

			case "invoke_shortcut": {
				const shortcut = session.extensionRunner
					.getShortcuts(await getShortcutBindings())
					.get(command.key as KeyId);
				if (!shortcut) return createRpcErrorResponse(id, "invoke_shortcut", `Shortcut not found: ${command.key}`);
				await runCallback(
					{ kind: "extension.hook", name: `shortcut:${command.key}`, sourcePath: shortcut.extensionPath },
					() => shortcut.handler(session.extensionRunner.createContext()),
				);
				return createRpcSuccessResponse(id, "invoke_shortcut");
			}

			case "get_messages": {
				return createRpcSuccessResponse(id, "get_messages", { messages: session.messages });
			}

			case "get_command_completions": {
				const registeredCommand = session.extensionRunner
					.getRegisteredCommands()
					.find((candidate) => candidate.invocationName === command.commandName);
				const getArgumentCompletions = registeredCommand?.getArgumentCompletions;
				if (registeredCommand === undefined || getArgumentCompletions === undefined) {
					return createRpcSuccessResponse(id, "get_command_completions", { completions: null });
				}
				const completions = await runCallback(
					{
						kind: "extension.hook",
						name: `command-completions:${command.commandName}`,
						sourcePath: registeredCommand.sourceInfo.path,
					},
					() => getArgumentCompletions(command.argumentPrefix),
				);
				return createRpcSuccessResponse(id, "get_command_completions", { completions });
			}

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const registeredCommand of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: registeredCommand.invocationName,
						description: registeredCommand.description,
						...(registeredCommand.getArgumentCompletions !== undefined ? { hasArgumentCompletions: true } : {}),
						source: "extension",
						sourceInfo: registeredCommand.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skillCommand of getSkillCatalog(session.resourceLoader).commands) {
					commands.push({
						name: `skill:${skillCommand.name}`,
						description: skillCommand.description,
						source: "skill",
						sourceInfo: skillCommand.sourceInfo,
					});
				}

				return createRpcSuccessResponse(id, "get_commands", { commands });
			}
			default: {
				const unknownCommand = command as { type: string };
				// Background compaction was removed; its commands still succeed so older clients keep working.
				if (REMOVED_NO_OP_COMMANDS.has(unknownCommand.type)) {
					return { id, type: "response", command: unknownCommand.type, success: true } as RpcResponse;
				}
				return createRpcErrorResponse(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	}) as ManagedRpcCommandHandler;
	handleCommand.disposeActiveBash = () => bashOwners.dispose();
	return handleCommand;
}
