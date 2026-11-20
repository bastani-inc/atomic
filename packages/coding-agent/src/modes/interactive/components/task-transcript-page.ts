import {
	getKeybindings,
	isHintActivation,
	matchesKey,
	Text,
	type KeybindingsManager as TuiKeybindingsManager,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@bastani/atomic-tui";
import { chatReceiptWrite } from "../../../core/chat-receipts.js";
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
import type {
	ChatBoxSession,
	QueuedTaskMessages,
	TaskMessageLane,
	TaskTranscriptSource,
} from "../../../core/tasks/supervisor.js";
import { observedTaskChatWrite, withTaskChatRows } from "../../../core/tasks/task-chat-records.js";
import {
	launchedTaskViewSource,
	liveTaskRowOrigin,
	readTaskPageForChat,
	readTaskPageForView,
	retainTaskWindowReader,
	savedBoundaryCursor,
	type TaskTranscriptView,
	type TaskViewResult,
	type TaskViewSource,
	taskCursorsAround,
} from "../../../core/tasks/task-view-source.js";
import { noteSavedSeq } from "../../../core/tasks/transcript-origin.js";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { combineQueuedMessagesForEditor } from "../chat-input-actions.ts";
import {
	classifyChatCommand,
	createSessionSkillAutocompleteProvider,
	getSkillCatalogCommands,
} from "../skill-command-autocomplete.ts";
import { subagentChatCommand, subagentChatUnavailableNotice } from "../subagent-chat-commands.ts";
import { theme } from "../theme/theme.js";
import { formatPanelElapsed } from "./agent-panel.ts";
import type { ChatSessionHost, SavedPageHandle } from "./chat-session-host.ts";
import type { SavedPageNeighbours } from "./chat-session-host-saved-calls.ts";
import type { ChatSteeringTarget } from "./chat-session-host-steering.ts";
import type { ChatSessionHostOpts, ChatSessionHostStyle } from "./chat-session-host-types.ts";
import { parseWheelReport, ScrollableComponentViewport } from "./chat-transcript.js";
import { type HeldPromptForm, heldPromptForm } from "./held-prompt-form.ts";
import { applyAttachedComposer } from "./input-label.ts";
import { clickableKeyTextHint, navActionText } from "./nav-keys.ts";
import type { ParkedTaskRows } from "./parked-rows.ts";
import { taskDisplayText, taskState } from "./task-row.js";
import { pagedNotices, TaskTranscriptNotices } from "./task-transcript-notices.ts";
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

/** The last live frame is already complete. An archiving child must not replace it with a snapshot that
 * predates its last diagnostic. Only the view tracks these writes; it immediately releases the live child. */
class ObservedChatWrites {
	private count = 0;
	onIdle?: () => void;
	get pending(): boolean {
		return this.count > 0;
	}
	observe(write: Promise<void>): void {
		this.count++;
		observeChatWrite(write, new WeakRef(this));
	}
	settle(): void {
		if (--this.count === 0) {
			const ready = this.onIdle;
			this.onIdle = undefined;
			ready?.();
		}
	}
}
function observeChatWrite(write: Promise<void>, view: WeakRef<ObservedChatWrites>): void {
	void write.then(
		() => view.deref()?.settle(),
		() => view.deref()?.settle(),
	);
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
	/** Whether Esc would pause the task now: a turn runs or waits to retry, or messages are queued, as in the main chat. */
	interruptible(): boolean;
	/**
	 * Pauses the task, as Esc does: its queued messages come back to the prompt, steering first, ahead of the draft, and
	 * its turn ends. The task keeps running, paused, and its next message continues it.
	 */
	interrupt(): Promise<TaskViewResult<undefined>>;
	/**
	 * Put messages taken back from the task's queue into the prompt, steering messages first and then follow-ups, in
	 * front of what is typed, as Alt+Up does. Answers how many came back.
	 */
	restoreQueuedToEditor?(taken: QueuedTaskMessages): number;
	/** Ctrl+C: clear the typed prompt, as the main chat does. Answers whether there was one to clear. */
	clearDraft?(): boolean;
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
/** A subagent paused from its chat (Esc): it is still running, and a message continues it. */
export const PAUSED_NOTE = "Paused · send to continue";

/** Printable text, Enter, Backspace or Delete: keys that type into or send the prompt. */
function isTyping(data: string): boolean {
	if (matchesKey(data, "enter") || matchesKey(data, "backspace") || matchesKey(data, "delete")) return true;
	return [...data].every((ch) => ch >= " " && ch !== "\x7f");
}

interface AdjacentRequest {
	edge: "older" | "newer";
	cursor: string;
	generation: number;
	controller: AbortController;
	source?: WeakRef<TaskTranscriptSource>;
}
const finishAdjacent = Symbol();
function deliverAdjacent(
	weak: WeakRef<TaskAgentTranscriptPage>,
	request: AdjacentRequest,
	read: TaskViewResult<TaskTranscriptView> | Promise<TaskViewResult<TaskTranscriptView>>,
): void {
	void Promise.resolve(read).then(
		(page) => weak.deref()?.[finishAdjacent](request, page),
		(error) => weak.deref()?.[finishAdjacent](request, { ok: false, error: { message: failureText(error) } }),
	);
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
	private legacyWindow?: ReturnType<typeof retainTaskWindowReader>;
	private legacyWindowActive = false;
	private observedWrites?: ObservedChatWrites;
	private unsubscribe?: () => void;
	private cursor?: string;
	private newerCursor?: string;
	private liveHistoryStart?: string;
	private olderIntent = false;
	/** Which way the reader last scrolled: a live chat reads saved pages only that way, never both at once. */
	private travel: "older" | "newer" | undefined;
	private goToFirst = false;
	private windowGeneration = 0;
	private readonly savedPages: (SavedPageHandle & { older?: string; newer?: string })[] = [];
	/** Reads of the single saved entries next to the shown window; a new window or a closed view stops them. */
	private boundaryReads = new AbortController();
	readonly #notices = new TaskTranscriptNotices();
	private loading = false;
	private reloadPending = false;
	private loadingEarlier?: AdjacentRequest;
	private failedCursor?: string;
	private latestRead?: AbortController;
	/** A history-only transcript changed while the reader was away from its end; it is read again when they return. */
	private behind = false;
	/** A compaction retired the window while the reader was above its end: the next window keeps what they see. */
	private parkOnLoad = false;
	private disposed = false;
	private shownPromptSessionId?: string;
	private readonly unsubscribePrompts: () => void;

	private readonly reportLate: (reason: string) => void;
	private readonly echoedPrompt: string | undefined;
	private readonly showKeys: (() => void) | undefined;

	/**
	 * `reportLate` shows the reason a message failed after the reader left this transcript; `showKeys` opens the chat's
	 * keys, as `/hotkeys` does.
	 */
	constructor(
		source: TaskViewSource,
		taskId: TaskId,
		env: TaskTranscriptEnvironment,
		requestRender: () => void,
		reportLate: (reason: string) => void = (reason) => env.notify?.(reason),
		options: { readonly echoedPrompt?: string; readonly showKeys?: () => void } = {},
	) {
		this.source = source;
		this.elapsedClocks = taskClocksFor(source);
		this.taskId = taskId;
		this.env = env;
		this.requestRender = requestRender;
		this.reportLate = reportLate;
		this.echoedPrompt = options.echoedPrompt;
		this.showKeys = options.showKeys;
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
			savedTaskPages: true,
			liveRowOrigin: (seq) => {
				const session = this.followed ?? this.source.followTaskTranscript(this.taskId)?.session;
				return session === undefined ? undefined : liveTaskRowOrigin(session, taskId, seq);
			},
			echoedInitialPrompt: () => (this.cursor === undefined ? this.echoedPrompt : undefined),
			isStreaming: () => this.followed?.getStreamingMessage?.() !== undefined,
			// The inspector takes Esc for this chat: it cancels the retry the subagent waits on, unless a question holds it.
			canCancelRetry: () => !this.takesEscape() && this.interruptible(),
			workingTokenCount: () => source.tasks.find((task) => task.ref.taskId === taskId)?.metrics?.tokenCount,
			// A finished subagent's chat stays live, and a message resumes it; one stopped for good is read-only.
			isDisabled: () => source.sendTaskMessage === undefined || this.readOnlyReason() !== undefined,
			onNearTop: () => this.loadAdjacent("older"),
			onNearBottom: () => this.loadAdjacent("newer"),
			// A subagent's `/tasks` lists the tasks it launched.
			getTaskSource: () => launchedTaskViewSource(source, taskId),
			// The completion the subagent's chat offers, from its own cwd and skills.
			autocompleteProvider: createSessionSkillAutocompleteProvider(async () => {
				const commands = await source.taskCommands?.(taskId);
				return commands === undefined
					? undefined
					: { cwd: commands.cwd, skillCommands: getSkillCatalogCommands(commands.skillCommands) };
			}),
			// What the reader types goes to the subagent's own session as the main chat's goes to its own: queued in its
			// lane while it works, else its next turn, and the dequeue key takes the queue back.
			steering: this.steeringTarget(),
			// Esc paused it: the reader's next message continues it, as their send continues the main chat after Esc.
			isPaused: () => this.paused(),
			commands: { handleSlashCommand: (text) => this.runCommand(text) },
		});
		pagedNotices.set(this.chat, this.#notices);
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
		if (this.observedWrites?.pending && this.deferArchiveRead(this.source.followTaskTranscript(this.taskId))) return;
		this.loading = true;
		const controller = new AbortController();
		this.latestRead = controller;
		try {
			// A synchronous read subscribes in the same turn. A pending read never binds old rows to a replacement owner.
			const before = this.source.followTaskTranscript(this.taskId);
			const read = readTaskPageForChat(this, this.source, this.taskId, undefined, controller.signal);
			const page = read instanceof Promise ? await read : read;
			if (this.disposed) return;
			if (read instanceof Promise && before?.session !== this.source.followTaskTranscript(this.taskId)?.session) {
				this.reloadPending = true;
				return;
			}
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

	private deferArchiveRead(follow: ReturnType<TaskViewSource["followTaskTranscript"]>): boolean {
		const writes = this.observedWrites;
		if (
			!writes?.pending ||
			!follow?.historyOnly ||
			!this.followedSessionId ||
			follow.session?.getSessionId() !== this.followedSessionId
		)
			return false;
		if (this.followed) {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			this.followed = undefined;
			this.chat.resetFollowedSession({ preserveWorkedRun: true });
			this.chat.refreshTaskStore();
		}
		writes.onIdle = () => {
			if (!this.disposed) {
				observedTaskChatWrite(this);
				this.refresh();
			}
		};
		return true;
	}

	refresh(): void {
		if (this.disposed) return;
		const follow = this.source.followTaskTranscript(this.taskId);
		if (this.deferArchiveRead(follow)) return;
		if (follow?.session !== undefined && follow.session === this.followed) return;
		// Reading a history-only transcript again replaces what is shown, so it waits while the reader is above the end.
		if (follow?.historyOnly === true && (this.newerCursor !== undefined || this.chat.bodyScrollFromBottom() > 0)) {
			this.behind = true;
			return;
		}
		void this.load();
	}

	handleInput(data: string): boolean {
		const handled = this.route(data);
		if (this.behind && this.newerCursor === undefined && this.chat.bodyScrollFromBottom() === 0) {
			this.behind = false;
			void this.load();
		}
		return handled;
	}

	private route(data: string): boolean {
		if (data === TRANSCRIPT_JUMP_TO_END_URL) {
			if (this.newerCursor !== undefined || this.savedPages.length || this.loadingEarlier)
				this.goToLatestSavedPage();
			this.chat.scrollToBottom();
			this.requestRender();
			return true;
		}
		const keybindings = keybindingsOf(this.env.keybindings);
		if (
			this.failedCursor &&
			(parseWheelReport(data) ||
				matchesKey(data, "pageUp") ||
				matchesKey(data, "pageDown") ||
				keybindings.matches(data, "tui.altScreen.top") ||
				keybindings.matches(data, "tui.altScreen.bottom"))
		)
			this.failedCursor = undefined;
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
		// The host owns thinking display; only its default physical key leaves the composer.
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
		if (!this.chat.hasTaskInspector) {
			if (keybindings.matches(data, "tui.altScreen.top")) this.goToFirst = true;
			else if (
				parseWheelReport(data) ||
				matchesKey(data, "pageUp") ||
				matchesKey(data, "pageDown") ||
				keybindings.matches(data, "tui.altScreen.halfPageUp") ||
				keybindings.matches(data, "tui.altScreen.halfPageDown") ||
				keybindings.matches(data, "tui.altScreen.previousPrompt") ||
				keybindings.matches(data, "tui.altScreen.nextPrompt")
			)
				this.goToFirst = false;
		}
		if (
			!this.chat.hasTaskInspector &&
			(keybindings.matches(data, "tui.altScreen.top") ||
				keybindings.matches(data, "tui.altScreen.halfPageUp") ||
				keybindings.matches(data, "tui.altScreen.previousPrompt") ||
				matchesKey(data, "pageUp") ||
				parseWheelReport(data)?.direction === -1)
		) {
			this.olderIntent = true;
			this.travel = "older";
		} else if (
			!this.chat.hasTaskInspector &&
			(keybindings.matches(data, "tui.altScreen.halfPageDown") ||
				keybindings.matches(data, "tui.altScreen.nextPrompt") ||
				matchesKey(data, "pageDown") ||
				parseWheelReport(data)?.direction === 1)
		)
			this.travel = "newer";
		if (
			!this.chat.hasTaskInspector &&
			(this.newerCursor !== undefined || this.savedPages.length > 0 || this.loadingEarlier) &&
			keybindings.matches(data, "tui.altScreen.bottom")
		) {
			this.goToLatestSavedPage();
			return true;
		}
		// A read-only chat scrolls and keeps its keys, but takes no typing: nothing it sends could reach the task.
		if (!this.chat.hasTaskInspector && this.readOnlyReason() !== undefined && isTyping(data)) return true;
		// The subagent's own task list is modal while it is open.
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

	/** The chat box of a subagent's chat: the transcript, then pending, working, usage, the named editor and the footer. */
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
		const paused = this.paused();
		const state =
			task === undefined
				? undefined
				: waiting
					? "needs input"
					: task.execution.kind === "settled"
						? taskState(task) === "completed"
							? "done"
							: taskState(task)
						: paused
							? "paused"
							: task.metrics?.elapsedMs === undefined
								? "running"
								: formatPanelElapsed(
										taskElapsedMs(task, taskClockRunning(task.execution.kind), this.elapsedClocks) ??
											task.metrics.elapsedMs,
									);
		const released = task === undefined ? undefined : waitingReleasedTools(task);
		const stopped = !paused && released === undefined && this.source.taskStopped?.(this.taskId) === true;
		const label = [
			name,
			task?.title ? taskDisplayText(shortTaskTitle(task.title)) : "",
			stopped ? "stopped" : released !== undefined ? `waiting on ${taskDisplayText(released)}` : (state ?? ""),
		]
			.filter(Boolean)
			.join(" · ");

		const placeholder = paused
			? PAUSED_NOTE
			: stopped
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
		this.cancelAdjacent();
		this.latestRead?.abort();
		this.boundaryReads.abort();
		this.savedPages.length = 0;
		this.legacyWindow = undefined;
		if (this.observedWrites) this.observedWrites.onIdle = undefined;
		this.observedWrites = undefined;
		this.#notices.reset();
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

	/** Whether Esc paused the subagent: it waits, still running, for the reader's next message. */
	private paused(): boolean {
		const task = this.source.tasks.find((candidate) => candidate.ref.taskId === this.taskId);
		return task !== undefined && isTaskTurnInterrupted(task);
	}

	interruptible(): boolean {
		if (this.source.pauseTask === undefined && this.source.interruptTask === undefined) return false;
		const session = this.followed;
		const queued = session?.getQueuedMessages?.();
		// Between two attempts of a retry nothing streams, and Esc cancels the retry, as it does in the main chat. Queued
		// messages alone are enough too: Esc hands them back, as the main chat's Esc does.
		return (
			session?.isRunning?.() === true ||
			session?.chatSession?.isRetrying === true ||
			(queued !== undefined && queued.steering.length + queued.followUp.length > 0)
		);
	}

	async interrupt(): Promise<TaskViewResult<undefined>> {
		const pause = this.source.pauseTask;
		if (pause !== undefined) {
			const paused = await pause.call(this.source, this.taskId);
			if (!paused.ok) return paused;
			if (!this.disposed) this.restoreQueuedToEditor(paused.value);
			else {
				// The reader left while the turn ended: what came back waits in the prompt for their return.
				const taken = [...paused.value.steering, ...paused.value.followUp];
				const kept = keptDrafts.get(this.source) ?? new Map<TaskId, string>();
				if (taken.length > 0)
					kept.set(this.taskId, combineQueuedMessagesForEditor(taken, kept.get(this.taskId) ?? ""));
				keptDrafts.set(this.source, kept);
			}
			return { ok: true, value: undefined };
		}
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
		if (this.deferArchiveRead(follow)) return;
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
		const parked = this.parkOnLoad && !sessionChanged && session ? this.parkedRows(session) : undefined;
		const parking = this.parkOnLoad;
		this.parkOnLoad = false;
		if (parking && !parked && !sessionChanged && this.chat.bodyScrollFromBottom() > 0) {
			// A row the reader sees cannot be placed among the saved entries: keep the window until they return.
			this.behind = true;
			return;
		}
		if (sessionChanged) {
			if (this.observedWrites) {
				this.observedWrites.onIdle = undefined;
				this.observedWrites = undefined;
			}
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			this.followed = session;
			this.chat.resetFollowedSession({ preserveWorkedRun: sameConversation && session === undefined });
		}
		this.followedSessionId = nextSessionId;
		this.cancelAdjacent();
		this.windowGeneration++;
		this.savedPages.length = 0;
		this.boundaryReads.abort();
		this.boundaryReads = new AbortController();
		this.newerCursor = undefined;
		this.liveHistoryStart = undefined;
		this.cursor = page.value.nextCursor;
		this.legacyWindow = undefined;
		this.legacyWindowActive = false;
		this.chat.onUnplacedWidget?.(
			session &&
				!session.getEntrySeq &&
				!session.entryReceipt &&
				session.readHistory &&
				session.getEarlierCursor &&
				this.cursor &&
				!this.cursor.includes(":")
				? () => {
						this.legacyWindow = retainTaskWindowReader(session, this.taskId);
					}
				: undefined,
		);
		const messages = page.value.messages;
		if (page.value.savedWindow && !session) this.attachSavedPage(page.value, "latest", page);
		else
			withTaskChatRows(this.chat, page, () =>
				this.chat.replaceMessages(messages, {
					preserveUnread: !sessionChanged,
					parked,
					before: this.boundaryReader(this.cursor, true, this.boundaryReads.signal),
				}),
			);
		if (session && parked?.rows.length) {
			// The rows the reader sees of the retired window stay as the saved page they are on; reads continue past it.
			const around = taskCursorsAround(session, this.taskId, parked.first, parked.last);
			this.liveHistoryStart = this.cursor;
			this.savedPages.push({ ...this.chat.keptPage(parked.rows), ...around });
			this.cursor = around.older;
			this.newerCursor = around.newer;
		}
		this.#notices.adopt(page, messages, this.cursor !== undefined);
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
			if (event.type === "message_end") {
				// The receipt arrives with the end of the message the row was drawn from as it streamed.
				const sent = event as { seq?: unknown };
				const seq =
					session.entryReceipt?.(event.message)?.seq ?? (typeof sent.seq === "number" ? sent.seq : undefined);
				if (seq !== undefined) noteSavedSeq(event.message, seq);
			}
			const write = chatReceiptWrite(event);
			if (write) {
				this.observedWrites ??= new ObservedChatWrites();
				this.observedWrites.observe(write);
			}
			this.chat.applyTaskAgentEvent(event);
			if (event.type === "compaction_end" && event.result && !event.aborted && session.getEarlierCursor?.()) {
				// Only a source that can replay the previous context authorizes releasing those rows. Never clear
				// private SDK rows merely because they arrived before a new boundary.
				this.cancelAdjacent();
				this.windowGeneration++;
				if (!session.getEntrySeq && !session.entryReceipt && this.chat.hasUnplacedWidget()) {
					// With neither occurrence capability, only the original live transcript can place this stateful
					// widget. Keep that view, including its new boundary. Never guess by text or display it twice.
					this.legacyWindowActive = true;
					this.behind = false;
					this.parkOnLoad = false;
				} else if (this.chat.bodyScrollFromBottom() === 0 && this.newerCursor === undefined) void this.load();
				else if (session.getEntrySeq) {
					// A reader above the end keeps only the rows they see; the rest of the retired window is released.
					this.parkOnLoad = true;
					void this.load();
				} else this.behind = true;
			}
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
			const retry = chatSession.retryStatus;
			this.chat.hydrateRetryWait(
				messages,
				chatSession.turnStartedAt,
				retry?.type === "auto_retry_start" ? retry : undefined,
			);
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

	/** The rows the reader sees, at the window the followed session holds now. */
	private parkedRows(session: TaskTranscriptSource): ParkedTaskRows | undefined {
		let current = Number.POSITIVE_INFINITY;
		for (const entry of session.getEntries()) current = Math.min(current, session.getEntrySeq?.(entry.id) ?? current);
		return Number.isFinite(current) ? this.chat.parkedRows(current) : undefined;
	}

	private goToLatestSavedPage(): void {
		this.cancelAdjacent();
		this.windowGeneration++;
		this.newerCursor = undefined;
		this.behind = false;
		this.olderIntent = false;
		this.goToFirst = false;
		this.chat.scrollToBottom();
		if (this.followed) {
			for (const page of this.savedPages.splice(0)) page.discard();
			if (this.liveHistoryStart) this.cursor = this.liveHistoryStart;
			this.requestRender();
		} else void this.load();
	}

	/**
	 * Reads, one saved entry per step, the entries from `cursor` on: newest first with `calls` (replies reduced to their
	 * calls), else oldest first. Only saved transcripts read single entries.
	 */
	private boundaryReader(
		cursor: string | undefined,
		calls: boolean,
		signal: AbortSignal,
	): SavedPageNeighbours["before"] | undefined {
		if (cursor === undefined || !cursor.includes(":")) return undefined;
		const { source, taskId } = this;
		return () => {
			let next: string | undefined = cursor;
			return {
				async next() {
					if (next === undefined || signal.aborted) return { done: true, value: undefined };
					const page = await readTaskPageForView(source, taskId, savedBoundaryCursor(next, calls), signal);
					if (!page.ok) throw new Error(page.error.message);
					next = calls ? page.value.nextCursor : page.value.newerCursor;
					return { done: false, value: page.value.messages };
				},
			};
		};
	}

	private attachSavedPage(
		page: TaskTranscriptView,
		edge: "latest" | "older" | "newer",
		result?: TaskViewResult<TaskTranscriptView>,
	): void {
		const reads = new AbortController();
		const windowReads = this.boundaryReads.signal;
		const signal = AbortSignal.any([reads.signal, windowReads]);
		const neighbours: SavedPageNeighbours = {
			before: this.boundaryReader(page.nextCursor, true, signal),
			after: this.boundaryReader(page.newerCursor, false, signal),
		};
		let kept!: SavedPageHandle;
		const show = () => {
			kept = this.chat.showSavedPage(
				page.messages,
				edge,
				neighbours,
				edge === "newer" ? this.savedPages.at(-1)?.lastRow() : undefined,
			);
		};
		// The page's rows carry where its saved lines go.
		if (result) withTaskChatRows(this.chat, result, show);
		else show();
		const shown = {
			...kept,
			discard: () => {
				reads.abort();
				kept.discard();
			},
			older: page.nextCursor,
			newer: page.newerCursor,
		};
		if (edge === "older") this.savedPages.unshift(shown);
		else this.savedPages.push(shown);
		// Keep the viewport and an adjacent page. A tall screen can span more: never evict a painted row.
		while (this.savedPages.length > 2) {
			const far = edge === "older" ? this.savedPages.at(-1)! : this.savedPages[0]!;
			if (far.visible()) break;
			if (edge === "older") this.savedPages.pop();
			else this.savedPages.shift();
			far.discard();
		}
		this.cursor = this.savedPages[0]?.older;
		this.newerCursor = this.savedPages.at(-1)?.newer;
	}

	private cancelAdjacent(): void {
		this.loadingEarlier?.controller.abort();
		this.loadingEarlier = undefined;
		this.failedCursor = undefined;
	}
	private loadAdjacent(edge: "older" | "newer"): void {
		const cursor = edge === "older" ? this.cursor : this.newerCursor;
		if (!cursor || cursor === this.failedCursor || this.loadingEarlier || this.loading || this.disposed) return;
		if (edge === "older" && this.followed && cursor.includes(":") && !this.olderIntent) return;
		// Saved pages on both sides of a live reader (pages kept through a compaction): read on the way they scroll.
		if (this.followed && this.savedPages.length > 0 && this.travel !== edge) return;
		const src = this.source.followTaskTranscript(this.taskId)?.session;
		const request: AdjacentRequest = {
			edge,
			cursor,
			generation: this.windowGeneration,
			controller: new AbortController(),
			source: src && new WeakRef(src),
		};
		this.loadingEarlier = request;
		try {
			deliverAdjacent(
				new WeakRef(this),
				request,
				this.legacyWindowActive && this.legacyWindow && !cursor.includes(":")
					? this.legacyWindow(cursor)
					: readTaskPageForChat(this, this.source, this.taskId, cursor, request.controller.signal),
			);
		} catch (error) {
			this[finishAdjacent](request, { ok: false, error: { message: failureText(error) } });
		}
	}
	[finishAdjacent](request: AdjacentRequest, page: TaskViewResult<TaskTranscriptView>): void {
		const { edge, cursor } = request;
		if (this.disposed || this.loadingEarlier !== request) return;
		this.loadingEarlier = undefined;
		if (
			request.generation !== this.windowGeneration ||
			cursor !== (edge === "older" ? this.cursor : this.newerCursor) ||
			request.source?.deref() !== this.source.followTaskTranscript(this.taskId)?.session
		)
			return;
		try {
			if (!page.ok) {
				this.failedCursor = cursor;
				this.status = page.error.message;
				return;
			}
			if (page.value.savedWindow && (this.savedPages.length || this.followed)) {
				if (this.followed && this.liveHistoryStart === undefined) this.liveHistoryStart = cursor;
				if (edge === "older") this.#notices.adopt(page, page.value.messages, page.value.nextCursor !== undefined);
				this.attachSavedPage(page.value, edge, page);
				if (edge === "older" && this.goToFirst) this.chat.scrollBodyTo(0);
			} else {
				this.cursor = page.value.nextCursor;
				this.#notices.adopt(page, page.value.messages, this.cursor !== undefined);
				withTaskChatRows(this.chat, page, () => this.chat.prependMessages(page.value.messages));
			}
			this.status = "";
		} catch (error) {
			this.failedCursor = cursor;
			this.status = failureText(error);
		} finally {
			if (!this.cursor) this.#notices.finishPaging();
			this.requestRender();
		}
	}

	/** The subagent as its chat steers it: messages go to its own session, and its queue comes back from it. */
	private steeringTarget(): ChatSteeringTarget {
		return {
			prompt: (text, options) => this.send(text, options?.streamingBehavior ?? "steer"),
			resume: async (text, lane) => {
				const resume = this.source.resumeTask;
				if (resume !== undefined) {
					const resumed = await resume.call(this.source, this.taskId);
					if (!resumed.ok) throw new Error(resumed.error.message);
				}
				await this.send(text, lane === "followUp" ? "followUp" : "steer");
			},
			clearQueue: async () => {
				const taken = await this.takeQueue();
				return { steering: [...taken.steering], followUp: [...taken.followUp] };
			},
		};
	}

	/** Resolves once the subagent's session accepted `text`, waiting on `lane` while it works. */
	private async send(text: string, lane: TaskMessageLane): Promise<void> {
		const send = this.source.sendTaskMessage;
		if (send === undefined) throw new TaskMessageError("messages-unsupported", { taskId: this.taskId });
		try {
			await send.call(this.source, this.taskId, text, lane);
		} catch (error) {
			if (!this.disposed) throw error;
			this.keepUndelivered(text, failureText(error));
		}
	}

	/** Every message waiting in the subagent's queue, taken back in its own answer. */
	private async takeQueue(): Promise<QueuedTaskMessages> {
		const clear = this.source.clearTaskQueue;
		if (clear === undefined) return { steering: [], followUp: [] };
		const taken = await clear.call(this.source, this.taskId);
		if (!taken.ok) throw new Error(taken.error.message);
		return taken.value;
	}

	restoreQueuedToEditor(taken: QueuedTaskMessages): number {
		return this.chat.restoreTakenQueuedMessages(taken);
	}

	clearDraft(): boolean {
		if (this.chat.hasTaskInspector || this.heldPrompt() !== undefined || !this.chat.hasInputText()) return false;
		this.chat.setInputText("");
		this.requestRender();
		return true;
	}

	/**
	 * A slash command typed into the chat: `/tasks`, `/copy` and `/hotkeys` run here at once; a built-in that belongs to
	 * the main chat is refused with a notice; anything else goes to the subagent, whose session runs its own commands
	 * and expands its skills and prompt templates. Answers whether the chat handled it.
	 */
	private runCommand(text: string): boolean {
		if (classifyChatCommand(text) === "tasks") return this.chat.openTasks(text.split(/\s+/)[1]);
		const command = subagentChatCommand(text);
		if (command.kind === "agent") return false;
		if (command.kind === "unavailable") {
			this.chat.showWarning(subagentChatUnavailableNotice(command.name));
			return true;
		}
		if (command.name === "copy") void this.copyLastMessage();
		else if (command.name === "hotkeys") this.showKeys?.();
		else this.chat.openTasks();
		return true;
	}

	private async copyLastMessage(): Promise<void> {
		const text = this.chat.lastAgentMessageText();
		if (!text) {
			this.chat.showWarning("No agent messages to copy yet.");
			return;
		}
		try {
			await copyToClipboard(text);
			if (!this.disposed) this.chat.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			if (!this.disposed) this.chat.showWarning(failureText(error));
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
