import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	createRpcErrorResponse,
	createRpcSuccessResponse,
	formatRpcErrorMessage,
	parseRpcContextWindow,
	type RpcOutput,
} from "./rpc-responses.ts";
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "./rpc-types.ts";

export type RpcCommandHandler = (command: RpcCommand) => Promise<RpcResponse | undefined>;

interface RpcCommandHandlerOptions {
	runtimeHost: AgentSessionRuntime;
	getSession: () => AgentSession;
	rebindSession: () => Promise<void>;
	output: RpcOutput;
}

export function createRpcCommandHandler({
	runtimeHost,
	getSession,
	rebindSession,
	output,
}: RpcCommandHandlerOptions): RpcCommandHandler {
	return async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;
		const session = getSession();

		switch (command.type) {
			case "prompt": {
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
				return createRpcSuccessResponse(id, "set_model", session.model ?? model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				return createRpcSuccessResponse(id, "cycle_model", result ?? null);
			}

			case "get_available_models": {
				const models = await session.modelRegistry.getAvailable();
				return createRpcSuccessResponse(id, "get_available_models", { models });
			}

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return createRpcSuccessResponse(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				return createRpcSuccessResponse(id, "cycle_thinking_level", level ? { level } : null);
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

			case "context_compact": {
				const result = await session.contextCompact();
				return createRpcSuccessResponse(id, "context_compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return createRpcSuccessResponse(id, "set_auto_compaction");
			}

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return createRpcSuccessResponse(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return createRpcSuccessResponse(id, "abort_retry");
			}

			case "bash": {
				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
				});
				return createRpcSuccessResponse(id, "bash", result);
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

			case "get_messages": {
				return createRpcSuccessResponse(id, "get_messages", { messages: session.messages });
			}

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const registeredCommand of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: registeredCommand.invocationName,
						description: registeredCommand.description,
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
