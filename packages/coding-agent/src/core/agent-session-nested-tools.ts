import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolResultMessage } from "@bastani/pi-ai/compat";
import { type AgentTool, runToolCall } from "@earendil-works/pi-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { ExecuteToolOptions } from "./extensions/context-types.ts";
import { NestedToolCallRunner } from "./nested-tool-calls.js";
import { combineUsage } from "./usage-totals.ts";

const runners = new WeakMap<AgentSession, NestedToolCallRunner>();
const parentCall = new AsyncLocalStorage<string>();
export function getParentToolCallId(): string | undefined {
	return parentCall.getStore();
}

export function getCallableTools(session: AgentSession, active = new Set(session.getActiveToolNames())): AgentTool[] {
	return [...session._toolRegistry.values()].filter((tool) => {
		const exposure = session.getToolDefinition(tool.name)?.exposure ?? "direct";
		return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name));
	});
}

export function executeNestedToolCall(
	session: AgentSession,
	callerId: string,
	name: string,
	args: unknown,
	options: ExecuteToolOptions,
) {
	let runner = runners.get(session);
	if (!runner) {
		runner = new NestedToolCallRunner({
			runToolCall: (toolCall, parentId, signal, onUpdate) => {
				const messages = session.agent.state.messages;
				let assistantMessage: (typeof messages)[number] | undefined;
				for (let i = messages.length - 1; i >= 0; i--) {
					if (messages[i].role === "assistant") {
						assistantMessage = messages[i];
						break;
					}
				}
				if (assistantMessage?.role !== "assistant")
					return Promise.resolve({
						toolCall,
						result: {
							content: [{ type: "text" as const, text: "No assistant message issued this call" }],
							details: {},
						},
						isError: true,
					});
				return runToolCall(toolCall, {
					tools: getCallableTools(session).map(
						(tool): AgentTool =>
							session.agent.toolExecution === "sequential" || tool.executionMode === "sequential"
								? {
										...tool,
										execute: (...args) =>
											session._toolExecutionScheduler.schedule("exclusive", () => {
												if (args[2]?.aborted) throw new Error("Operation aborted");
												return tool.execute(...args);
											}),
									}
								: tool,
					),
					assistantMessage,
					context: { messages: session.agent.state.messages, tools: session.agent.state.tools },
					beforeToolCall: (context) =>
						parentCall.run(parentId, async () => session.agent.beforeToolCall?.(context)),
					afterToolCall: (context) => parentCall.run(parentId, async () => session.agent.afterToolCall?.(context)),
					signal,
					onUpdate,
				});
			},
			emit: async (event) => {
				await session.extensionRunner.emit(event);
				session._emit(event);
			},
		});
		runners.set(session, runner);
	}
	return runner.execute(callerId, name, args, options);
}

export function recordNestedToolCalls(session: AgentSession, message: ToolResultMessage): void {
	const summary = runners.get(session)?.takeRecord(message.toolCallId);
	if (summary?.calls) message.nestedCalls = summary.calls;
	if (summary?.usage) message.usage = message.usage ? combineUsage(message.usage, summary.usage) : summary.usage;
}
export function clearNestedToolCalls(session: AgentSession): void {
	runners.get(session)?.clear();
}
