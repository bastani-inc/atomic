/**
 * The engine side of the subagents an isolated engine's host shows on its main screen. Each view is the same port the
 * in-process host uses (`LocalAgentViewPort`), over the session's owner task view, with its transcript mounted as a
 * remote component the host draws in its transcript area (`placement: "transcript"`). Every status change is sent
 * as `engine_agent_view_status`, once per microtask.
 */
import type { TUI } from "@bastani/atomic-tui";
import { dismissedAgentPanelItems, subscribeAgentPanel } from "../../core/tasks/agent-panel-source.ts";
import type { TaskId } from "../../core/tasks/contracts.js";
import { getOwnerTaskStore } from "../../core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../core/tasks/task-view-source.js";
import type { AgentViewPort, AgentViewStatus } from "../interactive/agent-view/contracts.ts";
import { openLocalAgentViewPort } from "../interactive/agent-view/local-port.ts";
import { ChatSessionHost } from "../interactive/components/chat-session-host.ts";
import { type TaskTranscriptEnvironment, themedChatHostStyle } from "../interactive/components/task-transcript-page.ts";
import type { SteeringQueueLists } from "../interactive/steering-queue-controller.ts";
import { getEditorTheme } from "../interactive/theme/theme.js";
import type { EngineAgentViewContext } from "./agent-view-rpc.ts";

/** The queued rows the host draws for `status`, per lane: the messages being delivered, then the queue. */
function queuedRowTexts(status: AgentViewStatus): SteeringQueueLists {
	return {
		steering: [...(status.delivering?.steering ?? []), ...status.queued.steering],
		followUp: [...(status.delivering?.followUp ?? []), ...status.queued.followUp],
	};
}

/** Whether `after` lists some row of `before` fewer times, in either lane. */
function removesRow(before: SteeringQueueLists, after: SteeringQueueLists): boolean {
	return removesFromLane(before.steering, after.steering) || removesFromLane(before.followUp, after.followUp);
}

function removesFromLane(before: readonly string[], after: readonly string[]): boolean {
	const left = new Map<string, number>();
	for (const text of after) left.set(text, (left.get(text) ?? 0) + 1);
	for (const text of before) {
		const count = left.get(text) ?? 0;
		if (count === 0) return true;
		left.set(text, count - 1);
	}
	return false;
}

/** The views the host opened on this engine, by view id. */
export interface EngineAgentViews {
	port(viewId: string): AgentViewPort | undefined;
}

interface EngineView {
	readonly port: AgentViewPort;
	readonly componentId: string;
	close(): void;
}

class EngineAgentViewRegistry implements EngineAgentViews {
	private readonly views = new Map<string, EngineView>();
	private nextView = 0;
	private readonly context: EngineAgentViewContext;

	constructor(context: EngineAgentViewContext) {
		this.context = context;
	}

	port(viewId: string): AgentViewPort | undefined {
		return this.views.get(viewId)?.port;
	}

	/** Where the view's transcript is drawn: the engine's chat settings, with the host chat's own display toggles. */
	private environment(tui: () => TUI | undefined): TaskTranscriptEnvironment {
		const { ui, customUi } = this.context;
		const settings = () => {
			const host = customUi.getHostRenderSettings();
			return {
				...ui.getChatRenderSettings(),
				...(host === undefined
					? {}
					: {
							hideThinkingBlock: host.hideThinkingBlock,
							toolOutputExpanded: host.toolOutputExpanded,
							fullscreenScrollbar: host.fullscreenScrollbar,
							fullscreenWheelScrollLines: host.fullscreenWheelScrollLines,
						}),
			};
		};
		return {
			createChat: (opts) => new ChatSessionHost(opts),
			get tui() {
				return tui();
			},
			editorTheme: getEditorTheme(),
			style: themedChatHostStyle(),
			getChatRenderSettings: settings,
			getToolsExpanded: () => settings().toolOutputExpanded === true,
			footerData: ui.getFooterDataProvider(),
			notify: (message) => ui.notify(message, "warning"),
		};
	}

	/** Open a view of the subagent `taskId` is an attempt of, once its first page is read. */
	async open(taskId: TaskId): Promise<{ readonly viewId: string; readonly view: EngineView } | undefined> {
		const { session, customUi, send } = this.context;
		const store = getOwnerTaskStore(session);
		if (store === undefined) return undefined;
		let tui: TUI | undefined;
		const port = await openLocalAgentViewPort({
			source: ownerTaskViewSource(store),
			taskId,
			env: this.environment(() => tui),
			requestRender: () => tui?.requestRender(),
			rows: () => tui?.terminal.rows ?? 24,
			isDismissed: (id) => dismissedAgentPanelItems(session).has(`task:${id}`),
			watch: (listener) => subscribeAgentPanel(session, listener),
		});
		if (port === undefined) return undefined;
		const release = port.retain();
		const viewId = `agent_view_${++this.nextView}`;
		const mount = customUi.mountTranscript(viewId, (engineTui) => {
			tui = engineTui;
			return port.transcript;
		});
		let scheduled = false;
		let sentRows = queuedRowTexts(port.status());
		const unsubscribe = port.subscribe(() => {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(() => {
				scheduled = false;
				if (this.views.get(viewId)?.port !== port) return;
				const status = port.status();
				const rows = queuedRowTexts(status);
				// A queued row the host takes away goes with the transcript that may now show its message: that frame,
				// if one is due, is sent first, so no frame the host paints shows the message in neither place.
				if (removesRow(sentRows, rows)) mount.paintPendingFrame();
				sentRows = rows;
				send({ type: "engine_agent_view_status", viewId, status });
			});
		});
		const view: EngineView = {
			port,
			componentId: mount.componentId,
			close: () => {
				unsubscribe();
				mount.close();
				release();
			},
		};
		this.views.set(viewId, view);
		return { viewId, view };
	}

	close(viewId: string): boolean {
		const view = this.views.get(viewId);
		if (view === undefined) return false;
		this.views.delete(viewId);
		view.close();
		return true;
	}

	dispose(): void {
		for (const viewId of [...this.views.keys()]) this.close(viewId);
	}
}

const registries = new WeakMap<object, EngineAgentViewRegistry>();
const NO_VIEWS: EngineAgentViews = { port: () => undefined };

/** The views of `session`'s host, while the session is bound. */
export function engineAgentViews(session: object): EngineAgentViews {
	return registries.get(session) ?? NO_VIEWS;
}

/** @internal The registry of the bound session, for the view commands. */
export function engineAgentViewRegistry(session: object): EngineAgentViewRegistry | undefined {
	return registries.get(session);
}

/** Keep the views of `context.session`'s host; the unbind closes every one. */
export function bindEngineAgentViews(context: EngineAgentViewContext): () => void {
	registries.get(context.session)?.dispose();
	const registry = new EngineAgentViewRegistry(context);
	registries.set(context.session, registry);
	return () => {
		registry.dispose();
		if (registries.get(context.session) === registry) registries.delete(context.session);
	};
}
