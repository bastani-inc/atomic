import { type AgentTool, runToolCall } from "@bastani/atomic-agent-core";
import { type ToolCall, validateToolArguments } from "@bastani/atomic-ai";
import type { ToolResultMessage } from "@bastani/atomic-ai/compat";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { ExecuteToolOptions } from "./extensions/context-types.ts";
import { NestedToolCallRunner } from "./nested-tool-calls.js";
import { combineUsage } from "./usage-totals.ts";

const runners = new WeakMap<AgentSession, NestedToolCallRunner>();

export function getCallableTools(session: AgentSession, active = new Set(session.getActiveToolNames())): AgentTool[] {
	const routingOnly = session._subagentPolicy?.codemodeRoutingOnly === true;
	return [...session._toolRegistry.values()].flatMap((tool): AgentTool[] => {
		const definition = session.getToolDefinition(tool.name);
		const exposure = definition?.exposure ?? "direct";
		if (exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name)))
			return routingOnly && !active.has(tool.name) ? [] : [tool];
		const access = definition?.scriptAccess;
		if (exposure !== "model-only" || !access || !active.has(tool.name)) return [];
		// Scripts reach a model-only tool only through its script access: its description, output and refusals.
		// A refused call fails after validation and before permission hooks, so nobody is asked to approve it.
		const scriptTool: AgentTool = {
			...tool,
			description: access.description,
			outputSchema: access.outputSchema,
			prepareArguments: (args) => {
				const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
				const refusal = access.refuse(
					validateToolArguments(scriptTool, {
						type: "toolCall",
						id: "",
						name: tool.name,
						arguments: prepared as ToolCall["arguments"],
					}),
				);
				if (refusal !== undefined) throw new Error(refusal);
				return prepared;
			},
		};
		return [scriptTool];
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
				return session.extensionRunner.runNestedTool(toolCall.id, parentId, () =>
					runToolCall(toolCall, {
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
						// The nested call's signal reaches the hooks, so interrupting it also stops its wait for a blueprint build.
						beforeToolCall: session.agent.beforeToolCall,
						afterToolCall: session.agent.afterToolCall,
						signal,
						onUpdate,
					}),
				);
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
