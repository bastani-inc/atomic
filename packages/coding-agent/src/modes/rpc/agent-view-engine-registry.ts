/**
 * The engine side of the subagents an isolated engine's host shows on its main screen. Each view is the same port the
 * in-process host uses (`LocalAgentViewPort`), over the session's owner task view, with its transcript mounted as a
 * remote component the host draws in its transcript area (`placement: "transcript"`). Every status change is sent
 * as `engine_agent_view_status`, once per microtask.
 */
import type { TUI } from "@bastani/atomic-tui";
import { dismissedAgentPanelItems, subscribeAgentPanel } from "../../core/tasks/agent-panel-source.ts";
import type { TaskId } from "../../core/tasks/contracts.js";
import {
	getOwnerTaskStore,
	isTaskTurnInterrupted,
	type OwnerTaskStore,
	watchOwnerTaskStoreBinding,
} from "../../core/tasks/owner-store.js";
import { type TaskTranscriptSource, watchTaskTranscriptBindings } from "../../core/tasks/supervisor.js";
import { onOwnerTaskAction, ownerTaskViewSource } from "../../core/tasks/task-view-source.js";
import type { AgentViewPort, AgentViewStatus } from "../interactive/agent-view/contracts.ts";
import { openLocalAgentViewPort } from "../interactive/agent-view/local-port.ts";
import { ChatSessionHost } from "../interactive/components/chat-session-host.ts";
import { onTaskDismissed } from "../interactive/components/task-dismissal.ts";
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

interface TrackedChildTask {
	sessionId?: string;
	sessionFile?: string;
	interrupted: boolean;
	readOnly: boolean;
	settled: boolean;
	dismissed: boolean;
	resumeInvalidationPending: boolean;
	followedSession?: TaskTranscriptSource;
	unsubscribeSession?: () => void;
}

const AUTO_RESTART_CONTINUATION_PREFIX = "Atomic restarted while you were working";

function userMessagePlainText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: { readonly type?: unknown; readonly text?: unknown }) =>
			part.type === "text" && typeof part.text === "string" ? [part.text] : [],
		)
		.join("\n");
}

class EngineAgentViewRegistry implements EngineAgentViews {
	private readonly views = new Map<string, EngineView>();
	private nextView = 0;
	private readonly context: EngineAgentViewContext;
	private readonly stopInvalidationWatch: () => void;

	constructor(context: EngineAgentViewContext) {
		this.context = context;
		this.stopInvalidationWatch = this.watchChildInvalidations();
	}

	port(viewId: string): AgentViewPort | undefined {
		return this.views.get(viewId)?.port;
	}

	private hasOpenViewForSession(sessionId: string): boolean {
		for (const view of this.views.values()) {
			if (view.port.status().sessionId === sessionId) return true;
		}
		return false;
	}

	private emitInvalidation(
		sessionId: string | undefined,
		sessionFile: string | undefined,
		reason: "stopped" | "cleared" | "session-ended" | "sent-elsewhere",
	): void {
		if (sessionId === undefined || sessionId.length === 0) return;
		this.context.send({
			type: "engine_agent_queue_invalidated",
			sessionId,
			...(sessionFile === undefined ? {} : { sessionFile }),
			reason,
		});
	}

	/**
	 * Watch child subagent lifecycle in this engine so the host drops any pending lost-queue restore when a child is
	 * stopped, cleared, ended non-resumably, or sent input by another path before the user reopens it.
	 */
	private watchChildInvalidations(): () => void {
		const { session } = this.context;
		let boundStore: OwnerTaskStore | undefined;
		let stopStore: (() => void) | undefined;
		let stopActions: (() => void) | undefined;
		let stopDismiss: (() => void) | undefined;
		let stopTranscriptBind: (() => void) | undefined;
		const tracked = new Map<TaskId, TrackedChildTask>();
		let initialScanComplete = false;

		const cleanupTracked = (taskId: TaskId) => {
			const entry = tracked.get(taskId);
			entry?.unsubscribeSession?.();
			tracked.delete(taskId);
		};

		const cleanupAllTracked = () => {
			for (const taskId of [...tracked.keys()]) cleanupTracked(taskId);
		};

		const attachSessionSubscription = (entry: TrackedChildTask, transcript: TaskTranscriptSource | undefined) => {
			if (entry.followedSession === transcript) return;
			entry.unsubscribeSession?.();
			entry.unsubscribeSession = undefined;
			entry.followedSession = transcript;
			if (transcript?.subscribe === undefined) return;
			let seenUserMessage = transcript
				.getEntries()
				.some((row) => row.type === "message" && row.message.role === "user");
			entry.unsubscribeSession = transcript.subscribe((event) => {
				if (event.type !== "message_start") return;
				const sid = entry.sessionId ?? transcript.getSessionId();
				const sfile = entry.sessionFile ?? transcript.getSessionFile?.();
				if (event.message.role === "custom") {
					const customType = (event.message as { readonly customType?: unknown }).customType;
					if (customType === "intercom_message" && !this.hasOpenViewForSession(sid)) {
						this.emitInvalidation(sid, sfile, "sent-elsewhere");
					}
					return;
				}
				if (event.message.role === "user") {
					const text = userMessagePlainText(event.message.content).trim();
					if (text.length === 0 || text.startsWith(AUTO_RESTART_CONTINUATION_PREFIX)) return;
					if (seenUserMessage && !this.hasOpenViewForSession(sid)) {
						this.emitInvalidation(sid, sfile, "sent-elsewhere");
					}
					seenUserMessage = true;
				}
			});
		};

		const syncStore = () => {
			const store = boundStore;
			if (store === undefined) return;
			const source = ownerTaskViewSource(store);
			const dismissedPanel = dismissedAgentPanelItems(session);
			const present = new Set<TaskId>();
			const liveSessions = new Set<string>();
			for (const task of store.tasks) {
				if (task.kind !== "agent") continue;
				const taskId = task.ref.taskId;
				present.add(taskId);
				const follow = source.followTaskTranscript(taskId)?.session;
				const sid = follow?.getSessionId?.();
				const sfile = follow?.getSessionFile?.();
				if (sid !== undefined) liveSessions.add(sid);
				const interrupted = isTaskTurnInterrupted(task);
				const readOnly = source.taskReadOnlyReason?.(taskId) !== undefined;
				const settled = task.execution.kind === "settled";
				const dismissed = dismissedPanel.has(`task:${taskId}`);
				const existing = tracked.get(taskId);
				if (existing === undefined) {
					const isResumedAfterStartup =
						initialScanComplete && String(task.launchOperationId ?? "").includes(":resume:");
					const created: TrackedChildTask = {
						...(sid === undefined ? {} : { sessionId: sid }),
						...(sfile === undefined ? {} : { sessionFile: sfile }),
						interrupted,
						readOnly,
						settled,
						dismissed,
						resumeInvalidationPending: isResumedAfterStartup && sid === undefined,
					};
					tracked.set(taskId, created);
					attachSessionSubscription(created, follow);
					// A resumed attempt launched after startup (subagent resume / intercom wake) sent input by another path.
					if (isResumedAfterStartup && sid !== undefined && !this.hasOpenViewForSession(sid)) {
						this.emitInvalidation(sid, sfile, "sent-elsewhere");
					}
					continue;
				}
				if (sid !== undefined) existing.sessionId = sid;
				if (sfile !== undefined) existing.sessionFile = sfile;
				attachSessionSubscription(existing, follow);
				if (existing.resumeInvalidationPending && existing.sessionId !== undefined) {
					existing.resumeInvalidationPending = false;
					if (!this.hasOpenViewForSession(existing.sessionId)) {
						this.emitInvalidation(existing.sessionId, existing.sessionFile, "sent-elsewhere");
					}
				}

				if (!existing.interrupted && interrupted) {
					this.emitInvalidation(existing.sessionId, existing.sessionFile, "stopped");
				}
				if (
					!existing.settled &&
					settled &&
					task.execution.kind === "settled" &&
					task.execution.result.kind === "cancelled" &&
					task.execution.result.released === undefined
				) {
					this.emitInvalidation(existing.sessionId, existing.sessionFile, "stopped");
				}
				if (!existing.readOnly && readOnly) {
					this.emitInvalidation(existing.sessionId, existing.sessionFile, "session-ended");
				}
				if (!existing.dismissed && dismissed) {
					this.emitInvalidation(existing.sessionId, existing.sessionFile, "cleared");
				}
				existing.interrupted = interrupted;
				existing.readOnly = readOnly;
				existing.settled = settled;
				existing.dismissed = dismissed;
			}
			for (const [taskId, entry] of [...tracked]) {
				if (present.has(taskId)) continue;
				if (entry.sessionId !== undefined && !liveSessions.has(entry.sessionId)) {
					this.emitInvalidation(entry.sessionId, entry.sessionFile, "cleared");
				}
				cleanupTracked(taskId);
			}
			initialScanComplete = true;
		};

		const bindStore = (store: OwnerTaskStore | undefined) => {
			if (store === boundStore) return;
			stopStore?.();
			stopActions?.();
			stopDismiss?.();
			stopTranscriptBind?.();
			cleanupAllTracked();
			boundStore = store;
			initialScanComplete = false;
			if (store === undefined) return;
			const source = ownerTaskViewSource(store);
			stopStore = store.subscribe(syncStore);
			stopTranscriptBind = watchTaskTranscriptBindings(store.supervisor, () => syncStore());
			stopActions = onOwnerTaskAction(store, (event) => {
				const entry = tracked.get(event.taskId);
				const sid = event.sessionId ?? entry?.sessionId;
				const sfile = event.sessionFile ?? entry?.sessionFile;
				if (event.action === "sent") {
					if (sid !== undefined && !this.hasOpenViewForSession(sid)) {
						this.emitInvalidation(sid, sfile, "sent-elsewhere");
					}
					return;
				}
				this.emitInvalidation(sid, sfile, event.action);
			});
			stopDismiss = onTaskDismissed(source, (taskId) => {
				const entry = tracked.get(taskId);
				const follow = source.followTaskTranscript(taskId)?.session;
				const sid = entry?.sessionId ?? follow?.getSessionId?.();
				const sfile = entry?.sessionFile ?? follow?.getSessionFile?.();
				this.emitInvalidation(sid, sfile, "cleared");
			});
			syncStore();
		};

		const stopBinding = watchOwnerTaskStoreBinding(session, () => bindStore(getOwnerTaskStore(session)));
		const stopPanel = subscribeAgentPanel(session, () => syncStore());
		bindStore(getOwnerTaskStore(session));
		return () => {
			stopPanel();
			stopBinding();
			stopStore?.();
			stopActions?.();
			stopDismiss?.();
			stopTranscriptBind?.();
			cleanupAllTracked();
		};
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
		let sentShown = port.userMessagesShown();
		const unsubscribe = port.subscribe(() => {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(() => {
				scheduled = false;
				if (this.views.get(viewId)?.port !== port) return;
				const status = port.status();
				const rows = queuedRowTexts(status);
				const shown = port.userMessagesShown();
				// A queued row the host takes away because its message reached the transcript goes after that
				// transcript: its frame, if one is due, is sent first, so no frame the host paints shows the message in
				// neither place. A row taken back without a delivery (Alt+Up, Esc) goes at once.
				if (shown !== sentShown && removesRow(sentRows, rows)) mount.paintPendingFrame();
				sentRows = rows;
				sentShown = shown;
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
		this.stopInvalidationWatch();
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
