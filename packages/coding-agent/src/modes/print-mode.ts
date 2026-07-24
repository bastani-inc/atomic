/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent } from "../core/agent-session.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { ExtensionError } from "../core/extensions/index.ts";
import type { ToolDefinition } from "../core/extensions/types.ts";
import type { CustomMessage } from "../core/messages.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

function isCommandExtensionError(error: ExtensionError): boolean {
	return error.event === "command" || error.extensionPath.startsWith("command:");
}

function displayableCustomText(message: CustomMessage): string | undefined {
	if (message.display !== true) return undefined;
	if (typeof message.content === "string") return message.content;

	let text = "";
	let hasTextPart = false;
	for (const part of message.content) {
		if (part.type === "text") {
			hasTextPart = true;
			text += part.text;
		}
	}

	return hasTextPart ? text : undefined;
}

type MaybeTerminatingToolResult = {
	terminate?: boolean;
};

type ToolExecutionEndSessionEvent = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

type GetToolDefinition = (name: string) => ToolDefinition | undefined;

function isStructuredOutputTool(getToolDefinition: GetToolDefinition, name: string): boolean {
	return getToolDefinition(name)?.structuredOutput === true;
}

function isTerminatingStructuredOutputEvent(
	event: AgentSessionEvent,
	getToolDefinition: GetToolDefinition,
): event is ToolExecutionEndSessionEvent {
	if (event.type !== "tool_execution_end") return false;
	if (!isStructuredOutputTool(getToolDefinition, event.toolName)) return false;
	if (event.isError) return false;
	const result = event.result as MaybeTerminatingToolResult | undefined;
	return result?.terminate === true;
}

function textFromToolResult(message: ToolResultMessage): string | undefined {
	let text = "";
	let hasTextPart = false;
	for (const part of message.content) {
		if (part.type === "text") {
			hasTextPart = true;
			text += part.text;
		}
	}
	return hasTextPart ? text : undefined;
}

function terminatingStructuredOutputText(
	message: ToolResultMessage,
	terminatingStructuredOutputCallIds: ReadonlySet<string>,
): string | undefined {
	if (!terminatingStructuredOutputCallIds.has(message.toolCallId)) return undefined;
	return textFromToolResult(message);
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let suppressFinalOutput = false;
	let activePromptHadCommandError = false;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	const terminatingStructuredOutputCallIds = new Set<string>();
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	const promptWithScopedCommandSuppression = async (
		text: string,
		promptOptions?: { images?: ImageContent[] },
	): Promise<void> => {
		activePromptHadCommandError = false;
		try {
			if (promptOptions === undefined) {
				await session.prompt(text);
			} else {
				await session.prompt(text, promptOptions);
			}
		} finally {
			// Final-output suppression is scoped to the most recent prompt so a
			// later successful prompt in the same invocation can still print its
			// result. The non-zero exit code remains sticky across prompts.
			suppressFinalOutput = activePromptHadCommandError;
		}
	};

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				const isCommandError = isCommandExtensionError(err);
				if (isCommandError) exitCode = 1;
				activePromptHadCommandError = activePromptHadCommandError || isCommandError;
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			if (isTerminatingStructuredOutputEvent(event, (name) => session.getToolDefinition(name))) {
				terminatingStructuredOutputCallIds.add(event.toolCallId);
			}
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(event)}\n`);
			}
		});
	};

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	try {
		if (runtimeHost.modelFallbackReason === "configured-provider-unsupported") {
			if (runtimeHost.modelFallbackMessage) console.error(runtimeHost.modelFallbackMessage);
			return 1;
		}
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage) {
			await promptWithScopedCommandSuppression(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await promptWithScopedCommandSuppression(message);
		}

		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];

		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				if (mode === "text" && !suppressFinalOutput) {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
				}
				exitCode = 1;
			} else if (mode === "text" && !suppressFinalOutput) {
				for (const content of assistantMsg.content) {
					if (content.type === "text") {
						writeRawStdout(`${content.text}\n`);
					}
				}
			}
		} else if (mode === "text" && !suppressFinalOutput) {
			if (lastMessage?.role === "custom") {
				const text = displayableCustomText(lastMessage as CustomMessage);
				if (text !== undefined) {
					writeRawStdout(`${text}\n`);
				}
			} else if (lastMessage?.role === "toolResult") {
				const text = terminatingStructuredOutputText(lastMessage as ToolResultMessage, terminatingStructuredOutputCallIds);
				if (text !== undefined) {
					writeRawStdout(`${text}\n`);
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
