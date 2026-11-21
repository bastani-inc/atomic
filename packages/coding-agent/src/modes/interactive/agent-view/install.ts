import type { TaskId } from "../../../core/tasks/contracts.js";
import { IsolatedInteractiveRuntime } from "../../interactive-engine/isolated-runtime.js";
import type { InteractiveModeBase } from "../interactive-mode-base.ts";
import { setAgentViewBridge } from "./agent-view-bridge.ts";
import { AgentViewSwitcher, type OpenAgentViewPort } from "./agent-view-switcher.ts";
import { openAgentViewPort } from "./open-port.ts";
import { installPromptRetarget } from "./prompt-retarget.ts";
import { FIRST_FRAME_TIMEOUT_MS } from "./remote-port.ts";
import { holdTranscriptDock, installTranscriptSlot } from "./transcript-slot.ts";
import { installViewedCommandGates } from "./viewed-commands.ts";

const switchers = new WeakMap<InteractiveModeBase, AgentViewSwitcher>();

/**
 * The mode's switcher, made on first use: a session can be bound before the screen is set up. `openPort` opens the
 * subagents it shows; the first call decides it.
 */
export function agentViewSwitcher(
	mode: InteractiveModeBase,
	openPort: OpenAgentViewPort = (taskId, options) => openAgentViewPort(mode, taskId, options),
): AgentViewSwitcher {
	let switcher = switchers.get(mode);
	if (switcher === undefined) {
		switcher = new AgentViewSwitcher(
			openPort,
			(message) => mode.showWarning(message),
			() => holdTranscriptDock(mode, FIRST_FRAME_TIMEOUT_MS),
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
/**
 * Tells the engine what the screen shows, with `tell`: when it changes, and when a request ends without showing what
 * it asked for, since the engine lists the subagent it asked to show while the screen is kept for it.
 */
export function tellEngineViewed(
	switcher: Pick<AgentViewSwitcher, "onChange" | "onPending" | "viewedTaskId">,
	tell: (taskId: TaskId | undefined) => void,
): () => void {
	const stopChange = switcher.onChange(({ to }) => tell(to.kind === "agent" ? to.port.status().taskId : undefined));
	const stopPending = switcher.onPending((pending, settled) => {
		if (pending === undefined && settled !== undefined && settled.outcome !== "shown") tell(switcher.viewedTaskId());
	});
	return () => {
		stopChange();
		stopPending();
	};
}

export function installAgentView(mode: InteractiveModeBase): AgentViewSwitcher {
	const switcher = agentViewSwitcher(mode);
	const undo: (() => void)[] = [
		installTranscriptSlot(mode, switcher),
		installPromptRetarget(mode, switcher),
		installViewedCommandGates(mode, switcher),
	];
	const runtime = mode.runtimeHost;
	if (runtime instanceof IsolatedInteractiveRuntime) {
		undo.push(
			runtime.onEngineMessage((message) => {
				if (message.type !== "engine_view_agent") return;
				switcher.requestView(message.taskId === null ? undefined : (message.taskId as TaskId), {
					keepScreen: message.keepScreen === true,
					panel: message.panel === true,
				});
			}),
			runtime.onGenerationEnded(() => switcher.reset("generation-lost")),
			tellEngineViewed(switcher, (taskId) => {
				void runtime
					.requestAgentView({ type: "set_viewed_agent", ...(taskId === undefined ? {} : { taskId }) })
					.catch(() => {
						// A lost engine forgets what was shown; its replacement starts on main.
					});
			}),
		);
	}
	mode.disposeAgentView = () => {
		mode.disposeAgentView = undefined;
		// Main is shown again first, while every part still follows the switcher, then each part is taken down.
		switcher.dispose();
		for (const release of undo.reverse()) {
			try {
				release();
			} catch {
				// One part's failure must not keep the others installed.
			}
		}
	};
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
