import type { PromptDisposition } from "../../core/agent-session-types.js";
import type { AgentViewPort } from "../interactive/agent-view/contracts.ts";
import type { EngineAgentViewContext } from "./agent-view-rpc.ts";
import type { AgentViewRpcCommand } from "./agent-view-rpc-types.ts";
import { engineAgentViews } from "./agent-view-rpc-view.ts";
import { createRpcErrorResponse, createRpcSuccessResponse, formatRpcErrorMessage } from "./rpc-responses.ts";
import type { RpcResponse } from "./rpc-types.ts";

type Command<T extends AgentViewRpcCommand["type"]> = Extract<AgentViewRpcCommand, { type: T }>;

/** The host's prompt writes to a subagent the engine shows it: each command runs on that view's port, here. */
const VIEW_CLOSED = "The subagent is no longer shown";

function viewPort(context: EngineAgentViewContext, viewId: string): AgentViewPort | undefined {
	return engineAgentViews(context.session).port(viewId);
}

async function onPort(
	command: Command<"agent_view_prompt" | "agent_view_resume" | "agent_view_clear_queue" | "agent_view_pause">,
	context: EngineAgentViewContext,
	run: (port: AgentViewPort) => Promise<object | undefined>,
): Promise<RpcResponse> {
	const port = viewPort(context, command.viewId);
	if (port === undefined) return createRpcErrorResponse(command.id, command.type, VIEW_CLOSED);
	try {
		return createRpcSuccessResponse(command.id, command.type, await run(port));
	} catch (error) {
		return createRpcErrorResponse(command.id, command.type, formatRpcErrorMessage(error), error);
	}
}

/** Send the host's message to the viewed subagent: queued in its lane while it works, else its next turn. */
export function handleAgentViewPrompt(
	command: Command<"agent_view_prompt">,
	context: EngineAgentViewContext,
): Promise<RpcResponse> {
	return onPort(command, context, async (port) => {
		let disposition: PromptDisposition | undefined;
		await port.steering.prompt(command.message, {
			...(command.streamingBehavior === undefined ? {} : { streamingBehavior: command.streamingBehavior }),
			preflightResult: (success, answered) => {
				if (success) disposition = answered;
			},
		});
		return disposition === undefined ? {} : { disposition };
	});
}

/** Continue the paused or finished viewed subagent with the host's message. */
export function handleAgentViewResume(
	command: Command<"agent_view_resume">,
	context: EngineAgentViewContext,
): Promise<RpcResponse> {
	return onPort(command, context, async (port) => {
		const resume = port.steering.resume;
		if (resume !== undefined) await resume.call(port.steering, command.message, command.lane);
		else
			await port.steering.prompt(command.message, {
				...(command.lane === "auto" ? {} : { streamingBehavior: command.lane }),
			});
		return undefined;
	});
}

/** Take every message back from the viewed subagent's queue, in its own answer. */
export function handleAgentViewClearQueue(
	command: Command<"agent_view_clear_queue">,
	context: EngineAgentViewContext,
): Promise<RpcResponse> {
	return onPort(command, context, async (port) => port.steering.clearQueue());
}

/** Esc on the host: pause the viewed subagent; the answer carries what came back from its queue. */
export function handleAgentViewPause(
	command: Command<"agent_view_pause">,
	context: EngineAgentViewContext,
): Promise<RpcResponse> {
	return onPort(command, context, async (port) => port.pause());
}
