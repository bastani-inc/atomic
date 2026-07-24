import type { KeyId } from "@earendil-works/pi-tui";
import { runCallback } from "../../core/callback-activity.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	createRpcErrorResponse,
	createRpcSuccessResponse,
	formatRpcErrorMessage,
	parseRpcContextWindow,
	type RpcOutput,
} from "./rpc-responses.ts";
import type { KeybindingsReloadCoordinator } from "./rpc-keybindings-reload.ts";
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "./rpc-types.ts";

export type RpcCommandHandler = (command: RpcCommand) => Promise<RpcResponse | undefined>;

interface ProviderLoginInput {
	open(
		request: import("../../core/extensions/ui-types.ts").HostInputFormRequest,
		signal?: AbortSignal,
	): Promise<Record<string, string> | undefined>;
}

interface RpcCommandHandlerOptions {
	runtimeHost: AgentSessionRuntime;
	getSession: () => AgentSession;
	rebindSession: () => Promise<void>;
	output: RpcOutput;
	keybindings?: KeybindingsManager;
	reloadCoordinator?: KeybindingsReloadCoordinator<AgentSession>;
	inputForm?: ProviderLoginInput;
}

export function createRpcCommandHandler({
	runtimeHost,
	getSession,
	rebindSession,
	output,
	keybindings,
	reloadCoordinator,
	inputForm,
}: RpcCommandHandlerOptions): RpcCommandHandler {
	let fallbackShortcutKeybindings: KeybindingsManager | undefined;
	const providerLoginControllers = new Map<string, AbortController>();
	const getShortcutBindings = () => {
		if (keybindings) return keybindings.getEffectiveConfig();
		if (fallbackShortcutKeybindings) fallbackShortcutKeybindings.reload();
		else fallbackShortcutKeybindings = KeybindingsManager.create(runtimeHost.services.agentDir);
		return fallbackShortcutKeybindings.getEffectiveConfig();
	};
	return async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;
		const session = getSession();
		switch (command.type) {
			case "prompt": {
				if (runtimeHost.modelFallbackReason === "configured-provider-unsupported") {
					const message = runtimeHost.modelFallbackMessage;
					if (!message) throw new Error("Unsupported configured provider is missing its diagnostic message");
					output(createRpcErrorResponse(id, "prompt", message));
					return undefined;
				}
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(createRpcSuccessResponse(id, "prompt"));
							}
						},
					})
					.catch((promptError: unknown) => {
						if (!preflightSucceeded) {
							output(createRpcErrorResponse(id, "prompt", formatRpcErrorMessage(promptError)));
						}
					});
				return undefined;
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return createRpcSuccessResponse(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return createRpcSuccessResponse(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return createRpcSuccessResponse(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return createRpcSuccessResponse(id, "new_session", result);
			}

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
					resourceOverlaps: session.resourceLoader.getExtensions().overlaps ?? [],
				};
				return createRpcSuccessResponse(id, "get_state", state);
			}

			case "set_model": {
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((candidate) => candidate.provider === command.provider && candidate.id === command.modelId);
				if (!model) {
					return createRpcErrorResponse(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				runtimeHost.resolveModelFallback();
				return createRpcSuccessResponse(id, "set_model", session.model ?? model);
			}

			case "cycle_model": {
				const result = await session.cycleModel(command.direction);
				return createRpcSuccessResponse(id, "cycle_model", result ?? null);
			}

			case "get_available_models": {
				const models = await session.modelRegistry.getAvailable();
				return createRpcSuccessResponse(id, "get_available_models", {
					models,
					scopedModels: session.scopedModels,
					customAuthProviders: session.modelRegistry.getCustomApiKeyAuthProviders(),
				});
			}

			case "login_provider": {
				const customAuth = session.modelRegistry.getCustomApiKeyAuth(command.provider);
				if (!customAuth) throw new Error(`Provider does not support custom API-key login: ${command.provider}`);
				if (!inputForm) throw new Error("Provider login requires an interactive input host");
				if (providerLoginControllers.has(command.provider)) throw new Error(`Login already in progress: ${command.provider}`);
				const controller = new AbortController();
				providerLoginControllers.set(command.provider, controller);
				try {
					const credential = await customAuth.login({
						signal: controller.signal,
						prompt: async (prompt) => {
							const values = await inputForm.open({
								title: prompt.message,
								heading: "PROVIDER LOGIN",
								submitLabel: "[ Submit ]",
								fields: [{
									name: "value", type: "string", required: false, initialValue: "",
									placeholder: prompt.placeholder,
								}],
							}, controller.signal);
							if (!values || controller.signal.aborted) throw new Error("Login cancelled");
							return values.value ?? "";
						},
					});
					if (controller.signal.aborted) return createRpcSuccessResponse(id, "login_provider", { provider: command.provider, cancelled: true });
					session.modelRegistry.authStorage.set(command.provider, credential);
					await session.modelRegistry.refresh();
					return createRpcSuccessResponse(id, "login_provider", {
						provider: command.provider, cancelled: false, credential,
						models: session.modelRegistry.getAvailable(),
						scopedModels: session.scopedModels,
						customAuthProviders: session.modelRegistry.getCustomApiKeyAuthProviders(),
					});
				} catch (error) {
					if (controller.signal.aborted || (error instanceof Error && error.message === "Login cancelled")) {
						return createRpcSuccessResponse(id, "login_provider", { provider: command.provider, cancelled: true });
					}
					throw error;
				} finally {
					if (providerLoginControllers.get(command.provider) === controller) providerLoginControllers.delete(command.provider);
				}
			}

			case "cancel_login_provider": {
				providerLoginControllers.get(command.provider)?.abort();
				return createRpcSuccessResponse(id, "cancel_login_provider");
			}

			case "logout_provider": {
				const result = await runtimeHost.logoutProvider(command.provider);
				return createRpcSuccessResponse(id, "logout_provider", result);
			}
			case "refresh_models": {
				session.modelRegistry.authStorage.reload();
				const result = await session.modelRegistry.refresh({
					timeoutMs: command.timeoutMs,
					force: command.force,
					allowNetwork: command.allowNetwork,
				});
				return createRpcSuccessResponse(id, "refresh_models", {
					aborted: result.aborted,
					errors: [...result.errors].map(([provider, error]) => ({ provider, message: error.message })),
					models: session.modelRegistry.getAvailable(),
					scopedModels: session.scopedModels,
					customAuthProviders: session.modelRegistry.getCustomApiKeyAuthProviders(),
				});
			}

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return createRpcSuccessResponse(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				return createRpcSuccessResponse(id, "cycle_thinking_level", level ? { level } : null);
			}

			case "get_available_thinking_levels": {
				return createRpcSuccessResponse(id, "get_available_thinking_levels", {
					levels: session.getAvailableThinkingLevels(),
				});
			}

			case "set_context_window": {
				const contextWindow = parseRpcContextWindow(command.contextWindow);
				session.setContextWindow(contextWindow);
				return createRpcSuccessResponse(id, "set_context_window");
			}

			case "get_available_context_windows": {
				return createRpcSuccessResponse(id, "get_available_context_windows", {
					contextWindows: session.getAvailableContextWindows(),
					currentContextWindow: session.model?.contextWindow,
					supportsSelection: session.supportsContextWindowSelection(),
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
				const result = await session.compact();
				return createRpcSuccessResponse(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return createRpcSuccessResponse(id, "set_auto_compaction");
			}

			case "abort_compaction": {
				session.abortCompaction();
				return createRpcSuccessResponse(id, "abort_compaction");
			}

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return createRpcSuccessResponse(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return createRpcSuccessResponse(id, "abort_retry");
			}

			case "clear_queue": {
				return createRpcSuccessResponse(id, "clear_queue", session.clearQueue());
			}

			case "bash": {
				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
				});
				return createRpcSuccessResponse(id, "bash", result);
			}

			case "user_bash": {
				const intercepted = await session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: command.command,
					excludeFromContext: command.excludeFromContext === true,
					cwd: session.sessionManager.getCwd(),
				});
				if (intercepted?.result) {
					session.recordBashResult(command.command, intercepted.result, { excludeFromContext: command.excludeFromContext });
					return createRpcSuccessResponse(id, "user_bash", intercepted.result);
				}
				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					operations: intercepted?.operations,
				});
				return createRpcSuccessResponse(id, "user_bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return createRpcSuccessResponse(id, "abort_bash");
			}

			case "get_session_stats": {
				return createRpcSuccessResponse(id, "get_session_stats", session.getSessionStats());
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return createRpcSuccessResponse(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return createRpcSuccessResponse(id, "switch_session", result);
			}

			case "import_session": {
				const result = await runtimeHost.importFromJsonl(command.inputPath, command.cwdOverride);
				if (!result.cancelled) await rebindSession();
				return createRpcSuccessResponse(id, "import_session", result);
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

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return createRpcSuccessResponse(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return createRpcErrorResponse(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return createRpcSuccessResponse(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "get_tree": {
				const sessionManager = session.sessionManager;
				return createRpcSuccessResponse(id, "get_tree", {
					tree: sessionManager.getTree(),
					leafId: sessionManager.getLeafId(),
				});
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
				session.setSessionName(name);
				return createRpcSuccessResponse(id, "set_session_name");
			}

			case "navigate_tree": {
				const result = await session.navigateTree(command.targetId, command.options);
				return createRpcSuccessResponse(id, "navigate_tree", {
					cancelled: result.cancelled,
					editorText: result.editorText,
				});
			}

			case "set_label": {
				session.sessionManager.appendLabelChange(command.entryId, command.label);
				return createRpcSuccessResponse(id, "set_label");
			}

			case "reload": {
				if (reloadCoordinator) await reloadCoordinator.reload(session);
				else await session.reload();
				return createRpcSuccessResponse(id, "reload");
			}

			case "get_shortcuts": {
				const effectiveBindings = getShortcutBindings();
				const shortcuts = session.extensionRunner.getShortcuts(effectiveBindings);
				return createRpcSuccessResponse(id, "get_shortcuts", {
					shortcuts: [...shortcuts].map(([key, shortcut]) => ({ key, description: shortcut.description })),
				});
			}

			case "invoke_shortcut": {
				const shortcut = session.extensionRunner
					.getShortcuts(getShortcutBindings())
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
					{ kind: "extension.hook", name: `command-completions:${command.commandName}`, sourcePath: registeredCommand.sourceInfo.path },
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

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return createRpcSuccessResponse(id, "get_commands", { commands });
			}

			default: {
				const unknownCommand = command as { type: string };
				return createRpcErrorResponse(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};
}
