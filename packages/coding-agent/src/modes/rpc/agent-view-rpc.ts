import type { AgentSession } from "../../core/agent-session.js";
import type { ExtensionUIContext } from "../../core/extensions/index.js";
import type { EngineCustomUiService } from "../interactive-engine/engine-custom-ui.ts";
import type { InteractiveEngineMessage } from "../interactive-engine/protocol.ts";
import { handleAgentViewCommands } from "./agent-view-rpc-commands.ts";
import { handleSetViewedAgent, installEngineAgentViewBridge } from "./agent-view-rpc-panel.ts";
import {
	handleAgentViewClearQueue,
	handleAgentViewPause,
	handleAgentViewPrompt,
	handleAgentViewResume,
} from "./agent-view-rpc-prompt.ts";
import type { AgentViewRpcCommand } from "./agent-view-rpc-types.ts";
import {
	bindEngineAgentViews,
	handleAgentViewClose,
	handleAgentViewLastMessage,
	handleAgentViewOpen,
} from "./agent-view-rpc-view.ts";
import { createRpcErrorResponse } from "./rpc-responses.ts";
import type { RpcResponse } from "./rpc-types.ts";
import { handleGetTaskPrompts } from "./task-prompts-rpc.ts";

/** What the engine side of a subagent shown on the host's main screen works with. */
export interface EngineAgentViewContext {
	readonly session: AgentSession;
	/** Write an engine → host message. */
	send(message: InteractiveEngineMessage): void;
	readonly customUi: EngineCustomUiService;
	readonly ui: ExtensionUIContext;
}

const contexts = new WeakMap<object, EngineAgentViewContext>();

export function engineAgentViewContext(session: object): EngineAgentViewContext | undefined {
	return contexts.get(session);
}

/**
 * Bind the engine side of the single chat screen to `context.session`: the views the host opens, and the bridge the
 * engine's agent panel and `/tasks` use. Answers the unbind.
 */
export function bindEngineAgentView(context: EngineAgentViewContext): () => void {
	contexts.set(context.session, context);
	const unbindViews = bindEngineAgentViews(context);
	const unbindBridge = installEngineAgentViewBridge(context);
	return () => {
		unbindBridge();
		unbindViews();
		if (contexts.get(context.session) === context) contexts.delete(context.session);
	};
}

/** Answer one of the host's agent-view commands; each kind is answered by its own module. */
export async function handleAgentViewCommand(command: AgentViewRpcCommand, session: object): Promise<RpcResponse> {
	const context = contexts.get(session);
	if (context === undefined)
		return createRpcErrorResponse(command.id, command.type, "Viewing a subagent requires an interactive host");
	switch (command.type) {
		case "agent_view_open":
			return handleAgentViewOpen(command, context);
		case "agent_view_close":
			return handleAgentViewClose(command, context);
		case "agent_view_last_message":
			return handleAgentViewLastMessage(command, context);
		case "agent_view_prompt":
			return handleAgentViewPrompt(command, context);
		case "agent_view_resume":
			return handleAgentViewResume(command, context);
		case "agent_view_clear_queue":
			return handleAgentViewClearQueue(command, context);
		case "agent_view_pause":
			return handleAgentViewPause(command, context);
		case "agent_view_commands":
			return handleAgentViewCommands(command, context);
		case "get_task_prompts":
			return handleGetTaskPrompts(command, context);
		case "set_viewed_agent":
			return handleSetViewedAgent(command, context);
	}
}
