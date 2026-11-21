import { dismissedAgentPanelItems, subscribeAgentPanel } from "../../../core/tasks/agent-panel-source.ts";
import type { TaskId } from "../../../core/tasks/contracts.js";
import { getOwnerTaskStore } from "../../../core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../../core/tasks/task-view-source.js";
import { IsolatedInteractiveRuntime } from "../../interactive-engine/isolated-runtime.js";
import { ChatSessionHost } from "../components/chat-session-host.ts";
import { type TaskTranscriptEnvironment, themedChatHostStyle } from "../components/task-transcript-page.ts";
import type { InteractiveModeBase } from "../interactive-mode-base.ts";
import { getEditorTheme } from "../theme/theme.js";
import type { AgentViewRequestOptions } from "./agent-view-bridge.ts";
import type { AgentViewPort } from "./contracts.ts";
import { openLocalAgentViewPort } from "./local-port.ts";
import { openRemoteAgentViewPort } from "./remote-port.ts";
import { transcriptSlotRows } from "./transcript-slot.ts";

/** Where a subagent's transcript is drawn in this process: the main chat's own render settings and repaint. */
export function mainTranscriptEnvironment(mode: InteractiveModeBase): TaskTranscriptEnvironment {
	const ui = mode.createExtensionUIContext();
	return {
		createChat: (opts) => new ChatSessionHost(opts),
		tui: mode.ui,
		keybindings: mode.keybindings,
		editorTheme: getEditorTheme(),
		style: themedChatHostStyle(),
		getChatRenderSettings: () => ui.getChatRenderSettings(),
		getToolsExpanded: () => mode.toolOutputExpanded,
		setToolsExpanded: (expanded) => ui.setToolsExpanded(expanded),
		footerData: mode.footerDataProvider,
		notify: (message) => mode.showWarning(message),
	};
}

/**
 * Open the port of the subagent `taskId` is an attempt of: over the owner's task view in this process, or through the
 * isolated engine. Undefined when there is no such subagent. In this process the panel draws as it opens; the engine's
 * is awaited when the request says it opens again (`options.panel`).
 */
export async function openAgentViewPort(
	mode: InteractiveModeBase,
	taskId: TaskId,
	options?: AgentViewRequestOptions,
): Promise<AgentViewPort | undefined> {
	const runtime = mode.runtimeHost;
	if (runtime instanceof IsolatedInteractiveRuntime) {
		const terminal = mode.ui.terminal;
		return openRemoteAgentViewPort(
			runtime,
			taskId,
			{
				width: Math.max(1, terminal.columns),
				rows: transcriptSlotRows(mode),
				...(terminal.colorDepth === undefined ? {} : { colorDepth: terminal.colorDepth }),
			},
			{ panel: options?.keepScreen === true && options.panel === true },
		);
	}
	const session = mode.session;
	const store = getOwnerTaskStore(session);
	if (store === undefined) return undefined;
	return openLocalAgentViewPort({
		source: ownerTaskViewSource(store),
		taskId,
		env: mainTranscriptEnvironment(mode),
		requestRender: () => mode.ui.requestRender(),
		rows: () => transcriptSlotRows(mode),
		isDismissed: (id) => dismissedAgentPanelItems(session).has(`task:${id}`),
		watch: (listener) => subscribeAgentPanel(session, listener),
	});
}
