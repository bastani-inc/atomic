import { getKeybindings, type KeybindingsManager, matchesKey, Text } from "@earendil-works/pi-tui";
import type { TaskId } from "../../../core/tasks/contracts.js";
import { TaskMessageError } from "../../../core/tasks/message-error.js";
import type { TaskTranscriptSource } from "../../../core/tasks/supervisor.js";
import type { TaskTranscriptView, TaskViewResult, TaskViewSource } from "../../../core/tasks/task-view-source.js";
import { theme } from "../theme/theme.js";
import type { ChatSessionHost } from "./chat-session-host.ts";
import type { ChatSessionHostOpts, ChatSessionHostStyle } from "./chat-session-host-types.ts";
import { ScrollableComponentViewport } from "./chat-transcript.js";
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
	readonly getToolsExpanded?: () => boolean;
	readonly setToolsExpanded?: (expanded: boolean) => void;
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
	private historical = false;
	private disposed = false;

	constructor(source: TaskViewSource, taskId: TaskId, env: TaskTranscriptEnvironment, requestRender: () => void) {
		this.source = source;
		this.taskId = taskId;
		this.env = env;
		this.requestRender = requestRender;
		this.chat = env.createChat({
			style: env.style,
			tui: env.tui,
			keybindings: env.keybindings,
			editorTheme: env.editorTheme,
			editorFactory: env.editorFactory,
			getChatRenderSettings: env.getChatRenderSettings,
			requestRender,
			taskRowsInChat: false,
			isStreaming: () => this.followed?.getStreamingMessage?.() !== undefined,
			isDisabled: () => source.sendTaskMessage === undefined,
			onNearTop: () => this.loadEarlier(),
			commands: { send: (text) => this.send(text) },
		});
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
		// A history-only transcript the reader paged back through stays where it is.
		if (follow?.historyOnly === true && this.historical) return;
		void this.load();
	}

	handleInput(data: string): boolean {
		if (data === TRANSCRIPT_JUMP_TO_END_URL) {
			this.chat.scrollToBottom();
			this.requestRender();
			return true;
		}
		const keybindings = keybindingsOf(this.env.keybindings);
		// The host owns thinking display; only its default physical key leaves the composer, as in a stage chat.
		if (matchesKey(data, "ctrl+t") && keybindings.matches(data, "app.thinking.toggle")) return false;
		if (keybindings.matches(data, "app.tools.expand") && this.env.setToolsExpanded !== undefined) {
			this.env.setToolsExpanded(this.env.getToolsExpanded?.() !== true);
			this.chat.invalidate();
			this.requestRender();
			return true;
		}
		const handled = this.chat.handleInput(data);
		this.requestRender();
		return handled;
	}

	render(width: number, rows: number): string[] {
		const working = this.chat.renderWorkingStatus(width);
		const editor = this.chat.renderEditor(width);
		const bodyRows = Math.max(1, rows - working.length - editor.length);
		return [...this.chat.renderBody(width, bodyRows), ...working, ...editor].slice(0, Math.max(1, rows));
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

	private adoptLatestPage(page: TaskViewResult<TaskTranscriptView>): void {
		if (!page.ok) {
			this.status = page.error.message;
			return;
		}
		const follow = this.source.followTaskTranscript(this.taskId);
		const session = follow?.session?.subscribe === undefined ? undefined : follow.session;
		this.chat.replaceMessages(page.value.messages);
		this.chat.hydrateCompactionStatus(page.value.compactionReason);
		this.cursor = page.value.nextCursor;
		this.historical = false;
		this.status = "";
		if (session === this.followed) return;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.followed = session;
		if (session === undefined) return;
		this.chat.hydrateStreamingAssistantMessage(session.getStreamingMessage?.());
		this.unsubscribe = session.subscribe?.((event) => {
			this.chat.applyAgentEvent(event);
			this.requestRender();
		});
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
				this.historical = true;
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
		await send.call(this.source, this.taskId, text);
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
