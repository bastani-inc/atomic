import {
	getKeybindings,
	isHintActivation,
	matchesKey,
	Text,
	type KeybindingsManager as TuiKeybindingsManager,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@bastani/atomic-tui";
import { type HeldPrompt, heldPrompts } from "../../../core/extensions/held-prompts.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { KeybindingsManager } from "../../../core/keybindings.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { sessionWaitsToRetry } from "../../../core/session-retry-status.js";
import { shortTaskTitle } from "../../../core/tasks/agent-panel-source.ts";
import { releasedWaitingOn, waitingReleasedShells, waitingReleasedTools } from "../../../core/tasks/completion.js";
import type { TaskId } from "../../../core/tasks/contracts.js";
import {
	type TaskElapsedClocks,
	taskClockRunning,
	taskClocksFor,
	taskElapsedMs,
} from "../../../core/tasks/live-elapsed.js";
import { TaskMessageError } from "../../../core/tasks/message-error.js";
import { getOwnerTaskSession, isTaskTurnInterrupted, setTaskTurnInterrupted } from "../../../core/tasks/owner-store.js";
import type { ChatBoxSession, TaskTranscriptSource } from "../../../core/tasks/supervisor.js";
import {
	launchedTaskViewSource,
	type TaskTranscriptView,
	type TaskViewResult,
	type TaskViewSource,
} from "../../../core/tasks/task-view-source.js";
import { createSessionSkillAutocompleteProvider, getSkillCatalogCommands } from "../skill-command-autocomplete.ts";
import { theme } from "../theme/theme.js";
import { formatPanelElapsed } from "./agent-panel.ts";
import type { ChatSessionHost } from "./chat-session-host.ts";
import type { ChatSessionHostOpts, ChatSessionHostStyle } from "./chat-session-host-types.ts";
import { ScrollableComponentViewport } from "./chat-transcript.js";
import { type HeldPromptForm, heldPromptForm } from "./held-prompt-form.ts";
import { applyAttachedComposer } from "./input-label.ts";
import { clickableKeyTextHint, navActionText } from "./nav-keys.ts";
import { taskDisplayText, taskState } from "./task-row.js";
import { retainedToolRenderer, unavailableToolRenderer } from "./tool-renderer-scope.js";
import { repaintAfterSingleClick } from "./transcript-block-clicks.ts";
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
/** What the reader had typed in a task's chat when they left it, per chat, for when they come back. */
const keptDrafts = new WeakMap<TaskViewSource, Map<TaskId, string>>();

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
	hasTasks?(): boolean;
	expandable?(): boolean;
	canSend?(): boolean;
	/** Whether the prompt's cursor is at its start, where ← leaves and keeps any draft for the return. */
	cursorAtStart(): boolean;
	/** Whether the page takes Escape and Left itself, as while its own task list is open. */
	handlesBack(): boolean;
	takesEscape?(): boolean;
	capturesPageScroll?(): boolean;
	/** Whether Esc would interrupt the task's current turn now. */
	interruptible(): boolean;
	/** Interrupts the task's current turn; the task keeps running and waits for its next message. */
	interrupt(): Promise<TaskViewResult<undefined>>;
	render(width: number, rows: number): string[];
	/** A single click at row `event.y` of the last frame `render` drew; a result when the page takes it. */
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	/** What the last frame `render` drew on `row`, such as the transcript entry there; undefined when it cannot say. */
	paintedRowKey?(row: number): string | undefined;
	/** Ctrl+O was pressed where the page is shown: its blocks follow the tool-output setting again. */
	toolOutputToggled?(): void;
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

function keybindingsOf(candidate: unknown): Pick<TuiKeybindingsManager, "matches"> {
	const keybindings = candidate as Partial<Pick<TuiKeybindingsManager, "matches">> | undefined;
	return typeof keybindings?.matches === "function"
		? (keybindings as Pick<TuiKeybindingsManager, "matches">)
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

function defaultUnnamedSessionAlias(sessionId: string): string {
	const normalized = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
	return `subagent-chat-${normalized}`;
}

function friendlyOriginIntercomMessage(
	message: CustomMessage<unknown>,
	owner: ChatBoxSession | undefined,
): CustomMessage<unknown> {
	const details = message.details as
		| {
				readonly from?: { readonly id?: string; readonly name?: string; readonly cwd?: string };
		  }
		| undefined;
	if (!details?.from) return message;
	const ownerSessionId = owner?.sessionManager?.getSessionId?.()?.trim();
	if (!ownerSessionId) return message;
	const ownerAlias = defaultUnnamedSessionAlias(ownerSessionId);
	const rawName = details.from.name?.trim() ?? "";
	const matchesOwnerAlias = rawName === ownerAlias;
	const matchesOwnerId =
		details.from.id === ownerSessionId && (rawName === "" || rawName === ownerSessionId || matchesOwnerAlias);
	if (!matchesOwnerAlias && !matchesOwnerId) {
		return message;
	}
	return {
		...message,
		details: {
			...(message.details as object),
			from: {
				...details.from,
				name: "main",
			},
		},
	};
}

/** A subagent stopped resumably (`x x`, Ctrl+X Ctrl+K): a message resumes it, and never anything else. */
export const STOPPED_NOTE = "Stopped · send to resume";

/** Printable text, Enter, Backspace or Delete: keys that type into or send the prompt. */
function isTyping(data: string): boolean {
	if (matchesKey(data, "enter") || matchesKey(data, "backspace") || matchesKey(data, "delete")) return true;
	return [...data].every((ch) => ch >= " " && ch !== "\x7f");
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
	private readonly elapsedClocks: TaskElapsedClocks;
	/** How many rows the transcript took at the top of the last frame. */
	private bodyRows = 0;
	readonly chat: ChatSessionHost;
	private loadStatus = "Loading transcript…";
	/** Loading and failure notes, then why the chat is read-only when it is. */
	get status(): string {
		return [this.loadStatus, this.releasedNote() ?? "", this.readOnlyReason() ?? ""].filter(Boolean).join(" · ");
	}
	/**
	 * What a subagent released while it waits waits on, that it wakes by itself, and the shells it launched that still
	 * run, with the key that opens the newest one's output. Its transcript is its saved session, read without waking it.
	 */
	private releasedNote(): string | undefined {
		const task = this.source.tasks.find((candidate) => candidate.ref.taskId === this.taskId);
		const waitingOn =
			task?.execution.kind === "settled" && waitingReleasedTools(task) !== undefined
				? releasedWaitingOn(task.execution.result)
				: undefined;
		if (task === undefined || waitingOn === undefined) return undefined;
		const shells = waitingReleasedShells(task, this.source.ownerTasks ?? this.source.tasks);
		const openKey = navActionText(getKeybindings(), "app.tasks.openWaited");
		const opens = openKey ? clickableKeyTextHint(openKey, " opens") : "/tasks opens";
		const shellNote =
			shells.length === 0
				? ""
				: shells.length === 1
					? ` · its shell ${taskDisplayText(shortTaskTitle(shells[0]!.title || "shell"))} is running · ${opens} it`
					: ` · ${shells.length} of its shells are running · ${opens} ${openKey ? "the newest" : "them"}`;
		return `Waiting on ${taskDisplayText(waitingOn)} · wakes by itself when it finishes${shellNote}`;
	}
	set status(value: string) {
		this.loadStatus = value;
	}
	/** Why messages cannot reach this task any more, or `undefined` while they can. */
	readOnlyReason(): string | undefined {
		return this.source.taskReadOnlyReason?.(this.taskId);
	}
	private readonly source: TaskViewSource;
	private readonly taskId: TaskId;
	private readonly env: TaskTranscriptEnvironment;
	private readonly requestRender: () => void;
	private followed?: TaskTranscriptSource;
	private followedSessionId?: string;
	private unsubscribe?: () => void;
	private cursor?: string;
	private loading = false;
	private reloadPending = false;
	private loadingEarlier = false;
	/** A history-only transcript changed while the reader was away from its end; it is read again when they return. */
	private behind = false;
	private disposed = false;
	private shownPromptSessionId?: string;
	private readonly unsubscribePrompts: () => void;

	private readonly reportLate: (reason: string) => void;
	private readonly echoedPrompt: string | undefined;

	/** `reportLate` shows the reason a message failed after the reader left this transcript. */
	constructor(
		source: TaskViewSource,
		taskId: TaskId,
		env: TaskTranscriptEnvironment,
		requestRender: () => void,
		reportLate: (reason: string) => void = (reason) => env.notify?.(reason),
		options: { readonly echoedPrompt?: string } = {},
	) {
		this.source = source;
		this.elapsedClocks = taskClocksFor(source);
		this.taskId = taskId;
		this.env = env;
		this.requestRender = requestRender;
		this.reportLate = reportLate;
		this.echoedPrompt = options.echoedPrompt;
		this.chat = env.createChat({
			style: env.style,
			tui: env.tui,
			keybindings: env.keybindings,
			editorTheme: env.editorTheme,
			editorFactory: env.editorFactory,
			getChatRenderSettings: () => {
				const inherited = env.getChatRenderSettings?.();
				return {
					...inherited,
					createToolComponent: inherited?.createToolComponent
						? (entry, context) => inherited.createToolComponent!({ ...entry, rendererTaskId: taskId }, context)
						: undefined,
					getToolDefinition: (toolName) => {
						const session = this.followed?.chatSession;
						if (session?.getToolDefinition || session?.extensionRunner?.resolveToolRenderers) {
							return (
								session.extensionRunner?.resolveToolRenderers?.(toolName, () =>
									session.getToolDefinition?.(toolName),
								) ??
								session.getToolDefinition?.(toolName) ??
								unavailableToolRenderer(toolName)
							);
						}
						const owner = getOwnerTaskSession(this.source) as ChatBoxSession | undefined;
						return retainedToolRenderer(
							toolName,
							(name) =>
								inherited?.getToolDefinition?.(name) ??
								owner?.extensionRunner?.resolveToolRenderers?.(name, () => owner.getToolDefinition?.(name)) ??
								owner?.getToolDefinition?.(name),
						);
					},
					getCustomMessageRenderer: (customType) => {
						const owner = getOwnerTaskSession(this.source) as ChatBoxSession | undefined;
						const base =
							this.followed?.chatSession?.extensionRunner?.getMessageRenderer?.(customType) ??
							inherited?.getCustomMessageRenderer?.(customType) ??
							owner?.extensionRunner?.getMessageRenderer?.(customType);
						if (!base || customType !== "intercom_message") return base;
						return (message, renderOptions, renderTheme) =>
							base(friendlyOriginIntercomMessage(message, owner), renderOptions, renderTheme);
					},
				};
			},
			...(env.footerData === undefined ? {} : { footerData: withoutExtensionStatuses(env.footerData) }),
			getChatBoxSession: () => this.followed?.chatSession,
			getPromptEntries: () =>
				(this.followed ?? this.source.followTaskTranscript(this.taskId)?.session)?.getEntries(),
			requestRender,
			taskRowsInChat: false,
			echoedInitialPrompt: () => (this.cursor === undefined ? this.echoedPrompt : undefined),
			isStreaming: () => this.followed?.getStreamingMessage?.() !== undefined,
			workingTokenCount: () => source.tasks.find((task) => task.ref.taskId === taskId)?.metrics?.tokenCount,
			// A finished subagent's chat stays live, and a message resumes it; one stopped for good is read-only.
			isDisabled: () => source.sendTaskMessage === undefined || this.readOnlyReason() !== undefined,
			onNearTop: () => this.loadEarlier(),
			// A subagent's `/tasks` lists the tasks it launched, as a stage chat's lists the stage's own.
			getTaskSource: () => launchedTaskViewSource(source, taskId),
			// The completion a stage chat offers, from the subagent's own cwd and skills.
			autocompleteProvider: createSessionSkillAutocompleteProvider(async () => {
				const commands = await source.taskCommands?.(taskId);
				return commands === undefined
					? undefined
					: { cwd: commands.cwd, skillCommands: getSkillCatalogCommands(commands.skillCommands) };
			}),
			commands: {
				send: (text) => this.send(text),
				handleSlashCommand: (text) => this.chat.openTasks(text.split(/\s+/)[1]),
			},
		});
		this.restoreDraft();
		this.restoreUndelivered();
		this.unsubscribePrompts = heldPrompts().subscribe((sessionId) => {
			if (sessionId === this.childSessionId() || sessionId === this.shownPromptSessionId) this.requestRender();
		});
	}

	private childSessionId(): string | undefined {
		const task = this.source.tasks.find((candidate) => candidate.ref.taskId === this.taskId);
		const sessionId =
			task?.attention.kind === "input-needed"
				? task.attention.route.sessionId
				: (this.followed?.getSessionId() ?? this.source.followTaskTranscript(this.taskId)?.session?.getSessionId());
		if (sessionId !== undefined) this.shownPromptSessionId = sessionId;
		return sessionId;
	}

	heldPrompt(): HeldPrompt | undefined {
		const task = this.source.tasks.find((candidate) => candidate.ref.taskId === this.taskId);
		if (task?.execution.kind === "settled") return undefined;
		const sessionId = this.childSessionId();
		return sessionId === undefined ? undefined : heldPrompts().current(sessionId);
	}

	private heldForm(): HeldPromptForm | undefined {
		const prompt = this.heldPrompt();
		if (prompt === undefined) return undefined;
		return heldPromptForm(prompt, {
			...(this.env.tui === undefined ? {} : { tui: this.env.tui }),
			...(this.env.keybindings instanceof KeybindingsManager ? { keybindings: this.env.keybindings } : {}),
			requestRender: this.requestRender,
		});
	}

	/** Restores what was typed here before the reader left. */
	private restoreDraft(): void {
		const kept = keptDrafts.get(this.source);
		const draft = kept?.get(this.taskId);
		if (draft === undefined) return;
		kept?.delete(this.taskId);
		this.chat.setInputText(draft);
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
		if (!this.chat.hasTaskInspector && this.chat.hasTransientModal) {
			const handled = this.chat.handleInput(data);
			this.requestRender();
			return handled;
		}
		if (
			!this.chat.hasTaskInspector &&
			keybindings.matches(data, "app.agents.focus") &&
			(!this.hasDraft() || isHintActivation())
		) {
			return this.hasTasks() ? this.chat.openTasks() : true;
		}
		// The host owns thinking display; only its default physical key leaves the composer, as in a stage chat.
		if (matchesKey(data, "ctrl+t") && keybindings.matches(data, "app.thinking.toggle")) return false;
		if (keybindings.matches(data, "app.tools.expand")) {
			if (this.env.setToolsExpanded === undefined) return false;
			this.env.setToolsExpanded(this.env.getToolsExpanded?.() !== true);
			this.chat.toolOutputToggled();
			this.requestRender();
			return true;
		}
		const form = this.chat.hasTaskInspector ? undefined : this.heldForm();
		if (form !== undefined) {
			const selectorPages =
				this.capturesPageScroll() && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"));
			if (!selectorPages && this.chat.handleScrollInput(data)) {
				this.requestRender();
				return true;
			}
			form.handleInput(data);
			this.requestRender();
			return true;
		}
		// A read-only chat scrolls and keeps its keys, but takes no typing: nothing it sends could reach the task.
		if (!this.chat.hasTaskInspector && this.readOnlyReason() !== undefined && isTyping(data)) return true;
		// The subagent's own task list is modal while it is open, as in a stage chat.
		const handled = this.chat.hasTaskInspector ? this.chat.handleTaskInput(data) : this.chat.handleInput(data);
		this.requestRender();
		return handled;
	}

	/** A single click on any row of a block in the transcript expands or collapses that block. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y < 0 || event.y >= this.bodyRows) return undefined;
		// While the task's held question owns input below the transcript, a click on the transcript does nothing.
		if (!this.chat.hasTaskInspector && this.heldPrompt() !== undefined) return undefined;
		return repaintAfterSingleClick(this.chat.handleBodyClick(event), () => this.requestRender());
	}

	paintedRowKey(row: number): string | undefined {
		return row < 0 || row >= this.bodyRows ? undefined : this.chat.bodyRowKey(row);
	}

	toolOutputToggled(): void {
		this.chat.toolOutputToggled();
	}

	/** The chat box of a stage chat: the transcript, then pending, working, usage, the named editor and the footer. */
	render(width: number, rows: number): string[] {
		const viewport = Math.max(1, rows);
		this.bodyRows = 0;
		if (this.chat.hasTaskInspector) {
			const footer = this.chat.taskInspectorFullscreen ? [] : this.chat.renderFooter(width);
			const shownFooter = footer.slice(0, viewport - 1);
			// The chat's own task list or a task's transcript takes the top rows, and clicks there.
			const body = this.chat.renderBody(width, viewport - shownFooter.length);
			this.bodyRows = body.length;
			return [...body, ...shownFooter];
		}
		let remaining = viewport;
		// The editor keeps its rows first, then the footer, then the status rows; the transcript takes what is left.
		const reserve = (lines: string[], fromEnd = false): string[] => {
			const shown = fromEnd ? lines.slice(Math.max(0, lines.length - remaining)) : lines.slice(0, remaining);
			remaining -= shown.length;
			return shown;
		};
		const form = this.heldForm();
		const editor = reserve(
			form !== undefined ? form.render(width) : this.decorateComposer(this.chat.renderEditor(width)),
		);
		const footer = reserve(this.chat.renderFooter(width));
		const pending = reserve(this.chat.renderPendingMessages(width));
		const working = reserve(
			this.chat.renderWorkingStatus(width, this.source.followTaskTranscript(this.taskId)?.publishedActivity),
			true,
		);
		const usage = reserve(this.chat.renderUsageRow(width));
		const body = remaining > 0 ? this.chat.renderBody(width, remaining) : [];
		this.bodyRows = body.length;
		return [...body, ...pending, ...working, ...usage, ...editor, ...footer];
	}

	private decorateComposer(lines: readonly string[]): string[] {
		const task = this.source.tasks.find((candidate) => candidate.ref.taskId === this.taskId);
		const name = taskDisplayText(task?.agentName ?? this.sessionName() ?? "subagent");
		const waiting = task?.attention.kind === "input-needed";
		const state =
			task === undefined
				? undefined
				: waiting
					? "needs input"
					: task.execution.kind === "settled"
						? taskState(task) === "completed"
							? "done"
							: taskState(task)
						: isTaskTurnInterrupted(task)
							? "stopped"
							: task.metrics?.elapsedMs === undefined
								? "running"
								: formatPanelElapsed(
										taskElapsedMs(task, taskClockRunning(task.execution.kind), this.elapsedClocks) ??
											task.metrics.elapsedMs,
									);
		const released = task === undefined ? undefined : waitingReleasedTools(task);
		const stopped = released === undefined && this.source.taskStopped?.(this.taskId) === true;
		const label = [
			name,
			task?.title ? taskDisplayText(shortTaskTitle(task.title)) : "",
			stopped ? "stopped" : released !== undefined ? `waiting on ${taskDisplayText(released)}` : (state ?? ""),
		]
			.filter(Boolean)
			.join(" · ");

		const placeholder = stopped
			? STOPPED_NOTE
			: released !== undefined
				? `Message ${name} to wake it…`
				: `${waiting ? "Answer" : "Message"} ${name}…`;
		return applyAttachedComposer(
			{ accent: this.env.style.accent, text: this.env.style.text, dim: this.env.style.dim },
			label,
			this.chat.hasInputText() || this.source.sendTaskMessage === undefined || this.readOnlyReason() !== undefined
				? undefined
				: placeholder,
			lines,
		);
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
		if (!this.disposed && this.chat.hasInputText()) {
			const kept = keptDrafts.get(this.source) ?? new Map<TaskId, string>();
			kept.set(this.taskId, this.chat.inputText());
			keptDrafts.set(this.source, kept);
		}
		this.disposed = true;
		this.unsubscribePrompts();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.chat.dispose();
	}

	hasDraft(): boolean {
		if (!this.chat.hasTaskInspector && this.heldPrompt() !== undefined) return true;
		return this.chat.hasInputText();
	}

	hasTasks(): boolean {
		return this.chat.hasBackgroundTasks();
	}

	expandable(): boolean {
		return this.env.setToolsExpanded !== undefined;
	}

	canSend(): boolean {
		return this.source.sendTaskMessage !== undefined && this.readOnlyReason() === undefined;
	}

	cursorAtStart(): boolean {
		const form = this.chat.hasTaskInspector ? undefined : this.heldForm();
		if (form !== undefined) return form.capturesBack?.() !== true;
		return this.chat.inputCursorAtStart();
	}

	handlesBack(): boolean {
		return this.chat.hasTaskInspector || this.chat.hasTransientModal;
	}

	takesEscape(): boolean {
		return !this.chat.hasTaskInspector && this.heldPrompt() !== undefined;
	}

	capturesPageScroll(): boolean {
		return (
			!this.chat.hasTaskInspector &&
			this.heldPrompt()?.kind === "select" &&
			(this.heldPrompt()?.choices?.length ?? 0) > 10
		);
	}

	interruptible(): boolean {
		// Between two attempts of a retry nothing streams, and Esc cancels the retry, as it does in the main chat.
		return (
			this.source.interruptTask !== undefined &&
			(this.followed?.isRunning?.() === true || this.followed?.chatSession?.isRetrying === true)
		);
	}

	async interrupt(): Promise<TaskViewResult<undefined>> {
		const interrupt = this.source.interruptTask;
		if (interrupt === undefined)
			return { ok: false, error: { message: "This task's turn cannot be interrupted from here." } };
		return interrupt.call(this.source, this.taskId);
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
		const nextSessionId = follow?.session?.getSessionId?.();
		const sameConversation =
			this.followedSessionId !== undefined &&
			nextSessionId !== undefined &&
			nextSessionId === this.followedSessionId;
		const sessionChanged =
			session !== this.followed || (!sameConversation && nextSessionId !== this.followedSessionId);
		if (sessionChanged) {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			this.followed = session;
			this.chat.resetFollowedSession({ preserveWorkedRun: sameConversation && session === undefined });
		}
		this.followedSessionId = nextSessionId;
		this.cursor = page.value.nextCursor;
		this.chat.replaceMessages(page.value.messages, { preserveUnread: !sessionChanged });
		this.chat.hydrateToolExecutionStarts(page.value.activeToolStarts ?? []);
		this.chat.hydrateCompactionStatus(
			page.value.compactionReason,
			page.value.compactionStartedAt ?? session?.chatSession?.compactionStartedAt,
		);
		this.status = "";
		if (!sessionChanged || session === undefined) return;
		this.chat.hydrateStreamingAssistantMessage(session.getStreamingMessage?.());
		this.hydrateRunningTurn(session, page.value.messages);
		let turnAborted = false;
		this.unsubscribe = session.subscribe?.((event) => {
			if (event.type === "agent_start" || event.type === "turn_start" || event.type === "message_start") {
				turnAborted = false;
				setTaskTurnInterrupted(this.source, this.taskId, false);
			} else if (
				event.type === "message_end" &&
				(event.message as { role?: string; stopReason?: string }).role === "assistant" &&
				(event.message as { stopReason?: string }).stopReason === "aborted"
			) {
				turnAborted = true;
			} else if (event.type === "agent_end" && turnAborted && session.isRunning?.() !== true) {
				turnAborted = false;
				setTaskTurnInterrupted(this.source, this.taskId, true);
			}
			this.chat.applyAgentEvent(event);
			this.requestRender();
		});
	}

	/**
	 * A page opened mid-turn missed `agent_start` and `queue_update`, so it reads the turn and the queue now. Between
	 * two attempts of a retry the page shows the retry's wait instead, also while a session with fallback models keeps
	 * its run open through the wait.
	 */
	private hydrateRunningTurn(session: TaskTranscriptSource, messages: TaskTranscriptView["messages"]): void {
		const chatSession = session.chatSession;
		if (chatSession && sessionWaitsToRetry(chatSession)) {
			setTaskTurnInterrupted(this.source, this.taskId, false);
			this.chat.hydrateRetryWait(messages, chatSession.turnStartedAt);
		} else if (chatSession?.retryStatus?.type === "model_fallback_start") {
			setTaskTurnInterrupted(this.source, this.taskId, false);
			this.chat.hydrateModelSwitch(chatSession.turnStartedAt, messages);
		} else if (session.isRunning?.() === true) {
			setTaskTurnInterrupted(this.source, this.taskId, false);
			this.chat.beginExternalPromptLifecycle();
			this.chat.hydrateRunningTurn(messages, session.getStreamingMessage?.(), chatSession?.turnStartedAt);
		} else if (session.isRunning?.() === false) {
			const lastAssistant = [...messages]
				.reverse()
				.find((message): message is Extract<typeof message, { role: "assistant" }> => message.role === "assistant");
			if (lastAssistant?.stopReason === "aborted") {
				setTaskTurnInterrupted(this.source, this.taskId, true);
			}
		}
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
		const draft = this.chat.inputText();
		this.chat.setInputText(draft ? `${message.text}\n${draft}` : message.text);
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

	cursorAtStart(): boolean {
		return true;
	}

	handlesBack(): boolean {
		return false;
	}

	interruptible(): boolean {
		return false;
	}

	async interrupt(): Promise<TaskViewResult<undefined>> {
		return { ok: false, error: { message: "A shell's output has no turn to interrupt." } };
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
