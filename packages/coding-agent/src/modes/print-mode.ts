/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { AssistantMessage, ImageContent, ToolResultMessage } from "@bastani/atomic-ai/compat";
import { sessionConflictMessage } from "../cli/settings-startup.ts";
import type { AgentSession, AgentSessionEvent } from "../core/agent-session.js";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { CommandDeliveries, collectCommandDeliveries } from "../core/command-deliveries.ts";
import type { ExtensionError } from "../core/extensions/index.js";
import type { ToolDefinition } from "../core/extensions/types.ts";
import { enablePrintModelSelection, hasPrintModelSelection } from "../core/first-prompt-model.ts";
import type { CustomMessage } from "../core/messages.ts";
import { formatModelLabel } from "../core/model-label.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import {
	type BlueprintBuildFinished,
	type BlueprintBuildWaiting,
	blueprintBuildsSettled,
	onBlueprintBuildFinished,
	onBlueprintBuildWaiting,
} from "../core/resume/blueprint/barrier.ts";
import { serviceTierWarnings } from "../core/service-tier-warnings.ts";
import { ranOnModelLine } from "../core/tasks/completion.js";
import { reportDiagnostics } from "../main-stdio.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";

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

/** One stderr line: provider errors can carry line breaks and control characters. */
function singleLine(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim();
}

function isCommandExtensionError(error: ExtensionError): boolean {
	return error.event === "command" || error.extensionPath.startsWith("command:");
}

/** A message the run could not save to its session (#4226): the run fails, but its answer still prints. */
function isSessionSaveError(error: ExtensionError): boolean {
	return error.extensionPath === "<session>" && error.event === "message_end";
}

/**
 * The messages that end the run. A compaction that ran after the last turn leaves only its boundary message in
 * context; the turn's answer or failure is then read from the session's branch, where it is kept.
 */
function messagesBeforeTrailingBoundary(session: AgentSession): readonly AgentMessage[] {
	const messages = session.state.messages;
	const last = messages[messages.length - 1];
	if (last?.role !== "custom" || last.customType !== "compaction") return messages;
	return session.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "message" && entry.message.role !== "system" ? [entry.message] : []));
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

/** Writes a blueprint build event (#4748) as one JSON line on stdout, for `--mode json` and an RPC process's startup. */
export function writeBlueprintBuildEvent(event: BlueprintBuildFinished | BlueprintBuildWaiting): void {
	writeRawStdout(`${JSON.stringify(event)}\n`);
}

/**
 * Tells a run without a UI that a resume waits for another blueprint build of its worktree, as soon as it starts
 * waiting (#4748): JSON modes get the event on stdout, text mode a line on stderr. Returns the unsubscribe.
 */
export function announceBlueprintBuildWaits(json: boolean): () => void {
	return onBlueprintBuildWaiting((waiting) => {
		if (json) writeBlueprintBuildEvent(waiting);
		else reportDiagnostics([{ type: "info", message: waiting.message }]);
	});
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	/** Whether a model fallback ran during this invocation; only then can its answer come from another model (#4223). */
	let fellBack = false;
	/** The model the latest fallback continued on and its level, shown beside it in the ran-on line (#4269). */
	let fallbackTarget: { model: string; thinkingLevel?: string } | undefined;
	let suppressFinalOutput = false;
	let activePromptHadCommandError = false;
	/** Whether the last prompt's extension commands answered with messages they queued (#6113). */
	let commandAnswered = false;
	/** Whether a model reply ended during this run: the session's last reply is then possibly this run's own. */
	let repliedThisRun = false;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	const terminatingStructuredOutputCallIds = new Set<string>();
	let disposing: Promise<void> | undefined;
	// SIGTERM/SIGHUP received so far. Only a repeated signal forces exit during disposal.
	let signalCount = 0;
	const signalCleanupHandlers: Array<() => void> = [];

	// Callers share one disposal, so a signal during the final disposal waits for it to finish.
	const disposeRuntime = (): Promise<void> => {
		disposing ??= (async () => {
			unsubscribe?.();
			await runtimeHost.dispose();
		})();
		return disposing;
	};

	const registerSignalHandlers = (): void => {
		// SIGINT (Ctrl-C) ends the run the same way (#4748): a blueprint build still running behind the first turn is
		// stopped with its process tree instead of being left in its own process group.
		const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const exitCode = signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143;
			const handler = () => {
				signalCount++;
				killTrackedDetachedChildren();
				if (signalCount > 1) process.exit(exitCode);
				void disposeRuntime().finally(() => {
					process.exit(exitCode);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();
	// A resumed session's blueprint build may run behind its first turn (#4748): its warnings reach the user once it
	// ends, as a resume that waits shows them, and a JSON run emits the build's end as an event.
	// A resume that waits for another build of its worktree says so at once, not only in the warning after the wait.
	const stopAnnouncingFinished = onBlueprintBuildFinished((finished) => {
		if (mode === "json") writeBlueprintBuildEvent(finished);
		else reportDiagnostics(finished.notices);
	});
	const stopAnnouncingWaits = announceBlueprintBuildWaits(mode === "json");
	const stopAnnouncing = () => {
		stopAnnouncingFinished();
		stopAnnouncingWaits();
	};

	const promptWithScopedCommandSuppression = async (
		text: string,
		promptOptions?: { images?: ImageContent[] },
	): Promise<void> => {
		activePromptHadCommandError = false;
		try {
			const deliveries = new CommandDeliveries();
			const promptSession = session;
			await collectCommandDeliveries(deliveries, promptSession, () =>
				promptOptions === undefined ? promptSession.prompt(text) : promptSession.prompt(text, promptOptions),
			).catch((error: unknown) => {
				deliveries.close();
				throw error;
			});
			// #6113: an extension command can answer with a message it queues (`pi.sendMessage`) and return before it is
			// delivered. Its answer, and the reply of a turn that message starts, come before the result and before the
			// next prompt; the session is closed only after them.
			const queued = await deliveries.settle();
			for (const error of queued.unreported) console.error(error instanceof Error ? error.message : String(error));
			commandAnswered = queued.answered;
			if (queued.lost) {
				// The command's answer was lost: an earlier reply must not stand in for it, so text output prints nothing
				// and fails. Its sender reported why. The JSON event stream never printed a reply in its place and keeps
				// its exit status.
				if (mode === "text") exitCode = 1;
				activePromptHadCommandError = true;
			}
			const conflict = session.getPersistenceFailure()?.conflict;
			if (conflict !== undefined) {
				exitCode = 1;
				console.error(sessionConflictMessage(conflict));
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
					return runtimeHost.switchSession(sessionPath, { ...switchOptions, history: "tail" });
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				const isCommandError = isCommandExtensionError(err);
				if (isCommandError || isSessionSaveError(err)) exitCode = 1;
				activePromptHadCommandError = activePromptHadCommandError || isCommandError;
				if (isSessionSaveError(err) && session.getPersistenceFailure()?.conflict !== undefined) return;
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});
		enablePrintModelSelection(session);

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			if (isTerminatingStructuredOutputEvent(event, (name) => session.getToolDefinition(name))) {
				terminatingStructuredOutputCallIds.add(event.toolCallId);
			}
			if (event.type === "message_end" && event.message.role === "assistant") repliedThisRun = true;
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				for (const warning of serviceTierWarnings(event.message)) console.error(`Warning: ${warning}`);
			} else if (event.type === "model_fallback_start") {
				fellBack = true;
				fallbackTarget = { model: event.to, thinkingLevel: event.toThinkingLevel };
				// A fallback is never silent: the answer that follows comes from another model (#4223). Each model reads
				// as its raw ID and level (#4269).
				const from = formatModelLabel(event.from, { thinkingLevel: event.fromThinkingLevel });
				const to = formatModelLabel(event.to, { thinkingLevel: event.toThinkingLevel });
				console.error(`Model fallback: ${from} failed, continuing on ${to}: ${singleLine(event.reason)}`);
			}
		});
	};

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	try {
		if (
			runtimeHost.modelFallbackReason === "configured-provider-unsupported" &&
			(!(initialMessage || messages.length) || !hasPrintModelSelection(session))
		) {
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
		// The model this run was asked to use, reported beside the one it ran on after a fallback (#4223), and where this
		// run's messages start, so an answer from an earlier run in a continued session is never judged.
		const requestedLevel = session.model?.reasoning ? session.thinkingLevel : undefined;
		const requestedModel = session.model
			? `${session.model.provider}/${session.model.id}${requestedLevel ? `:${requestedLevel}` : ""}`
			: undefined;
		const runSession = session;
		const runStart = session.state.messages.length;

		if (initialMessage) {
			await promptWithScopedCommandSuppression(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await promptWithScopedCommandSuppression(message);
		}

		const state = session.state;
		const finalMessages = messagesBeforeTrailingBoundary(session);
		const lastMessage = finalMessages[finalMessages.length - 1];
		const lastAssistantMessage = [...finalMessages].reverse().find((message) => message.role === "assistant") as
			| AssistantMessage
			| undefined;
		const runAnswer =
			fellBack && session === runSession
				? ([...state.messages.slice(runStart)].reverse().find((message) => message.role === "assistant") as
						| AssistantMessage
						| undefined)
				: undefined;
		const answerModel = runAnswer === undefined ? undefined : `${runAnswer.provider}/${runAnswer.model}`;
		const ranOn =
			answerModel === undefined
				? undefined
				: ranOnModelLine({
						kind: "agent",
						model: answerModel,
						thinking: fallbackTarget?.model === answerModel ? fallbackTarget.thinkingLevel : undefined,
						requestedModel,
					});
		if (ranOn && mode === "text" && !suppressFinalOutput) console.error(ranOn);
		// A command that answered with a message, in a run where no model replied, is not cut by an earlier run's reply
		// that reached the output limit.
		const answeredByCommand = commandAnswered && !repliedThisRun && lastMessage?.role !== "assistant";
		if (
			!answeredByCommand &&
			lastAssistantMessage?.stopReason === "length" &&
			mode === "text" &&
			!suppressFinalOutput
		) {
			console.error("Response was truncated: the model reached its output token limit.");
			exitCode = 1;
		}

		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				if (mode === "text" && !suppressFinalOutput) {
					console.error(
						assistantMsg.stopReason === "error"
							? `Model ${assistantMsg.provider}/${assistantMsg.model} failed: ${assistantMsg.errorMessage || "Request error"}`
							: assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`,
					);
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
				const text = terminatingStructuredOutputText(
					lastMessage as ToolResultMessage,
					terminatingStructuredOutputCallIds,
				);
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
		// A blueprint build may still run behind the first turn (#4748), also for a session opened since in its worktree:
		// the run ends once every build it started has settled, so it never leaves a restored worktree half built.
		await blueprintBuildsSettled();
		stopAnnouncing();
		// Keep the signal handlers until disposal is done: without one, a signal would kill the
		// process mid-dispose.
		await disposeRuntime();
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await flushRawStdout();
	}
}
