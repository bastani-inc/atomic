import { getKeybindings, type KeybindingsManager, matchesKey, Text } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { TaskId } from "../../../core/tasks/contracts.js";
import { TaskMessageError } from "../../../core/tasks/message-error.js";
import type { TaskTranscriptSource } from "../../../core/tasks/supervisor.js";
import {
	launchedTaskViewSource,
	type TaskTranscriptView,
	type TaskViewResult,
	type TaskViewSource,
} from "../../../core/tasks/task-view-source.js";
import { theme } from "../theme/theme.js";
import type { ChatSessionHost } from "./chat-session-host.ts";
import type { ChatSessionHostOpts, ChatSessionHostStyle } from "./chat-session-host-types.ts";
import { ScrollableComponentViewport } from "./chat-transcript.js";
import { applyInputLabelToEditorTopRule } from "./input-label.ts";
import { taskDisplayText } from "./task-row.js";
import { TRANSCRIPT_JUMP_TO_END_URL } from "./transcript-follow-indicator.ts";

/** Where a task's transcript view is mounted: the chat host it builds on and the render settings it inherits. */
export interface TaskTranscriptEnvironment {
	createChat(opts: ChatSessionHostOpts): ChatSessionHost;
	readonly tui?: ChatSessionHostOpts["tui"];
	readonly keybindings?: unknown;
	readonly editorTheme: ChatSessionHostOpts["editorTheme"];
	readonly editorFactory?: ChatSessionHostOpts["editorFactory"];
	readonly style: ChatSessionHostStyle;
	readonly getChatRenderSettings?: ChatSessionHostOpts["getChatRenderSettings"];
	/** What the transcript chat's footer reads of git and providers; without it the footer counts tasks only. */
	readonly footerData?: ChatSessionHostOpts["footerData"];
	readonly getToolsExpanded?: () => boolean;
	readonly setToolsExpanded?: (expanded: boolean) => void;
	/** Tells the reader about a message that failed after they left its transcript and the task pages. */
	readonly notify?: (message: string) => void;
}

/** A message that failed after its reader left the transcript, kept for when they open it again. */
interface UndeliveredMessage {
	readonly text: string;
	readonly reason: string;
}

const undeliveredMessages = new WeakMap<TaskViewSource, Map<TaskId, UndeliveredMessage>>();

function failureText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What the task inspector shows under a task's title while its transcript is open. */
export interface TaskTranscriptPage {
	/** Loading, retention and failure notes for the page's footer. */
	readonly status: string;
	load(): Promise<void>;
	/** The task changed: follow its session again or read its latest page again. */
	refresh(): void;
	handleInput(data: string): boolean;
	/** Whether the reader is typing, so a key such as Left edits instead of leaving. */
	hasDraft(): boolean;
	/** Whether the page takes Escape and Left itself, as while its own task list is open. */
	handlesBack(): boolean;
	render(width: number, rows: number): string[];
	invalidate(): void;
	dispose(): void;
}

/** Atomic's global theme, as the shared chat host's style. */
export function themedChatHostStyle(): ChatSessionHostStyle {
	return {
		dim: (text) => theme.fg("dim", text),
		text: (text) => theme.fg("text", text),
		textMuted: (text) => theme.fg("muted", text),
		accent: (text) => theme.fg("accent", text),
		accentBold: (text) => theme.bold(theme.fg("accent", text)),
		workingIndicatorUseGlobalTheme: true,
		rule: (_hex, text) => theme.fg("borderMuted", text),
		cursor: () => "\x1b[7m \x1b[27m",
		blank: (width) => " ".repeat(Math.max(0, width)),
		editorRuleColor: () => "",
	};
}

function keybindingsOf(candidate: unknown): Pick<KeybindingsManager, "matches"> {
	const keybindings = candidate as Partial<Pick<KeybindingsManager, "matches">> | undefined;
	return typeof keybindings?.matches === "function"
		? (keybindings as Pick<KeybindingsManager, "matches">)
		: getKeybindings();
}

/** The subagent's footer shows its own session: the extension statuses of the chat that opened it are not its own. */
function withoutExtensionStatuses(data: ReadonlyFooterDataProvider): ReadonlyFooterDataProvider {
	return {
		getGitBranch: (cwd) => data.getGitBranch(cwd),
		getAvailableProviderCount: () => data.getAvailableProviderCount(),
		onBranchChange: (callback, cwd) => data.onBranchChange(callback, cwd),
		getExtensionStatuses: () => new Map(),
	};
}

async function settled<T>(read: T | Promise<T>): Promise<T> {
	return read instanceof Promise ? await read : read;
}

/**
 * An agent task's transcript on the shared chat host: it opens at the latest page, follows the task's live session
 * where it has one, loads earlier retained history as the reader nears the top, and sends what the reader types to
 * the task through its Intercom target.
 */
export class TaskAgentTranscriptPage implements TaskTranscriptPage {
	readonly chat: ChatSessionHost;
	status = "Loading transcript…";
	private readonly source: TaskViewSource;
	private readonly taskId: TaskId;
	private readonly env: TaskTranscriptEnvironment;
	private readonly requestRender: () => void;
	private followed?: TaskTranscriptSource;
	private unsubscribe?: () => void;
	private cursor?: string;
	private loading = false;
	private reloadPending = false;
	private loadingEarlier = false;
	/** A history-only transcript changed while the reader was away from its end; it is read again when they return. */
	private behind = false;
	private disposed = false;

	private readonly reportLate: (reason: string) => void;

	/** `reportLate` shows the reason a message failed after the reader left this transcript. */
	constructor(
		source: TaskViewSource,
		taskId: TaskId,
		env: TaskTranscriptEnvironment,
		requestRender: () => void,
		reportLate: (reason: string) => void = (reason) => env.notify?.(reason),
	) {
		this.source = source;
		this.taskId = taskId;
		this.env = env;
		this.requestRender = requestRender;
		this.reportLate = reportLate;
		this.chat = env.createChat({
			style: env.style,
			tui: env.tui,
			keybindings: env.keybindings,
			editorTheme: env.editorTheme,
			editorFactory: env.editorFactory,
			getChatRenderSettings: env.getChatRenderSettings,
			...(env.footerData === undefined ? {} : { footerData: withoutExtensionStatuses(env.footerData) }),
			getChatBoxSession: () => this.followed?.chatSession,
			requestRender,
			taskRowsInChat: false,
			isStreaming: () => this.followed?.getStreamingMessage?.() !== undefined,
			isDisabled: () => source.sendTaskMessage === undefined,
			onNearTop: () => this.loadEarlier(),
			// A subagent's `/tasks` lists the tasks it launched, as a stage chat's lists the stage's own.
			getTaskSource: () => launchedTaskViewSource(source, taskId),
			commands: {
				send: (text) => this.send(text),
				handleSlashCommand: (text) => this.chat.openTasks(text.split(/\s+/)[1]),
			},
		});
		this.restoreUndelivered();
	}

	async load(): Promise<void> {
		if (this.loading) {
			this.reloadPending = true;
			return;
		}
		this.loading = true;
		try {
			// A synchronous read subscribes in the same turn, so no event queued during the read is missed.
			const read = this.source.readTaskTranscript(this.taskId);
			const page = read instanceof Promise ? await read : read;
			if (this.disposed) return;
			this.adoptLatestPage(page);
		} catch (error) {
			if (!this.disposed) this.status = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.requestRender();
			if (this.reloadPending && !this.disposed) {
				this.reloadPending = false;
				this.refresh();
			}
		}
	}

	refresh(): void {
		if (this.disposed) return;
		const follow = this.source.followTaskTranscript(this.taskId);
		if (follow?.session !== undefined && follow.session === this.followed) return;
		// Reading a history-only transcript again replaces what is shown, so it waits while the reader is above the end.
		if (follow?.historyOnly === true && this.chat.bodyScrollFromBottom() > 0) {
			this.behind = true;
			return;
		}
		void this.load();
	}

	handleInput(data: string): boolean {
		const handled = this.route(data);
		if (this.behind && this.chat.bodyScrollFromBottom() === 0) {
			this.behind = false;
			void this.load();
		}
		return handled;
	}

	private route(data: string): boolean {
		if (data === TRANSCRIPT_JUMP_TO_END_URL) {
			this.chat.scrollToBottom();
			this.requestRender();
			return true;
		}
		const keybindings = keybindingsOf(this.env.keybindings);
		// The host owns thinking display; only its default physical key leaves the composer, as in a stage chat.
		if (matchesKey(data, "ctrl+t") && keybindings.matches(data, "app.thinking.toggle")) return false;
		if (keybindings.matches(data, "app.tools.expand")) {
			if (this.env.setToolsExpanded === undefined) return false;
			this.env.setToolsExpanded(this.env.getToolsExpanded?.() !== true);
			this.chat.invalidate();
			this.requestRender();
			return true;
		}
		// The subagent's own task list is modal while it is open, as in a stage chat.
		const handled = this.chat.hasTaskInspector ? this.chat.handleTaskInput(data) : this.chat.handleInput(data);
		this.requestRender();
		return handled;
	}

	/** The chat box of a stage chat: the transcript, then pending, working, usage, the named editor and the footer. */
	render(width: number, rows: number): string[] {
		const viewport = Math.max(1, rows);
		if (this.chat.hasTaskInspector) {
			const footer = this.chat.taskInspectorFullscreen ? [] : this.chat.renderFooter(width);
			const shownFooter = footer.slice(0, viewport - 1);
			return [...this.chat.renderBody(width, viewport - shownFooter.length), ...shownFooter];
		}
		let remaining = viewport;
		// The editor keeps its rows first, then the footer, then the status rows; the transcript takes what is left.
		const reserve = (lines: string[], fromEnd = false): string[] => {
			const shown = fromEnd ? lines.slice(Math.max(0, lines.length - remaining)) : lines.slice(0, remaining);
			remaining -= shown.length;
			return shown;
		};
		const editor = reserve(
			applyInputLabelToEditorTopRule(this.env.style, "subagent", this.sessionName(), this.chat.renderEditor(width)),
		);
		const footer = reserve(this.chat.renderFooter(width));
		const pending = reserve(this.chat.renderPendingMessages(width));
		const working = reserve(this.chat.renderWorkingStatus(width), true);
		const usage = reserve(this.chat.renderUsage(width));
		const body = remaining > 0 ? this.chat.renderBody(width, remaining) : [];
		return [...body, ...pending, ...working, ...usage, ...editor, ...footer];
	}

	/** What the subagent's session is called: its Intercom name, else its agent's name. */
	private sessionName(): string | undefined {
		return (
			this.source.followTaskTranscript(this.taskId)?.session?.completionSource?.intercomTarget ??
			this.source.tasks.find((task) => task.ref.taskId === this.taskId)?.agentName
		);
	}

	invalidate(): void {
		this.chat.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.chat.dispose();
	}

	hasDraft(): boolean {
		return this.chat.hasInputText();
	}

	handlesBack(): boolean {
		return this.chat.hasTaskInspector;
	}

	private adoptLatestPage(page: TaskViewResult<TaskTranscriptView>): void {
		if (!page.ok) {
			this.status = page.error.message;
			return;
		}
		const follow = this.source.followTaskTranscript(this.taskId);
		// A reader who moved above the end while this read was on its way keeps their rows until they return.
		if (follow?.historyOnly === true && this.chat.bodyScrollFromBottom() > 0) {
			this.behind = true;
			return;
		}
		const session = follow?.session?.subscribe === undefined ? undefined : follow.session;
		this.chat.replaceMessages(page.value.messages);
		this.chat.hydrateCompactionStatus(page.value.compactionReason);
		this.cursor = page.value.nextCursor;
		this.status = "";
		if (session === this.followed) return;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.followed = session;
		if (session === undefined) return;
		this.chat.hydrateStreamingAssistantMessage(session.getStreamingMessage?.());
		this.hydrateRunningTurn(session);
		this.unsubscribe = session.subscribe?.((event) => {
			this.chat.applyAgentEvent(event);
			this.requestRender();
		});
	}

	/** A page opened mid-turn missed `agent_start` and `queue_update`, so it reads the turn and the queue now. */
	private hydrateRunningTurn(session: TaskTranscriptSource): void {
		if (session.isRunning?.() === true) this.chat.beginExternalPromptLifecycle();
		const queued = session.getQueuedMessages?.();
		if (queued === undefined) return;
		this.chat.applyAgentEvent({ type: "queue_update", steering: queued.steering, followUp: queued.followUp });
	}

	private loadEarlier(): void {
		const cursor = this.cursor;
		if (cursor === undefined || this.loadingEarlier || this.loading || this.disposed) return;
		this.loadingEarlier = true;
		void (async () => {
			try {
				const page = await settled(this.source.readTaskTranscript(this.taskId, cursor));
				if (this.disposed || cursor !== this.cursor) return;
				if (!page.ok) {
					this.cursor = undefined;
					this.status = page.error.message;
					return;
				}
				this.cursor = page.value.nextCursor;
				this.chat.prependMessages(page.value.messages);
			} catch (error) {
				if (this.disposed) return;
				this.cursor = undefined;
				this.status = error instanceof Error ? error.message : String(error);
			} finally {
				this.loadingEarlier = false;
				this.requestRender();
			}
		})();
	}

	private async send(text: string): Promise<void> {
		const send = this.source.sendTaskMessage;
		if (send === undefined) throw new TaskMessageError("messages-unsupported", { taskId: this.taskId });
		try {
			await send.call(this.source, this.taskId, text);
		} catch (error) {
			if (!this.disposed) throw error;
			this.keepUndelivered(text, failureText(error));
		}
	}

	/** The reader left before the answer: report it once, and give the text back when they return. */
	private keepUndelivered(text: string, reason: string): void {
		const kept = undeliveredMessages.get(this.source) ?? new Map<TaskId, UndeliveredMessage>();
		const earlier = kept.get(this.taskId);
		kept.set(this.taskId, { text: earlier === undefined ? text : `${earlier.text}\n${text}`, reason });
		undeliveredMessages.set(this.source, kept);
		this.reportLate(reason);
	}

	private restoreUndelivered(): void {
		const kept = undeliveredMessages.get(this.source);
		const message = kept?.get(this.taskId);
		if (message === undefined) return;
		kept?.delete(this.taskId);
		this.chat.setInputText(message.text);
		this.chat.showWarning(message.reason);
	}
}

/** The retained tail of a shell task's output on the shared viewport. */
export class TaskCommandOutputPage implements TaskTranscriptPage {
	static readonly TAIL_BYTES = 8192;
	status = "Loading output…";
	private readonly source: TaskViewSource;
	private readonly taskId: TaskId;
	private readonly byteCount: () => bigint;
	private readonly requestRender: () => void;
	private readonly viewport: ScrollableComponentViewport;
	private output = new Text("", 0, 0);
	private loading = false;
	private reloadPending = false;
	private disposed = false;

	constructor(
		source: TaskViewSource,
		taskId: TaskId,
		byteCount: () => bigint,
		env: Pick<TaskTranscriptEnvironment, "keybindings" | "getChatRenderSettings"> | undefined,
		requestRender: () => void,
	) {
		this.source = source;
		this.taskId = taskId;
		this.byteCount = byteCount;
		this.requestRender = requestRender;
		this.viewport = new ScrollableComponentViewport(env?.keybindings, {
			wheelScrollLines: () => env?.getChatRenderSettings?.()?.fullscreenWheelScrollLines,
			scrollbar: () => env?.getChatRenderSettings?.()?.fullscreenScrollbar,
			scrollbarThumbStyle: (text) => theme.bg("scrollbarThumb", text),
			requestRender,
		});
		this.viewport.setComponents([this.output]);
	}

	async load(): Promise<void> {
		if (this.loading) {
			this.reloadPending = true;
			return;
		}
		this.loading = true;
		const count = this.byteCount();
		const tail = BigInt(TaskCommandOutputPage.TAIL_BYTES);
		try {
			const page = await this.source.readTaskOutput(this.taskId, {
				start: String(count > tail ? count - tail : 0n),
				maximumBytes: TaskCommandOutputPage.TAIL_BYTES,
			});
			if (this.disposed) return;
			const text = page.ok ? page.value.text : page.error.message;
			this.output = new Text(text.split("\n").map(taskDisplayText).join("\n") || "No output available", 0, 0);
			this.viewport.setComponents([this.output]);
			this.status = count > tail ? "Earlier output omitted · showing retained 8 KiB tail" : "Retained shell output";
		} catch (error) {
			if (!this.disposed) this.status = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.requestRender();
			if (this.reloadPending && !this.disposed) {
				this.reloadPending = false;
				void this.load();
			}
		}
	}

	refresh(): void {
		if (!this.disposed) void this.load();
	}

	handleInput(data: string): boolean {
		const handled = this.viewport.handleInput(data);
		if (handled) this.requestRender();
		return handled;
	}

	hasDraft(): boolean {
		return false;
	}

	handlesBack(): boolean {
		return false;
	}

	render(width: number, rows: number): string[] {
		this.viewport.setVisibleRows(Math.max(1, rows));
		return this.viewport.render(width);
	}

	invalidate(): void {
		this.viewport.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.viewport.dispose();
	}
}
