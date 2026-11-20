import type { TaskId } from "../../../core/tasks/contracts.js";
import { IsolatedInteractiveRuntime } from "../../interactive-engine/isolated-runtime.js";
import type { InteractiveModeBase } from "../interactive-mode-base.ts";
import { setAgentViewBridge } from "./agent-view-bridge.ts";
import { AgentViewSwitcher } from "./agent-view-switcher.ts";
import { openAgentViewPort } from "./open-port.ts";
import { installPromptRetarget } from "./prompt-retarget.ts";
import { installTranscriptSlot } from "./transcript-slot.ts";
import { installViewedCommandGates } from "./viewed-commands.ts";

const switchers = new WeakMap<InteractiveModeBase, AgentViewSwitcher>();

/** The mode's switcher, made on first use: a session can be bound before the screen is set up. */
export function agentViewSwitcher(mode: InteractiveModeBase): AgentViewSwitcher {
	let switcher = switchers.get(mode);
	if (switcher === undefined) {
		switcher = new AgentViewSwitcher(
			(taskId) => openAgentViewPort(mode, taskId),
			(message) => mode.showWarning(message),
		);
		switchers.set(mode, switcher);
		mode.agentView = switcher;
	}
	return switcher;
}

/**
 * Set up the single chat screen once the main screen is: the transcript area, the prompt's retargeting and the
 * hotkey gates follow what the switcher shows, in that order. On the isolated host the engine's panel and `/tasks`
 * reach the switcher through `engine_view_agent`, and learn what it shows through `set_viewed_agent`.
 */
export function installAgentView(mode: InteractiveModeBase): AgentViewSwitcher {
	const switcher = agentViewSwitcher(mode);
	installTranscriptSlot(mode, switcher);
	installPromptRetarget(mode, switcher);
	installViewedCommandGates(mode, switcher);
	const runtime = mode.runtimeHost;
	if (runtime instanceof IsolatedInteractiveRuntime) {
		runtime.onEngineMessage((message) => {
			if (message.type !== "engine_view_agent") return;
			switcher.requestView(message.taskId === null ? undefined : (message.taskId as TaskId));
		});
		runtime.onGenerationEnded(() => switcher.reset("generation-lost"));
		switcher.onChange(({ to }) => {
			const taskId = to.kind === "agent" ? to.port.status().taskId : undefined;
			void runtime
				.requestAgentView({ type: "set_viewed_agent", ...(taskId === undefined ? {} : { taskId }) })
				.catch(() => {
					// A lost engine forgets what was shown; its replacement starts on main.
				});
		});
	}
	return switcher;
}

/**
 * Let the panel and `/tasks` of a session bound in this process change what the screen shows. Answers the unbind,
 * which shows main again: the subagents shown belonged to the session left.
 */
export function bindAgentViewSession(mode: InteractiveModeBase, session: object): () => void {
	if (mode.runtimeHost instanceof IsolatedInteractiveRuntime) return () => {};
	const switcher = agentViewSwitcher(mode);
	setAgentViewBridge(session, switcher);
	return () => {
		setAgentViewBridge(session, undefined);
		switcher.reset("session-replaced");
	};
}
