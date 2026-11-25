import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	getKeybindings,
	Input,
	isHintActivation,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import {
	type AgentPanelAnswerOptions,
	panelItemStableKey,
	promptAnswerOptionsOf,
} from "../../../core/tasks/agent-panel-source.ts";
import {
	latestSubagentAttempt,
	supersededSettledAttempts,
	waitingReleasedShells,
	waitingReleasedTools,
} from "../../../core/tasks/completion.js";
import type { PromptRoute, TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import {
	bindTaskClock,
	type TaskElapsedClocks,
	taskClockOf,
	taskClockRunning,
	taskClocksFor,
	taskElapsedMs,
} from "../../../core/tasks/live-elapsed.js";
import { isTaskTurnInterrupted, OwnerTaskStore } from "../../../core/tasks/owner-store.js";
import {
	ownerTaskViewSource,
	readTaskDetailForView,
	type TaskViewSource,
} from "../../../core/tasks/task-view-source.js";
import { theme } from "../theme/theme.js";
import { AGENT_PANEL_MODEL_MIN_WIDTH, formatPanelElapsed } from "./agent-panel.ts";
import { parseWheelReport } from "./chat-transcript.js";
import { renderExtensionStatusRow } from "./footer.ts";
import { ModelColumn } from "./model-column.ts";
import {
	clickableKeyTextHint,
	isNavHelpKey,
	NAV_CONFIRM_WINDOW_MS,
	type NavKey,
	type NavKeybindings,
	type NavKeyStyle,
	navActionText,
	navKeyText,
	renderNavHintLine,
	renderNavKeyOverlay,
} from "./nav-keys.ts";
import { wrapNotes } from "./note-rows.ts";
import {
	formatShellViewerNote,
	shellScrollRange,
	shellViewerBoxGeometry,
	stepShellStopConfirm,
} from "./shell-viewer-layout.js";
import { isSingleLeftClick } from "./single-click.ts";
import {
	type BoardRowModel,
	boardModelFits,
	NO_MODEL,
	type PeekContent,
	renderBoardRow,
	renderPeekCard,
	rowFinished,
	rowMatches,
	rowModel,
	rowModelReport,
	rowName,
	rowState,
	rowTask,
	type TaskBoardItem,
	type TaskBoardRow,
	taskBoardCounts,
	taskBoardGroups,
} from "./task-board.ts";
import {
	TaskDetail,
	type TaskDetailContent,
	taskDetailActions,
	taskDetailLabels,
	taskDetailSummary,
} from "./task-detail.js";
import { dismissedTasks } from "./task-dismissal.ts";
import { type TaskListSection, taskListSections } from "./task-list.js";
import { TaskNavigation } from "./task-navigation.js";
import { taskDisplayText, taskLabel, taskMetricsText, taskModelText, taskStatusAppearance } from "./task-row.js";
import {
	type InspectorCloseReason,
	keepSpanInView,
	type ListEntry,
	type ListSelectionAnchor,
	type ListSelectionPhase,
	taskStableKey,
} from "./task-selection-state.js";
import {
	TaskAgentTranscriptPage,
	TaskCommandOutputPage,
	type TaskTranscriptEnvironment,
	type TaskTranscriptPage,
} from "./task-transcript-page.ts";
import { formatToolActionSummary } from "./tool-block-summary.ts";
import { repaintAfterSingleClick } from "./transcript-block-clicks.ts";

const DETAIL_WHEEL_ROWS = 4;

function isNonWheelMouseReport(data: string): boolean {
	return parseWheelReport(data) === undefined && (/^\x1b\[<\d+;\d+;\d+[mM]$/.test(data) || data.startsWith("\x1b[M"));
}

function samePromptChoices(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}

function samePromptOptions(a: AgentPanelAnswerOptions, b: AgentPanelAnswerOptions): boolean {
	return a.promptId === b.promptId && a.question === b.question && samePromptChoices(a.choices, b.choices);
}

function taskReplyPrompt(task: TaskRecord): AgentPanelAnswerOptions {
	return task.attention.kind === "input-needed"
		? { promptId: task.attention.requestId, question: task.attention.prompt }
		: { question: task.title || taskLabel(task) };
}

function toolCallHeader(action: { readonly tool: string; readonly text: string }): string {
	try {
		return formatToolActionSummary(action);
	} catch {
		return `${taskDisplayText(action.tool)}(…)`;
	}
}

/** Theme colors of a hint line and the `?` key overlay. */
export function themedNavKeyStyle() {
	return {
		dim: (text: string) => theme.fg("dim", text),
		text: (text: string) => theme.fg("text", text),
		muted: (text: string) => theme.fg("muted", text),
		border: (text: string) => theme.fg("borderMuted", text),
		bold: (text: string) => theme.bold(text),
	};
}

/** `esc/←`: Esc and the back key, which both leave the list or a detail page. */
function escAndBack(): string {
	const back = navActionText(getKeybindings(), "app.nav.back");
	return back ? `esc/${back}` : "esc";
}
function listKeys(): NavKey[] {
	return [
		// First, so a narrow hint keeps it: a waiting subagent's shell is what its row is waiting on.
		{ action: "app.tasks.openWaited", label: "shell" },
		{ keys: "↑↓", label: "select" },
		{ action: "app.list.peek", label: "peek" },
		{ action: "app.list.open", label: "open" },
		{ action: "app.list.stop", label: "stop" },
		{ action: "app.list.filter", label: "filter" },
		{ keys: escAndBack(), label: "close" },
		{ action: "app.keys.help", label: "keys" },
	];
}

export const REPLY_ENTER_GUARD_MS = 300;

export type TaskBoardSource = {
	items(): readonly TaskBoardItem[];
	subscribe(listener: () => void): () => void;
	open?:
		| ((id: string, options?: { readonly onReturn?: () => void }) => boolean)
		| ((id: string, options?: { readonly onReturn?: () => void }) => void);
	stop?(id: string): Promise<{ ok: true } | { ok: false; reason: string }>;
	answer?(
		id: string,
		text: string,
		options?: AgentPanelAnswerOptions,
	): Promise<{ ok: true } | { ok: false; reason: string }>;

	dismiss?(id: string): void;
};
function detailKeys(): NavKey[] {
	return [
		{ keys: "↑↓", label: "actions" },
		{ action: "app.list.open", label: "select" },
		{ action: "app.list.stop", label: "stop" },
		{ keys: "pgup/pgdn", label: "scroll" },
		{ keys: escAndBack(), label: "back to list" },
		{ action: "app.keys.help", label: "keys" },
	];
}
/** What Esc does to the running turn of a task, from the task's chat. */
export type TaskChatEscAction = "interrupt" | "pause";
/** What Esc does to a running task from its chat: it pauses it (the main chat's Esc interrupts); the hint and the `?` overlay name it. */
const TASK_CHAT_ESC_ACTION: TaskChatEscAction = "pause";

/** A task's chat: ← goes back one level, Esc only acts on the turn, named in the main chat's words (`esc to …`). */
export function taskChatKeys(
	back: string,
	interruptible: boolean,
	hasTasks = false,
	expandable = true,
	escAction: TaskChatEscAction = TASK_CHAT_ESC_ACTION,
): NavKey[] {
	return [
		{ action: "app.nav.back", label: back },
		...(hasTasks ? [{ action: "app.agents.focus", label: "agents" }] : []),
		...(interruptible ? [{ keys: "esc", label: `to ${escAction}` }] : []),
		{ keys: "pgup/pgdn", label: "scroll" },
		...(expandable ? [{ action: "app.tools.expand", label: "expand" }] : []),
		{ action: "app.keys.help", label: "keys" },
	];
}
export const TASK_CHAT_OVERLAY_KEYS: readonly NavKey[] = [
	{ keys: "enter", label: "send the prompt to the agent" },
	{ action: "app.nav.back", label: "back, on an empty prompt" },
	{ keys: "esc", label: `${TASK_CHAT_ESC_ACTION} the agent's turn` },
	{ keys: "pgup/pgdn", label: "scroll" },
	{ action: "tui.altScreen.top", label: "jump to the top" },
	{ action: "tui.altScreen.bottom", label: "jump to the latest message" },
	{ action: "app.tools.expand", label: "expand tool output" },
	{ action: "app.thinking.toggle", label: "show or hide thinking" },
	{ action: "app.agents.chord", label: "then the stop-all key: stop all background work" },
];

export const SHELL_VIEWER_OVERLAY_KEYS: readonly NavKey[] = [
	{ action: "app.nav.back", label: "back" },
	{ keys: "pgup/pgdn", label: "scroll" },
	{ action: "tui.altScreen.top", label: "jump to the top" },
	{ action: "tui.altScreen.bottom", label: "jump to the bottom" },
	{ action: "app.list.stop", label: "stop the shell" },
	{ action: "app.agents.chord", label: "then the stop-all key: stop all background work" },
];

const SHELL_META_LABEL_WIDTH = 10;

function formatShellMetaRows(
	label: string,
	value: string,
	maxLines: number,
	contentWidth: number,
	lead: string,
	styleValue: (text: string) => string = (text) => text,
): string[] {
	const valueWidth = Math.max(1, contentWidth - SHELL_META_LABEL_WIDTH);
	const paddedLabel = theme.bold(`${label}:`.padEnd(SHELL_META_LABEL_WIDTH));
	const continuation = " ".repeat(SHELL_META_LABEL_WIDTH);
	const wrapped = wrapTextWithAnsi(value, valueWidth);
	const lines = wrapped.length > 0 ? wrapped : [""];
	const clipped =
		lines.length > maxLines
			? [...lines.slice(0, maxLines - 1), truncateToWidth(`${lines[maxLines - 1]!}…`, valueWidth, "…")]
			: lines;
	return clipped.map((line, index) => `${lead}${index === 0 ? paddedLabel : continuation}${styleValue(line)}`);
}

/** The host owns thinking display; only its default physical key, as a remap may reuse an editor key. */
function isHostThinkingToggle(data: string): boolean {
	return matchesKey(data, "ctrl+t") && getKeybindings().matches(data, "app.thinking.toggle");
}

/** Focused view only. The task source and original session remain the authorities. */
export class TaskInspector implements Component {
	readonly navigation: TaskNavigation;
	private actionIndex = 0;
	/** The `?` overlay of the current page is open. */
	private helpOpen = false;
	/** Where ← from an open task chat goes: the list, the task's detail page, or out to whatever opened the inspector. */
	private chatFrom: "list" | "detail" | "caller" = "detail";
	/**
	 * The shell whose output is open because a waiting subagent's key opened it, and the view the back key returns to
	 * as it was left: the subagent's chat (kept, not closed, so its scroll, draft and cursor stay), the list with its
	 * peek, or the detail page with its scroll and chosen action.
	 */
	private waitedShell:
		| {
				readonly taskId: TaskId;
				readonly returnTo: "chat" | "list" | "detail";
				readonly suspended: TaskTranscriptPage | undefined;
				readonly scroll: number;
				readonly actionIndex: number;
		  }
		| undefined;

	closedByBack = false;
	/** Why this inspector closed: navigation keeps its return anchor; dismissal clears it. */
	closeReason: InspectorCloseReason = "dismissed";
	/** Return anchor captured when leaving `/tasks` to view a subagent or extension item. */
	returnAnchor?: ListSelectionAnchor;
	/** Stable key of the row the reader last opened here, by Enter or a click. */
	chosenKey?: string;
	/** Typed state machine for list selection & viewport scroll across away/return transitions. */
	private selectionPhase: ListSelectionPhase = { kind: "browsing", scroll: 0 };
	/** What ← from a chat opened by the caller names, such as `main chat`. */
	private callerLabel = "back";
	/** Typed shell input per task, kept when the reader leaves the input and restored when they return. */
	private readonly inputDrafts = new Map<TaskId, string>();
	private inputTask?: TaskRecord;
	/** The open transcript of the selected task, on the shared chat stack. */
	private transcript?: TaskTranscriptPage;
	/** The frame row the open transcript started on in the last `renderViewport`, while one was drawn. */
	private transcriptTop: number | undefined;
	/** What the last board frame drew on each rendered row, for single-click opening and stale-click guards. */
	private paintedBoard?: {
		readonly rowsByLine: readonly (string | undefined)[];
		readonly rowsById: ReadonlyMap<string, TaskBoardRow>;
	};
	private status = "";
	/** A failure shown once on the task pages, until the next key. */
	private failureNotice = "";
	private scroll = 0;
	private detailContent: Omit<TaskDetailContent, "stdinAvailable"> = {};
	private detailTaskId?: TaskId;
	private detailGeneration = 0;
	private detailRead?: AbortController;
	private disposed = false;
	private statusWatch?: { taskId: TaskId; release: () => void };
	private readonly input = new Input();

	private peekId?: string;
	private readonly reply = new Input();
	private drawnChoices?: readonly string[];

	private filter = "";
	private filtering = false;
	private readonly filterInput = new Input();

	private boardSource?: TaskBoardSource;
	private releaseBoardSource?: () => void;

	private readonly dismissedItems = new Set<string>();

	private readonly replyDrafts = new Map<string, string>();
	private readonly paintedPrompts = new Map<string, AgentPanelAnswerOptions>();
	private readonly replyTargets = new Map<string, AgentPanelAnswerOptions>();
	private readonly pickedChoices = new Map<
		string,
		{ readonly text: string; readonly raw: string; readonly index: number }
	>();
	private readonly paintedItemFinished = new Map<string, boolean>();

	private sending = false;

	private sentAt = Number.NEGATIVE_INFINITY;

	private itemFinishedWhileArmed?: { readonly id: string; readonly name: string };
	private itemFinishedAcknowledged = false;

	private reopen?: (id: string, anchor?: ListSelectionAnchor) => void;
	private agentView?: (taskId: TaskId) => void;

	private selectionChosen = false;
	private rowsById = new Map<string, TaskBoardRow>();
	private taskSections?: TaskListSection[];
	private sortedSections?: TaskListSection[];
	private sortedKey?: { revision: number; settled: number };
	private tasksById = new Map<TaskId, TaskRecord>();
	private readonly taskRowById = new Map<TaskId, Extract<TaskBoardRow, { kind: "task" }>>();
	private cachedNativeRows?: {
		readonly sections: TaskListSection[];
		readonly rows: Extract<TaskBoardRow, { kind: "task" }>[];
	};
	private lastBoardGroups?: {
		readonly rows: TaskBoardRow[];
		readonly groups: ReturnType<typeof taskBoardGroups>;
	};
	private preparedBoard?: {
		readonly all: TaskBoardRow[];
		readonly rows: TaskBoardRow[];
		readonly groups: ReturnType<typeof taskBoardGroups>;
	};
	private readonly elapsedClocks: TaskElapsedClocks;
	/** The board's model column: which rows show their model yet, and how wide it stays while the board is open. */
	private readonly modelColumn = new ModelColumn(() => this.requestRender());
	private boardStale = false;
	private navigationOrder: string[] = [];
	private navigationEntries: ListEntry[] = [];
	private boardBudget = 24;
	private readonly unsubscribe: () => void;
	private readonly transcriptEnvironment: () => TaskTranscriptEnvironment | undefined;
	constructor(
		privateStore: OwnerTaskStore | TaskViewSource,
		privateRender: () => void,
		privateClose: () => void,
		openQuestion?: (route: PromptRoute) => void,
		transcriptEnvironment: () => TaskTranscriptEnvironment | undefined = () => undefined,
	) {
		this.store = privateStore instanceof OwnerTaskStore ? ownerTaskViewSource(privateStore) : privateStore;
		this.elapsedClocks = taskClocksFor(this.store);
		this.requestRender = privateRender;
		this.close = privateClose;
		this.transcriptEnvironment = transcriptEnvironment;
		this.navigation = new TaskNavigation(getKeybindings() as KeybindingsManager, {
			inspect: (task) => {
				this.enterAwayView(task);
				this.closeTranscript();
				this.actionIndex = 0;
				this.scroll = 0;
				void this.loadDetail();
			},
			openChat: (task) => {
				if (this.showAgent(task)) return;
				this.enterAwayView(task);
				this.chatFrom = "list";
				this.detailGeneration++;
				this.openTranscript();
				// A task with no chat here (no transcript in this host) stays on its detail page.
				if (this.transcript === undefined) void this.loadDetail();
			},
			transcript: (task) => {
				if (this.showAgent(task)) return;
				this.enterAwayView(task);
				this.chatFrom = "detail";
				this.detailGeneration++;
				this.openTranscript();
			},
			armStop: () => {
				this.requestRender();
				// The waiting notice leaves when its window closes, not on the next key.
				const timer = setTimeout(() => this.requestRender(), NAV_CONFIRM_WINDOW_MS + 50);
				timer.unref?.();
			},
			dismiss: (task) => {
				dismissedTasks(this.store).add(task.ref.taskId);
				this.boardSource?.dismiss?.(`task:${task.ref.taskId}`);
				if (this.navigation.focus.kind === "detail") this.returnToList();
				else this.refreshOrder();
				this.requestRender();
			},
			cancel: (task) => {
				const environment = this.transcriptEnvironment();
				void this.store
					.cancelTask(task.ref.taskId)
					.then((result) => {
						if (result.ok) {
							this.failureNotice = "";
							this.requestRender();
						} else {
							this.reportLate(`Could not stop the task: ${taskDisplayText(result.error.message)}`, environment);
						}
					})
					.catch((error) => {
						const message = error instanceof Error ? error.message : String(error);
						this.reportLate(`Could not stop the task: ${taskDisplayText(message)}`, environment);
					});
			},
			stdinAvailable: (task) => this.store.stdinAvailable(task.ref.taskId),
			input: (task) => {
				this.enterAwayView(task);
				this.inputTask = task;
				this.input.setValue(this.inputDrafts.get(task.ref.taskId) ?? "");
			},
			openQuestion: (route) => {
				if (openQuestion) {
					this.close();
					openQuestion(route);
					return;
				}
				const asking = this.selected();
				if (asking !== undefined && this.showAgent(asking)) return;
				this.enterAwayView(asking);
				this.chatFrom = "detail";
				this.detailGeneration++;
				this.openTranscript();
			},
			currentTask: (taskId) => {
				if (!this.boardStale) return this.tasksById.get(taskId);
				return this.store.taskRecord &&
					Object.getOwnPropertyDescriptor(this.store, "panelRevision")?.get !== undefined
					? this.store.taskRecord(taskId)
					: this.store.backgroundTasks.find((task) => task.ref.taskId === taskId);
			},
		});
		this.unsubscribe = this.store.subscribe(() => {
			this.taskSections = undefined;
			this.preparedBoard = undefined;
			this.boardStale = true;
			if (this.navigation.focus.kind === "tasks") {
				if (this.navigation.selectedId === undefined || this.navigationOrder.length === 0) {
					this.refreshOrder();
					this.preparedBoard = undefined;
				}
			} else {
				const dismissed = dismissedTasks(this.store);
				const tasks = this.store.backgroundTasks.filter((task) => !dismissed.has(task.ref.taskId));
				// Keep the away anchor intact while a detail/transcript/waited-shell/stdin view is open;
				// do not resolve selection against a stale `navigationOrder`.
				this.navigation.updateTasksWhileAway(tasks);
				// An open subagent page follows its subagent: once resumed, it is about the attempt that runs now.
				const selected = this.navigation.selectedTaskId;
				const latest = selected === undefined ? undefined : latestSubagentAttempt(tasks, selected);
				if (this.navigation.focus.kind === "detail" && latest !== undefined && latest.ref.taskId !== selected)
					this.navigation.selectedTaskId = latest.ref.taskId;
			}
			if (this.transcript instanceof TaskCommandOutputPage) {
				const pending = this.navigation.stopConfirm.pending();
				if (pending !== undefined) {
					const target =
						this.store.tasks.find((candidate) => candidate.ref.taskId === pending) ??
						this.waitedShellRecord(pending as TaskId);
					if (target === undefined || target.execution.kind === "cancelling") {
						this.navigation.stopConfirm.reset();
					} else if (target.execution.kind === "settled") {
						this.navigation.stopConfirm.reset();
						this.navigation.finishedWhileArmed = target;
						this.navigation.finishedAcknowledged = false;
					}
				}
			}
			if (this.transcript) this.transcript.refresh();
			else if (this.navigation.focus.kind === "detail") void this.loadDetail();
			this.requestRender();
		});
		this.refreshOrder();
		this.preparedBoard = undefined;
		this.navigation.open();
		this.input.onSubmit = (text) => {
			void this.sendInput(text);
		};
	}
	private readonly store: TaskViewSource;
	private readonly requestRender: () => void;
	private readonly close: () => void;
	private rowEntry(row: TaskBoardRow): ListEntry {
		return {
			id: row.id,
			key: row.kind === "task" ? taskStableKey(row.task) : panelItemStableKey(row.item),
		};
	}
	private currentBoardScroll(): number {
		return this.selectionPhase.kind === "browsing" ? this.selectionPhase.scroll : this.selectionPhase.anchor.scroll;
	}
	private captureListAnchor(overrideId?: string, overrideTask?: TaskRecord): ListSelectionAnchor | undefined {
		if (overrideId === undefined && this.selectionPhase.kind === "away") return this.selectionPhase.anchor;
		const selectedId = overrideId ?? this.navigation.selectedId;
		if (selectedId === undefined) return undefined;
		let selectedKey: string | undefined;
		if (overrideTask !== undefined) {
			selectedKey = taskStableKey(overrideTask);
		} else {
			const entry = this.navigationEntries.find((candidate) => candidate.id === selectedId);
			selectedKey =
				entry?.key ?? (overrideId === undefined ? this.navigation.currentStableKey : undefined) ?? selectedId;
		}
		return {
			selectedKey,
			orderKeys: this.navigationEntries.map((entry) => entry.key),
			scroll: this.currentBoardScroll(),
		};
	}
	private enterAwayView(task?: TaskRecord): void {
		if (task !== undefined) this.chosenKey = taskStableKey(task);
		if (this.selectionPhase.kind === "away") return;
		const anchor = this.captureListAnchor(task?.ref.taskId, task);
		if (anchor !== undefined) this.selectionPhase = { kind: "away", anchor };
	}
	private returnToList(): void {
		const anchor = this.selectionPhase.kind === "away" ? this.selectionPhase.anchor : undefined;
		this.selectionPhase = { kind: "browsing", scroll: anchor?.scroll ?? this.currentBoardScroll() };
		this.navigation.focus = { kind: "tasks" };
		if (anchor !== undefined) this.refreshOrder(undefined, anchor);
		else if (this.boardStale) this.refreshOrder();
	}
	open(id?: TaskId): void {
		if (this.boardStale) this.refreshOrder();
		if (id !== undefined) this.selectionChosen = true;
		this.selectionPhase = { kind: "browsing", scroll: 0 };
		this.navigation.open(id === undefined ? undefined : this.listedAttempt(id));
	}
	/**
	 * Restore list selection and scroll position from an anchor captured before leaving `/tasks`:
	 * exact id -> resumed child attempt -> nearest surviving neighbour -> head.
	 */
	restoreAnchor(anchor: ListSelectionAnchor): void {
		this.selectionChosen = true;
		this.selectionPhase = { kind: "browsing", scroll: anchor.scroll };
		this.refreshOrder(undefined, anchor);
		this.navigation.focus = { kind: "tasks" };
	}
	/**
	 * The listed row of task `id`: a subagent is one row, its latest attempt, so an attempt a resume continued (as a
	 * completion notice names it) opens that row.
	 */
	private listedAttempt(id: TaskId): TaskId {
		return latestSubagentAttempt(this.store.backgroundTasks, id)?.ref.taskId ?? id;
	}
	/**
	 * Opens a task's page directly, as Enter on a subagent's shell row in the agent panel opens that shell's output: ←
	 * closes the inspector, one level back to `backLabel`, instead of showing the task's list or detail page.
	 */
	openChat(requested: TaskId, backLabel = "main chat"): void {
		if (this.boardStale) this.refreshOrder();
		this.selectionChosen = true;
		const id = this.listedAttempt(requested);
		this.navigation.open(id);
		if (this.navigation.selectedTaskId !== id) return;
		this.chatFrom = "caller";
		this.callerLabel = backLabel;
		this.navigation.focus = { kind: "detail" };
		this.openTranscript();
	}

	setBoardSource(source: TaskBoardSource | undefined): () => void {
		this.releaseBoardSource?.();
		this.boardSource = source;
		this.paintedPrompts.clear();
		this.replyTargets.clear();
		this.pickedChoices.clear();
		this.paintedItemFinished.clear();
		this.preparedBoard = undefined;
		this.releaseBoardSource = source?.subscribe(() => {
			this.preparedBoard = undefined;
			this.boardStale = true;
			this.requestRender();
		});
		const rows = this.boardRows();
		this.refreshOrder(rows);
		this.preparedBoard = undefined;

		const first = rows[0];
		if (!this.selectionChosen && first !== undefined) this.navigation.select(first.id);
		this.requestRender();
		return () => {
			if (this.boardSource !== source) return;
			this.releaseBoardSource?.();
			this.releaseBoardSource = undefined;
			this.boardSource = undefined;
			this.paintedPrompts.clear();
			this.replyTargets.clear();
			this.pickedChoices.clear();
			this.paintedItemFinished.clear();
			this.preparedBoard = undefined;
			this.refreshOrder();
			this.preparedBoard = undefined;
		};
	}

	private allRows(): TaskBoardRow[] {
		const sections = this.orderedSections();
		if (this.cachedNativeRows?.sections !== sections) {
			const rows: Extract<TaskBoardRow, { kind: "task" }>[] = [];
			// A subagent is one row, its latest attempt: one that a resume or wake continued is not listed next to it.
			// Read over the sections before dismissal, so dismissing that row does not bring back the attempt it continued.
			const superseded = supersededSettledAttempts(
				(this.taskSections ?? sections).flatMap((section) => section.tasks),
			);
			for (const section of sections) {
				for (const task of section.tasks) {
					if (superseded.size > 0 && superseded.has(task.ref.taskId)) continue;
					const id = task.ref.taskId;
					let row = this.taskRowById.get(id);
					if (row === undefined || row.task !== task) {
						row = { id, kind: "task", task };
						this.taskRowById.set(id, row);
					}
					rows.push(row);
				}
			}
			for (const id of this.taskRowById.keys()) if (!this.tasksById.has(id)) this.taskRowById.delete(id);
			this.cachedNativeRows = { sections, rows };
		}
		const tasks = this.cachedNativeRows.rows;
		const sourceItems = this.boardSource?.items() ?? [];
		if (sourceItems.length === 0) return tasks;
		const items: TaskBoardRow[] = [];
		for (const item of sourceItems) {
			if (item.kind !== "agent" && item.kind !== "shell") continue;
			const row: TaskBoardRow = { id: item.id, kind: "item", item };
			if (!rowFinished(row)) this.dismissedItems.delete(item.id);
			if (!this.dismissedItems.has(item.id)) items.push(row);
		}
		return tasks.length === 0 ? items : [...tasks, ...items];
	}

	private boardRows(all = this.allRows()): TaskBoardRow[] {
		const filtered = this.filter.trim() === "" ? all : all.filter((row) => rowMatches(row, this.filter));
		const groups = taskBoardGroups(filtered);
		const rows = groups.flatMap((group) => group.rows);
		this.lastBoardGroups = { rows, groups };
		this.rowsById = new Map(rows.map((row) => [row.id, row]));
		return rows;
	}
	private refreshOrder(rows?: TaskBoardRow[], anchor?: ListSelectionAnchor): void {
		let all: TaskBoardRow[] | undefined;
		let computedRows = rows;
		if (computedRows === undefined) {
			all = this.allRows();
			computedRows = this.boardRows(all);
		}
		const finalRows = computedRows;
		if (all !== undefined && this.lastBoardGroups?.rows === finalRows) {
			this.preparedBoard = { all, rows: finalRows, groups: this.lastBoardGroups.groups };
		} else {
			this.preparedBoard = undefined;
		}
		this.boardStale = false;
		const sections = this.orderedSections();
		const tasks =
			this.cachedNativeRows?.sections === sections
				? this.cachedNativeRows.rows.map((row) => row.task)
				: sections.flatMap((section) => section.tasks);
		this.navigationEntries = finalRows.map((row) => this.rowEntry(row));
		this.navigationOrder = this.navigationEntries.map((entry) => entry.id);
		if (anchor !== undefined) this.navigation.resolveFromAnchor(tasks, this.navigationEntries, anchor);
		else this.navigation.update(tasks, this.navigationEntries);
		if (this.peekId !== undefined && !finalRows.some((row) => row.id === this.peekId)) this.closePeek();

		const armed = this.navigation.stopConfirm.pending();
		const finished = finalRows.find((row) => row.kind === "item" && row.id === armed && rowFinished(row));
		if (finished !== undefined) {
			this.navigation.stopConfirm.reset();
			this.itemFinishedWhileArmed = { id: finished.id, name: rowName(finished) };
			this.itemFinishedAcknowledged = false;
		} else if (
			this.itemFinishedWhileArmed !== undefined &&
			!finalRows.some((row) => row.id === this.itemFinishedWhileArmed?.id && rowFinished(row))
		) {
			this.itemFinishedWhileArmed = undefined;
			this.itemFinishedAcknowledged = false;
		}
		if (
			this.navigation.finishedWhileArmed !== undefined &&
			!tasks.some(
				(task) =>
					task.ref.taskId === this.navigation.finishedWhileArmed?.ref.taskId && task.execution.kind === "settled",
			)
		) {
			this.navigation.finishedWhileArmed = undefined;
			this.navigation.finishedAcknowledged = false;
		}
	}
	private selectedRow(): TaskBoardRow | undefined {
		const id = this.navigation.selectedId;
		const row = id === undefined ? undefined : this.rowsById.get(id);
		return row === undefined ? undefined : this.withBoardElapsed(row);
	}

	private closePeek(sent = false): void {
		if (this.peekId !== undefined) {
			const draft = this.reply.getValue();
			if (draft && !sent && !this.sending) this.replyDrafts.set(this.peekId, draft);
			else {
				this.replyDrafts.delete(this.peekId);
				this.pickedChoices.delete(this.peekId);
				if (!this.sending) this.replyTargets.delete(this.peekId);
			}
		}
		this.peekId = undefined;
		this.drawnChoices = undefined;
		this.reply.setValue("");
	}
	private openTaskDetail(): void {
		const task = this.selected();
		if (!task) return;
		this.enterAwayView(task);
		this.navigation.focus = { kind: "detail" };
		this.closeTranscript();
		this.actionIndex = 0;
		this.scroll = 0;
		void this.loadDetail();
	}

	setReopen(reopen: ((id: string, anchor?: ListSelectionAnchor) => void) | undefined): void {
		this.reopen = reopen;
	}
	/**
	 * Where a subagent opens: with `view`, the screen shows it in place of its chat page, and the inspector closes.
	 * Shells still open their output here.
	 */
	setAgentView(view: ((taskId: TaskId) => void) | undefined): void {
		this.agentView = view;
	}
	/**
	 * Shows `task` on the screen when it is a subagent and the screen can, then closes: the request comes first, so the
	 * screen keeps what it shows until the subagent is there.
	 */
	private showAgent(task: TaskRecord): boolean {
		const view = this.agentView;
		if (view === undefined || task.kind !== "agent") return false;
		this.chosenKey = taskStableKey(task);
		const baseAnchor = this.selectionPhase.kind === "away" ? this.selectionPhase.anchor : undefined;
		this.returnAnchor = {
			selectedKey: taskStableKey(task),
			orderKeys: baseAnchor?.orderKeys ?? this.navigationEntries.map((entry) => entry.key),
			scroll: baseAnchor?.scroll ?? this.currentBoardScroll(),
		};
		this.closeReason = "navigated-agent";
		this.navigation.focus = { kind: "composer" };
		view(task.ref.taskId);
		this.close();
		return true;
	}
	private orderedSections(): TaskListSection[] {
		const dismissed = dismissedTasks(this.store);
		const liveRevision = this.store.panelRevision?.();
		if (
			this.taskSections === undefined &&
			this.sortedKey !== undefined &&
			liveRevision !== undefined &&
			this.store.taskRecord !== undefined &&
			this.sortedKey.revision === liveRevision &&
			this.sortedKey.settled === this.store.settlementOrder.size &&
			this.sortedSections !== undefined
		) {
			const readTask = this.store.taskRecord.bind(this.store);
			const previous = this.tasksById;
			let anyChanged = false;
			const nextSections = this.sortedSections.map((section) => {
				let sectionChanged = false;
				const nextTasks = section.tasks.map((old) => {
					const task = readTask(old.ref.taskId) ?? old;
					if (task !== old) {
						sectionChanged = true;
						anyChanged = true;
						previous.set(task.ref.taskId, task);
						if (task.elapsedSpan === undefined && !dismissed.has(task.ref.taskId))
							this.elapsedClocks.elapsedMs(
								task.ref.taskId,
								task.metrics?.elapsedMs,
								taskClockRunning(task.execution.kind) && !isTaskTurnInterrupted(task),
							);
					}
					return task;
				});
				return sectionChanged ? { ...section, tasks: nextTasks } : section;
			});
			this.taskSections = anyChanged ? nextSections : this.sortedSections;
			this.sortedSections = this.taskSections;
		}
		if (this.taskSections === undefined) {
			this.sortedKey =
				liveRevision !== undefined
					? { revision: liveRevision, settled: this.store.settlementOrder.size }
					: undefined;
			const tasks = this.store.backgroundTasks;
			this.tasksById = new Map(tasks.map((task) => [task.ref.taskId, task]));
			for (const task of tasks)
				if (task.elapsedSpan === undefined && !dismissed.has(task.ref.taskId))
					this.elapsedClocks.elapsedMs(
						task.ref.taskId,
						task.metrics?.elapsedMs,
						taskClockRunning(task.execution.kind) && !isTaskTurnInterrupted(task),
					);
			this.taskSections = taskListSections(tasks, this.store.settlementOrder);
			this.sortedSections = this.taskSections;
		}
		if (dismissed.size === 0) return this.taskSections;
		return this.taskSections
			.map((section) => ({ ...section, tasks: section.tasks.filter((task) => !dismissed.has(task.ref.taskId)) }))
			.filter((section) => section.tasks.length > 0);
	}
	dispose(): void {
		this.disposed = true;
		this.paintedBoard = undefined;
		this.detailRead?.abort();
		this.detailRead = undefined;
		this.releaseBoardSource?.();
		this.releaseStatusWatch();
		this.closeTranscript();
		this.unsubscribe();
		this.modelColumn.dispose();
	}
	invalidate(): void {
		this.transcript?.invalidate();
	}
	private selected() {
		const id = this.navigation.selectedTaskId;
		if (id === undefined) return undefined;
		return this.navigation.focus.kind === "tasks"
			? this.tasksById.get(id)
			: this.store.backgroundTasks.find((task) => task.ref.taskId === id);
	}
	private stdinAvailable(): boolean {
		const task = this.selected();
		if (!task || task.execution.kind === "settled") return false;
		return this.store.stdinAvailable(task.ref.taskId);
	}
	private inputTaskForSheet(): TaskRecord | undefined {
		const focus = this.navigation.focus;
		const taskId = focus.kind === "stdin" ? focus.taskId : this.navigation.selectedTaskId;
		if (taskId === undefined) return this.inputTask;
		const live =
			this.store.taskRecord?.(taskId) ??
			(!this.boardStale ? this.tasksById.get(taskId) : undefined) ??
			this.store.backgroundTasks.find((task) => task.ref.taskId === taskId);
		if (live !== undefined) {
			this.inputTask = live;
			return live;
		}
		return this.inputTask?.ref.taskId === taskId ? this.inputTask : undefined;
	}
	private async sendInput(text: string): Promise<void> {
		const task = this.navigation.focus.kind === "stdin" ? this.inputTaskForSheet() : this.selected();
		if (!task) return;
		const environment = this.transcriptEnvironment();
		const result = await this.store.writeTaskInput(task.ref.taskId, text);
		const focus = this.navigation.focus;
		const showingInput = focus.kind === "stdin" && focus.taskId === task.ref.taskId;
		if (!result.ok) {
			const message = taskDisplayText(result.error.message);
			if (this.disposed || focus.kind === "composer")
				this.reportLate(`Could not send input: ${message}`, environment);
			else this.status = message;
		} else if (showingInput) {
			this.status = `Sent ${result.value.acceptedBytes} bytes`;
		}
		if (result.ok) {
			if (showingInput && this.input.getValue() === text) this.input.setValue("");
			if (this.inputDrafts.get(task.ref.taskId) === text) this.inputDrafts.delete(task.ref.taskId);
		}
		this.requestRender();
	}
	private releaseStatusWatch(): void {
		this.statusWatch?.release();
		this.statusWatch = undefined;
	}
	/**
	 * The selected task's own extension statuses, as the row under its fullscreen page's footer. The
	 * compact picker and confirmation page show none. A write repaints the page while it is shown.
	 */
	private taskStatusRows(width: number): string[] {
		const task = this.navigation.focus.kind === "detail" ? this.selected() : undefined;
		if (task?.kind !== "agent") {
			this.releaseStatusWatch();
			return [];
		}
		if (this.statusWatch?.taskId !== task.ref.taskId) {
			this.releaseStatusWatch();
			this.statusWatch = {
				taskId: task.ref.taskId,
				release: this.store.watchExtensionStatuses(task.ref.taskId, () => this.requestRender()),
			};
		}
		const row = renderExtensionStatusRow(this.store.extensionStatuses(task.ref.taskId), width);
		return row === undefined ? [] : [row];
	}
	/** Opens the selected task's transcript: an agent's chat or a shell's retained output, on the shared stack. */
	private openTranscript(): void {
		this.detailRead?.abort();
		this.detailRead = undefined;
		this.closeTranscript();
		const task = this.selected();
		if (!task) return;
		const environment = this.transcriptEnvironment();
		if (task.kind === "command") {
			const taskId = task.ref.taskId;
			const byteCount = () =>
				BigInt(this.store.tasks.find((candidate) => candidate.ref.taskId === taskId)?.output.byteCount ?? "0");
			this.transcript = new TaskCommandOutputPage(this.store, taskId, byteCount, environment, this.requestRender);
		} else if (environment === undefined) {
			this.failureNotice = "Transcript inspection is unavailable in this host.";
			this.requestRender();
			return;
		} else
			this.transcript = new TaskAgentTranscriptPage(
				this.store,
				task.ref.taskId,
				environment,
				this.requestRender,
				(reason) => this.reportLate(reason, environment),
				{
					// `/hotkeys` in the chat opens the keys `?` opens on its empty prompt.
					showKeys: () => {
						this.helpOpen = true;
						this.requestRender();
					},
				},
			);
		this.requestRender();
		void this.transcript.load();
	}
	/** A transcript's message failed after the reader left it: on the task pages if they are open, else through the host. */
	private reportLate(
		reason: string,
		environment: TaskTranscriptEnvironment | undefined = this.transcriptEnvironment(),
	): void {
		const clean = taskDisplayText(reason);
		if (this.disposed) {
			(environment ?? this.transcriptEnvironment())?.notify?.(clean);
			return;
		}
		this.failureNotice = clean;
		this.requestRender();
	}
	private closeTranscript(): void {
		this.transcript?.dispose();
		this.transcript = undefined;
		this.waitedShell?.suspended?.dispose();
		this.waitedShell = undefined;
	}
	/** The newest running shell of the selected subagent while it is released and waits; undefined otherwise. */
	private waitedShellOfSelected(): TaskRecord | undefined {
		const task = this.selected();
		if (task === undefined) return undefined;
		return waitingReleasedShells(task, this.store.ownerTasks ?? this.store.tasks).at(-1);
	}
	/**
	 * Opens the output of the shell the selected waiting subagent waits on, as its key does from the subagent's chat,
	 * its detail page or its row. The shell is the subagent's, so it is shown without becoming the list's selection.
	 */
	private openWaitedShell(): boolean {
		const shell = this.waitedShellOfSelected();
		if (shell === undefined) return false;
		const suspended = this.transcript;
		const returnTo = suspended !== undefined ? "chat" : this.navigation.focus.kind === "tasks" ? "list" : "detail";
		if (returnTo === "list") this.enterAwayView(this.selected());
		// The chat, a peek or the detail page stays as it is under the shell's output, for the back key.
		this.transcript = undefined;
		const taskId = shell.ref.taskId;
		const byteCount = () => BigInt(this.waitedShellRecord(taskId)?.output.byteCount ?? "0");
		this.navigation.focus = { kind: "detail" };
		this.transcript = new TaskCommandOutputPage(
			this.store,
			taskId,
			byteCount,
			this.transcriptEnvironment(),
			this.requestRender,
		);
		this.waitedShell = { taskId, returnTo, suspended, scroll: this.scroll, actionIndex: this.actionIndex };
		this.requestRender();
		void this.transcript.load();
		return true;
	}
	private waitedShellRecord(taskId: TaskId): TaskRecord | undefined {
		return (this.store.ownerTasks ?? this.store.tasks).find((task) => task.ref.taskId === taskId);
	}
	/** Back from a waiting subagent's shell to the view it was opened from, as it was left. */
	private leaveWaitedShell(): void {
		const back = this.waitedShell;
		if (back === undefined) return;
		this.waitedShell = undefined;
		this.transcript?.dispose();
		this.transcript = undefined;
		this.scroll = back.scroll;
		this.actionIndex = back.actionIndex;
		if (back.suspended !== undefined) {
			this.transcript = back.suspended;
			this.navigation.focus = { kind: "detail" };
			back.suspended.refresh();
		} else if (back.returnTo === "list") {
			this.returnToList();
		} else {
			this.navigation.focus = { kind: "detail" };
			void this.loadDetail();
		}
		this.requestRender();
	}
	private async loadDetail(): Promise<void> {
		this.detailRead?.abort();
		const controller = new AbortController();
		this.detailRead = controller;
		const selectedId = this.selected()?.ref.taskId;
		if (selectedId !== this.detailTaskId) {
			this.detailContent = {};
			this.detailTaskId = selectedId;
		}
		this.status = "";
		const generation = ++this.detailGeneration;
		const focus = this.navigation.focus;
		const task = this.selected();
		if (!task) return;
		const current = () =>
			!this.disposed &&
			generation === this.detailGeneration &&
			this.navigation.focus === focus &&
			focus.kind === "detail" &&
			this.navigation.selectedTaskId === task.ref.taskId;
		const read = readTaskDetailForView(this.store, task.ref.taskId, controller.signal);
		const own = read instanceof Promise ? await read : read;
		if (!current()) return;
		if (own.prompt !== undefined) this.detailContent.prompt = own.prompt;
		if (own.output !== undefined) this.detailContent.output = own.output;
		if (task.kind === "command") {
			try {
				const count = BigInt(task.output.byteCount);
				const output = await this.store.readTaskOutput(task.ref.taskId, {
					start: String(count > 8192n ? count - 8192n : 0n),
					maximumBytes: 8192,
				});
				if (!current()) return;
				if (output.ok) {
					this.detailContent.output = output.value.text;
					this.detailContent.outputOmitted = count > 8192n || output.value.omitted;
				} else this.status = taskDisplayText(output.error.message);
			} catch {
				if (!current()) return;
				this.status = "Command output unavailable";
			}
		}
		if (current()) this.requestRender();
	}
	/**
	 * A single click on a `/tasks` board row opens it (matching `Enter`); on an open transcript, it expands or
	 * collapses the clicked block.
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || this.helpOpen) return undefined;
		if (this.navigation.focus.kind === "tasks") return this.handleBoardClick(event);
		const transcript = this.transcript;
		const top = this.transcriptTop;
		if (transcript?.handleMouse === undefined || top === undefined) return undefined;
		if (this.navigation.focus.kind !== "detail") return undefined;
		const result = transcript.handleMouse({ ...event, y: event.y - top });
		if (result === undefined) return undefined;
		this.requestRender();
		return repaintAfterSingleClick(result, () => this.requestRender());
	}

	private handleBoardClick(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!isSingleLeftClick(event) || this.sending || this.paintedBoard === undefined) return undefined;
		const index = Math.floor(event.y);
		if (index < 0 || index >= this.paintedBoard.rowsByLine.length) return undefined;
		const paintedId = this.paintedBoard.rowsByLine[index];
		if (paintedId === undefined) return undefined;
		const paintedRow = this.paintedBoard.rowsById.get(paintedId);
		if (paintedRow === undefined) return undefined;

		if (this.boardStale) this.refreshOrder();
		let target = this.rowsById.get(paintedId);
		if (target === undefined && paintedRow.kind === "task") {
			const stableKey = taskStableKey(paintedRow.task);
			const entry = this.navigationEntries.find((candidate) => candidate.key === stableKey);
			if (entry !== undefined) target = this.rowsById.get(entry.id);
		}
		if (target === undefined) {
			this.requestRender();
			return { handled: true };
		}

		this.failureNotice = "";
		this.status = "";
		this.navigation.stopConfirm.reset();
		this.navigation.finishedWhileArmed = undefined;
		this.itemFinishedWhileArmed = undefined;
		this.itemFinishedAcknowledged = false;
		if (this.filtering) this.filtering = false;
		if (this.peekId !== undefined) this.closePeek();
		this.selectionChosen = true;
		this.navigation.select(target.id);
		if (target.kind === "item") {
			if (!this.openBoardItem(target)) this.requestRender();
		} else {
			this.openBoardTask(target.task);
		}
		return { handled: true };
	}

	private openBoardTask(task: TaskRecord): void {
		this.navigation.focus = { kind: "detail" };
		if (this.showAgent(task)) return;
		this.enterAwayView(task);
		this.chatFrom = "list";
		this.detailGeneration++;
		this.openTranscript();
		if (this.transcript === undefined) {
			void this.loadDetail();
			this.requestRender();
		}
	}

	private openBoardItem(row: Extract<TaskBoardRow, { kind: "item" }>): boolean {
		if (this.boardSource?.open) {
			const reopen = this.reopen;
			const anchor = this.captureListAnchor(row.id);
			try {
				const opened = this.boardSource.open(
					row.id,
					reopen ? { onReturn: () => reopen(row.id, anchor) } : undefined,
				);
				if (opened === false) this.failureNotice = `Could not open ${rowName(row)}.`;
				else {
					this.chosenKey = panelItemStableKey(row.item);
					this.returnAnchor = anchor;
					this.closeReason = "navigated-item";
					this.close();
					return true;
				}
			} catch (error) {
				const reason = taskDisplayText(error instanceof Error ? error.message : String(error));
				this.failureNotice = reason
					? `Could not open ${rowName(row)}: ${reason}`
					: `Could not open ${rowName(row)}.`;
			}
		} else this.status = "This item can't be opened from here.";
		return false;
	}

	/** Ctrl+O was pressed: the open transcript's blocks follow the tool-output setting again. */
	toolOutputToggled(): void {
		this.transcript?.toolOutputToggled?.();
	}

	/** What the last frame drew on `row`: a `/tasks` board row id or the open transcript's row key; undefined elsewhere. */
	paintedRowKey(row: number): string | undefined {
		if (this.disposed || this.helpOpen) return undefined;
		if (this.navigation.focus.kind === "tasks") {
			if (this.sending || this.paintedBoard === undefined) return undefined;
			const index = Math.floor(row);
			const rowId = index >= 0 ? this.paintedBoard.rowsByLine[index] : undefined;
			return rowId === undefined ? undefined : `board:${rowId}`;
		}
		const transcript = this.transcript;
		const top = this.transcriptTop;
		if (transcript?.paintedRowKey === undefined || top === undefined) return undefined;
		if (this.navigation.focus.kind !== "detail") return undefined;
		return transcript.paintedRowKey(row - top);
	}

	/** Every key belongs to the inspector except the host's thinking toggle when it leaves that alone. */
	handleInput(data: string): boolean {
		if (isNonWheelMouseReport(data)) return true;
		const keys = getKeybindings();
		const stopKey = keys.matches(data, "app.list.stop");
		const selectionAction =
			stopKey ||
			keys.matches(data, "app.list.open") ||
			keys.matches(data, "app.list.peek") ||
			keys.matches(data, "app.tasks.input") ||
			keys.matches(data, "app.tasks.openWaited");
		const armedBeforeRefresh = stopKey ? this.navigation.stopConfirm.pending() : undefined;
		const selectedBeforeRefresh = this.navigation.selectedId;
		const peekRow = this.peekId === undefined ? undefined : this.selectedRow();
		const replyingInPeek =
			this.navigation.focus.kind === "tasks" &&
			peekRow !== undefined &&
			peekRow.id === this.peekId &&
			this.peekReplies(peekRow);
		if (
			this.boardStale &&
			this.navigation.focus.kind === "tasks" &&
			(this.peekId === undefined ||
				(!replyingInPeek && stopKey) ||
				matchesKey(data, "up") ||
				matchesKey(data, "down") ||
				parseWheelReport(data) !== undefined)
		) {
			this.refreshOrder();
		}
		this.selectionChosen = true;
		if (
			selectionAction &&
			this.navigation.focus.kind === "tasks" &&
			!this.filtering &&
			!replyingInPeek &&
			(this.navigation.selectedId !== selectedBeforeRefresh ||
				(armedBeforeRefresh !== undefined && this.navigation.selectedId !== armedBeforeRefresh))
		) {
			this.navigation.stopConfirm.reset();
			this.requestRender();
			return true;
		}
		return this.route(data) || !isHostThinkingToggle(data);
	}
	private route(data: string): boolean {
		if (this.sending && this.navigation.focus.kind === "tasks") {
			if (matchesKey(data, "escape") || getKeybindings().matches(data, "app.nav.back")) {
				this.navigation.focus = { kind: "composer" };
				this.close();
			}
			return true;
		}
		this.failureNotice = "";
		// The finished-while-armed notice stays through the stop key's presses and leaves with any other key.
		if (!getKeybindings().matches(data, "app.list.stop")) {
			this.navigation.finishedWhileArmed = undefined;
			this.itemFinishedWhileArmed = undefined;
			this.itemFinishedAcknowledged = false;
		}
		if (this.helpOpen) {
			// The overlay is a dialog: Esc or `?` closes it, and other keys wait until it is closed.
			if (matchesKey(data, "escape") || isNavHelpKey(getKeybindings(), data)) this.helpOpen = false;
			this.requestRender();
			return true;
		}
		if (this.transcript) return this.handleTranscriptInput(data, this.transcript);
		const peekRow = this.peekId === undefined ? undefined : this.selectedRow();
		const editingBoard =
			this.navigation.focus.kind === "tasks" &&
			(this.filtering || (peekRow !== undefined && peekRow.id === this.peekId && this.peekReplies(peekRow)));
		if (!editingBoard && this.navigation.focus.kind !== "stdin" && isNavHelpKey(getKeybindings(), data)) {
			this.helpOpen = true;
			this.requestRender();
			return true;
		}
		if (!getKeybindings().matches(data, "app.list.stop")) this.navigation.stopConfirm.reset();
		const wheel = parseWheelReport(data);
		if (wheel !== undefined) {
			if (this.navigation.focus.kind === "tasks") {
				if (this.peekId !== undefined) this.closePeek();
				this.navigation.moveSelection(wheel.direction);
			} else if (this.navigation.focus.kind === "detail")
				this.scroll = Math.max(0, this.scroll + wheel.direction * DETAIL_WHEEL_ROWS);
			this.requestRender();
			return true;
		}
		// Mouse reports are never text input, including horizontal wheel/release.
		if (/^\x1b\[<\d+;\d+;\d+[mM]$/.test(data) || data.startsWith("\x1b[M")) return true;
		const focus = this.navigation.focus;
		if (focus.kind === "stdin") {
			// Shell input is a prompt: Esc cancels nothing and keeps the text; ← on an empty input returns to the list.
			if (matchesKey(data, "escape")) return true;
			// ← on an empty input, or at its start (the draft is kept for the return), goes back to the list.
			if (getKeybindings().matches(data, "app.nav.back") && (this.input.getCursor() === 0 || isHintActivation())) {
				this.returnToList();
				this.status = "";
				this.requestRender();
				return true;
			}
			this.input.handleInput(data);
			this.inputDrafts.set(focus.taskId, this.input.getValue());
			this.requestRender();
			return true;
		}
		if (!editingBoard && getKeybindings().matches(data, "app.tasks.openWaited") && this.openWaitedShell())
			return true;
		if (focus.kind === "tasks" && this.handleBoardInput(data)) {
			this.requestRender();
			return true;
		}
		if (
			matchesKey(data, "escape") ||
			(getKeybindings().matches(data, "app.nav.back") && !this.configuredTaskKey(data))
		) {
			if (focus.kind === "detail") {
				this.returnToList();
			} else {
				this.navigation.handleInput("\x1b", "tasks");
				if (this.navigation.focus.kind === "composer") this.close();
			}
			this.requestRender();
			return true;
		}
		const syncAwayAnchor = () => {
			if (this.navigation.focus.kind !== "detail" || this.selectionPhase.kind !== "away") return;
			const nextId = this.navigation.selectedId;
			const nextKey = this.navigation.currentStableKey ?? nextId;
			if (nextId === undefined || nextKey === this.selectionPhase.anchor.selectedKey) return;
			const moved = this.captureListAnchor(nextId, this.selected());
			if (moved !== undefined) this.selectionPhase = { kind: "away", anchor: moved };
		};
		const task = this.selected();
		if (task && this.navigation.focus.kind === "detail") {
			const actions = taskDetailActions(task.execution, task.attention, this.stdinAvailable());
			if (this.configuredTaskKey(data)) {
				if (getKeybindings().matches(data, "app.list.open"))
					void this.navigation.activate(actions[Math.min(this.actionIndex, actions.length - 1)]);
				else this.navigation.handleInput(data, "tasks");
				this.requestRender();
				return true;
			}
			if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
				this.scroll = Math.max(0, this.scroll + (matchesKey(data, "pageUp") ? -5 : 5));
				this.requestRender();
				return true;
			}
			if (matchesKey(data, "up")) this.actionIndex = Math.max(0, this.actionIndex - 1);
			else if (matchesKey(data, "down")) this.actionIndex = Math.min(actions.length - 1, this.actionIndex + 1);
			else if (getKeybindings().matches(data, "app.list.open"))
				void this.navigation.activate(actions[Math.min(this.actionIndex, actions.length - 1)]);
			else {
				if (this.boardStale && (matchesKey(data, "home") || matchesKey(data, "end"))) this.refreshOrder();
				if (!this.navigation.handleInput(data, "tasks")) return false;
				syncAwayAnchor();
			}
		} else {
			if (this.boardStale && (matchesKey(data, "home") || matchesKey(data, "end"))) this.refreshOrder();
			if (!this.navigation.handleInput(data, "tasks")) return false;
			syncAwayAnchor();
		}
		this.requestRender();
		return true;
	}
	/**
	 * A transcript is a chat: the back key with nothing typed goes back one level, Esc interrupts the agent's turn and
	 * never leaves, `?` on an empty prompt lists the keys, and every other key belongs to the chat. While its own task
	 * list is open, those keys belong to that list, which returns to the chat.
	 */
	private handleTranscriptInput(data: string, transcript: TaskTranscriptPage): boolean {
		if (transcript.handlesBack()) return transcript.handleInput(data);
		const keys = getKeybindings();
		if (transcript instanceof TaskCommandOutputPage) {
			if (keys.matches(data, "app.list.stop")) {
				const waited = this.waitedShell;
				const shell = waited === undefined ? this.selected() : this.waitedShellRecord(waited.taskId);
				const isRunning =
					shell !== undefined && shell.execution.kind !== "settled" && shell.execution.kind !== "cancelling";
				const hadFinishedNotice =
					this.navigation.finishedWhileArmed !== undefined || this.itemFinishedWhileArmed !== undefined;
				const step = stepShellStopConfirm(
					isRunning,
					this.navigation.stopConfirm.pending() === shell?.ref.taskId,
					hadFinishedNotice,
				);
				if (step === "arm" && shell !== undefined) {
					this.navigation.finishedWhileArmed = undefined;
					this.navigation.finishedAcknowledged = false;
					this.itemFinishedWhileArmed = undefined;
					this.itemFinishedAcknowledged = false;
					this.navigation.stopConfirm.press(shell.ref.taskId);
					this.requestRender();
					const timer = setTimeout(() => this.requestRender(), NAV_CONFIRM_WINDOW_MS + 50);
					timer.unref?.();
					return true;
				}
				if (step === "confirm" && shell !== undefined) {
					this.navigation.finishedWhileArmed = undefined;
					this.navigation.finishedAcknowledged = false;
					this.itemFinishedWhileArmed = undefined;
					this.itemFinishedAcknowledged = false;
					this.navigation.stopConfirm.press(shell.ref.taskId);
					const environment = this.transcriptEnvironment();
					void this.store
						.cancelTask(shell.ref.taskId)
						.then((result) => {
							if (result.ok) {
								this.failureNotice = "";
								this.requestRender();
							} else {
								this.reportLate(
									`Could not stop the task: ${taskDisplayText(result.error.message)}`,
									environment,
								);
							}
						})
						.catch((error) => {
							const message = error instanceof Error ? error.message : String(error);
							this.reportLate(`Could not stop the task: ${taskDisplayText(message)}`, environment);
						});
					this.requestRender();
					return true;
				}
				this.navigation.stopConfirm.reset();
				this.navigation.finishedWhileArmed = undefined;
				this.navigation.finishedAcknowledged = false;
				this.itemFinishedWhileArmed = undefined;
				this.itemFinishedAcknowledged = false;
				this.requestRender();
				return true;
			}
			this.navigation.stopConfirm.reset();
			this.navigation.finishedWhileArmed = undefined;
			this.navigation.finishedAcknowledged = false;
			this.itemFinishedWhileArmed = undefined;
			this.itemFinishedAcknowledged = false;
		}
		if (matchesKey(data, "escape")) {
			if (transcript.takesEscape?.() === true) return transcript.handleInput(data);
			if (transcript.interruptible()) void this.interruptTranscript(transcript);
			this.requestRender();
			return true;
		}
		if (keys.matches(data, "app.tasks.openWaited") && this.waitedShell === undefined && this.openWaitedShell())
			return true;
		// ← on an empty prompt, or at the start of a typed one (kept for the return), goes back one level.
		if (
			!matchesKey(data, "escape") &&
			keys.matches(data, "app.nav.back") &&
			(transcript.cursorAtStart() || isHintActivation())
		) {
			this.navigation.stopConfirm.reset();
			if (this.waitedShell !== undefined) {
				this.leaveWaitedShell();
				return true;
			}
			if (this.chatFrom === "caller") {
				this.closedByBack = true;
				this.closeReason = "back-to-caller";
				this.close();
				return true;
			}
			this.closeTranscript();
			this.detailGeneration++;
			this.scroll = 0;
			if (this.chatFrom === "list") this.returnToList();
			else void this.loadDetail();
			this.requestRender();
			return true;
		}
		if (isNavHelpKey(keys, data) && (!transcript.hasDraft() || isHintActivation())) {
			this.helpOpen = true;
			this.requestRender();
			return true;
		}
		return transcript.handleInput(data);
	}

	private handleBoardInput(data: string): boolean {
		const keys = getKeybindings();

		this.status = "";
		if (this.sending) return true;
		if (this.filtering) {
			const previousFilter = this.filter;
			if (matchesKey(data, "escape")) {
				this.filtering = false;
				this.filter = "";
				this.filterInput.setValue("");
			} else if (matchesKey(data, "enter") || matchesKey(data, "down") || matchesKey(data, "up")) {
				this.filtering = false;
				if (matchesKey(data, "up") || matchesKey(data, "down")) this.navigation.handleInput(data, "tasks");
			} else if (matchesKey(data, "backspace") && this.filterInput.getValue() === "") {
				this.filtering = false;
			} else {
				this.filterInput.handleInput(data);
				this.filter = this.filterInput.getValue();
			}
			if (this.filter !== previousFilter || this.boardStale) this.refreshOrder();
			return true;
		}
		if (matchesKey(data, "enter") && Date.now() - this.sentAt < REPLY_ENTER_GUARD_MS) return true;
		const row = this.selectedRow();
		if (this.peekId !== undefined && row?.id === this.peekId) {
			const replying = this.peekReplies(row);
			if (
				matchesKey(data, "escape") ||
				(!replying && keys.matches(data, "app.nav.back") && !this.configuredTaskKey(data))
			) {
				this.closePeek();
				return true;
			}
			if (keys.matches(data, "app.list.peek") && !replying) {
				this.closePeek();
				return true;
			}
			if (replying) {
				if (keys.matches(data, "app.nav.back") && (this.reply.getCursor() === 0 || isHintActivation())) {
					this.closePeek();
					return true;
				}
				if (
					row.kind === "task" &&
					this.reply.getValue().trim() === "" &&
					(matchesKey(data, "enter") || keys.matches(data, "app.list.open"))
				) {
					this.closePeek();
					this.openTaskDetail();
					return true;
				}
				if (matchesKey(data, "enter")) {
					if (!this.sending) void this.sendReply(row);
					return true;
				}
				if (this.sending) return true;
				if (
					/^[1-9]$/.test(data) &&
					this.reply.getValue() === "" &&
					(row.kind === "item" ? (row.item.choices?.length ?? 0) > 0 : false)
				) {
					const index = Number(data);
					const choice = this.drawnChoices?.[index - 1];
					if (choice !== undefined) {
						for (const char of taskDisplayText(choice)) this.handleReplyInput(row.id, char);
						const filled = this.reply.getValue();
						if (filled !== "" && this.replyTargets.has(row.id)) {
							this.pickedChoices.set(row.id, { text: filled, raw: choice, index: index - 1 });
						}
						return true;
					}
				}
				if (!matchesKey(data, "up") && !matchesKey(data, "down")) {
					this.handleReplyInput(row.id, data);
					return true;
				}
			}
			if (matchesKey(data, "up") || matchesKey(data, "down")) this.closePeek();
			else if (row.kind === "task" && (matchesKey(data, "enter") || keys.matches(data, "app.list.open"))) {
				this.closePeek();
				if (row.task.attention.kind === "input-needed") return false;
				this.openTaskDetail();
				return true;
			}
		}
		if (keys.matches(data, "app.list.filter")) {
			this.filtering = true;
			this.filterInput.setValue(this.filter);
			return true;
		}
		if (keys.matches(data, "app.list.peek") && row !== undefined && this.peeksInCard(row)) {
			if (this.peekId !== undefined) this.closePeek();
			this.peekId = row.id;
			this.drawnChoices = undefined;
			this.reply.setValue("");
			const draft = this.replyDrafts.get(row.id) ?? "";
			this.replyDrafts.delete(row.id);
			for (const char of draft) this.reply.handleInput(char);
			if (!draft) {
				this.replyTargets.delete(row.id);
				this.pickedChoices.delete(row.id);
			}
			return true;
		}
		if (row?.kind !== "item") return false;
		if (keys.matches(data, "app.list.open")) {
			this.openBoardItem(row);
			return true;
		}
		if (keys.matches(data, "app.list.stop")) {
			const pendingStop = this.navigation.stopConfirm.pending();
			if (pendingStop !== undefined && pendingStop !== row.id) {
				this.navigation.stopConfirm.reset();
				return true;
			}
			const liveItem = this.boardSource?.items().find((candidate) => candidate.id === row.id);
			const effectiveRow: Extract<TaskBoardRow, { kind: "item" }> =
				liveItem !== undefined && liveItem !== row.item ? { ...row, item: liveItem } : row;
			if (rowFinished(effectiveRow) && this.paintedItemFinished.get(effectiveRow.id) !== true) {
				this.navigation.stopConfirm.reset();
				this.itemFinishedWhileArmed = { id: effectiveRow.id, name: rowName(effectiveRow) };
				this.itemFinishedAcknowledged = true;
			} else if (
				rowFinished(effectiveRow) &&
				this.itemFinishedWhileArmed?.id === effectiveRow.id &&
				!this.itemFinishedAcknowledged
			) {
				this.itemFinishedWhileArmed = undefined;
				this.itemFinishedAcknowledged = true;
			} else if (rowFinished(effectiveRow)) {
				this.itemFinishedWhileArmed = undefined;
				this.itemFinishedAcknowledged = false;
				this.dismissedItems.add(effectiveRow.id);
				this.boardSource?.dismiss?.(effectiveRow.id);
				this.paintedItemFinished.delete(effectiveRow.id);
				this.refreshOrder();
			} else if (this.navigation.stopConfirm.press(effectiveRow.id as TaskId)) void this.stopItem(effectiveRow);
			else {
				this.requestRender();
				const timer = setTimeout(() => this.requestRender(), NAV_CONFIRM_WINDOW_MS + 50);
				timer.unref?.();
			}
			return true;
		}
		return false;
	}
	private handleReplyInput(rowId: string, data: string): void {
		const empty = this.reply.getValue() === "";
		const target = empty ? this.paintedPrompts.get(rowId) : this.replyTargets.get(rowId);
		if (empty && target === undefined) return;
		this.reply.handleInput(data);
		const next = this.reply.getValue();
		const picked = this.pickedChoices.get(rowId);
		if (picked !== undefined && picked.text !== next) {
			this.pickedChoices.delete(rowId);
		}
		if (next === "") {
			this.replyTargets.delete(rowId);
			this.replyDrafts.delete(rowId);
			this.pickedChoices.delete(rowId);
		} else if (empty && target !== undefined) this.replyTargets.set(rowId, target);
	}
	private peeksInCard(row: TaskBoardRow): boolean {
		return row.kind !== "task" || row.task.attention.kind !== "input-needed";
	}
	private peekReplies(row: TaskBoardRow): boolean {
		if (row.kind === "task") {
			return (
				row.task.kind === "agent" &&
				row.task.execution.kind === "running" &&
				row.task.attention.kind === "none" &&
				this.store.sendTaskMessage !== undefined
			);
		}
		return rowState(row) === "input" && Boolean(row.item.question) && this.boardSource?.answer !== undefined;
	}
	private currentPrompt(row: TaskBoardRow): AgentPanelAnswerOptions | undefined {
		if (row.kind === "item") return promptAnswerOptionsOf(row.item);
		const taskId = row.task.ref.taskId;
		const live =
			this.store.taskRecord?.(taskId) ?? this.store.tasks.find((task) => task.ref.taskId === taskId) ?? row.task;
		return taskReplyPrompt(live);
	}
	private clearReply(rowId: string): void {
		if (this.peekId === rowId) this.reply.setValue("");
		this.replyTargets.delete(rowId);
		this.replyDrafts.delete(rowId);
		this.pickedChoices.delete(rowId);
	}
	private dropStaleReply(row: TaskBoardRow): void {
		const target = this.replyTargets.get(row.id);
		if (target === undefined || this.sending) return;
		const current = this.currentPrompt(row);
		if (current === undefined || samePromptOptions(target, current)) return;
		this.clearReply(row.id);
		this.failureNotice = "The question changed; your reply was cleared.";
	}
	private boardRoom(
		budget = this.boardBudget,
		minRoom = 1,
		notice = this.failureNotice || this.stopNotice() || this.status,
	): number {
		const lineBudget = Math.max(1, budget);
		const headLines = 2 + (this.filtering || this.filter ? 1 : 0);
		const footerLines = 1 + (notice ? 1 : 0);
		if (lineBudget < headLines + footerLines + minRoom) {
			const hintLines = lineBudget >= 2 ? 1 : 0;
			return Math.max(1, lineBudget - hintLines);
		}
		return lineBudget - headLines - footerLines;
	}
	private peekMaxLines(
		row: TaskBoardRow,
		budget = this.boardBudget,
		notice = this.failureNotice || this.stopNotice() || this.status,
	): number {
		const replyCount = this.sending || this.peekReplies(row) ? 1 : 0;
		const minRoom = 3 + replyCount;
		return Math.min(10, Math.max(1, this.boardRoom(budget, minRoom, notice) - 3 - replyCount));
	}
	private peekChoices(
		row: TaskBoardRow,
		budget = this.boardBudget,
		notice = this.failureNotice || this.stopNotice() || this.status,
	): readonly string[] {
		if (row.kind !== "item") return [];
		const replyCount = this.sending || this.peekReplies(row) ? 1 : 0;
		const minRoom = 3 + replyCount;
		const maxLines = Math.min(10, this.boardRoom(budget, minRoom, notice) - 3 - replyCount);
		return (row.item.choices ?? []).slice(0, Math.min(9, Math.max(0, maxLines - 1)));
	}
	private async sendReply(row: TaskBoardRow): Promise<void> {
		const typed = this.reply.getValue();
		const text = typed.trim();
		if (!text) return;
		const rowId = row.id;
		const environment = this.transcriptEnvironment();
		if (row.kind === "task") {
			if (!this.store.sendTaskMessage) return;
			const expected = this.replyTargets.get(rowId);
			const current = this.currentPrompt(row);
			if (expected === undefined || current === undefined || !samePromptOptions(expected, current)) {
				this.clearReply(rowId);
				this.reportLate("The question changed before the answer was sent; your reply was cleared.", environment);
				return;
			}
			this.sending = true;
			this.requestRender();
			try {
				await this.store.sendTaskMessage(row.task.ref.taskId, text);
				this.sentAt = Date.now();
				this.replyDrafts.delete(rowId);
				this.replyTargets.delete(rowId);
				this.pickedChoices.delete(rowId);
				if (this.peekId === rowId) this.closePeek(true);
				this.status = `Sent to ${rowName(row)}`;
			} catch (error) {
				if (this.peekId !== rowId) this.replyDrafts.set(rowId, typed);
				const message = error instanceof Error ? error.message : String(error);
				this.reportLate(`Could not send the answer: ${taskDisplayText(message)}`, environment);
			} finally {
				this.sending = false;
				this.requestRender();
			}
			return;
		}
		if (!this.boardSource?.answer) return;
		const id = row.id;
		const expected = this.replyTargets.get(rowId);
		if (expected === undefined) {
			this.clearReply(rowId);
			this.reportLate("The question changed before the answer was sent; your reply was cleared.", environment);
			return;
		}
		const picked = this.pickedChoices.get(rowId);
		const answerText = picked !== undefined && picked.text === typed ? picked.raw : text;
		this.sending = true;
		this.requestRender();
		try {
			const answerOptions =
				picked !== undefined && picked.text === typed ? { ...expected, choiceIndex: picked.index } : expected;
			const result = await this.boardSource.answer(id, answerText, answerOptions);
			if (result.ok) {
				this.sentAt = Date.now();
				this.replyDrafts.delete(rowId);
				this.replyTargets.delete(rowId);
				this.pickedChoices.delete(rowId);
				if (this.peekId === rowId) this.closePeek(true);
				this.status = `Sent to ${rowName(row)}`;
			} else {
				const painted = this.paintedPrompts.get(rowId);
				if (painted !== undefined && !samePromptOptions(painted, expected)) {
					this.clearReply(rowId);
					this.reportLate(
						`Could not send the answer: ${taskDisplayText(result.reason)} Your reply was cleared.`,
						environment,
					);
				} else {
					if (this.peekId !== rowId) this.replyDrafts.set(rowId, typed);
					this.reportLate(`Could not send the answer: ${taskDisplayText(result.reason)}`, environment);
				}
			}
		} catch (error) {
			if (this.peekId !== rowId) this.replyDrafts.set(rowId, typed);
			const message = error instanceof Error ? error.message : String(error);
			this.reportLate(`Could not send the answer: ${taskDisplayText(message)}`, environment);
		} finally {
			this.sending = false;
			this.requestRender();
		}
	}
	private async stopItem(row: Extract<TaskBoardRow, { kind: "item" }>): Promise<void> {
		const environment = this.transcriptEnvironment();
		if (!this.boardSource?.stop) {
			this.reportLate("This item can't be stopped from here.", environment);
			return;
		}
		const liveItem = this.boardSource.items().find((candidate) => candidate.id === row.id);
		if (liveItem !== undefined && rowFinished({ id: row.id, kind: "item", item: liveItem })) {
			this.itemFinishedWhileArmed = { id: row.id, name: rowName({ id: row.id, kind: "item", item: liveItem }) };
			this.itemFinishedAcknowledged = true;
			this.requestRender();
			return;
		}
		try {
			const result = await this.boardSource.stop(row.id);
			if (result.ok) {
				this.failureNotice = "";
				this.requestRender();
			} else {
				this.reportLate(`Could not stop ${rowName(row)}: ${taskDisplayText(result.reason)}`, environment);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.reportLate(`Could not stop ${rowName(row)}: ${taskDisplayText(message)}`, environment);
		}
	}
	private peekContent(row: TaskBoardRow): PeekContent {
		const state = rowState(row);
		if (row.kind === "item") {
			if (state === "input")
				return { question: row.item.question ?? rowTask(row), choices: row.item.choices, lines: [] };
			const lines = [
				...(row.item.progress ? [`stage ${row.item.progress.done}/${row.item.progress.total}`] : []),
				...(row.item.reason ? [row.item.reason] : []),
				row.item.task,
			];
			return { lines };
		}
		const task = row.task;
		if (task.kind === "command") {
			return {
				lines: [
					rowTask(row),
					[taskStatusAppearance(task).label, taskMetricsText(task)].filter(Boolean).join(" · "),
				],
			};
		}
		const model = taskModelText(task);
		const action = task.execution.kind !== "settled" && task.currentAction ? toolCallHeader(task.currentAction) : "";
		const summary = [model, action].filter(Boolean).join(" · ");
		const metrics = taskMetricsText(task);
		const lines = [...(summary ? [summary] : []), ...(metrics ? [metrics] : [])];
		if (task.attention.kind === "input-needed") return { question: task.attention.prompt, lines };
		if (!lines.length) lines.push(rowTask(row));
		return { lines };
	}
	private async interruptTranscript(transcript: TaskTranscriptPage): Promise<void> {
		const result = await transcript.interrupt();
		if (!result.ok) this.failureNotice = taskDisplayText(result.error.message);
		this.requestRender();
	}
	private configuredTaskKey(data: string): boolean {
		return (["app.list.open", "app.list.stop", "app.tasks.input"] as const).some((key) =>
			getKeybindings().matches(data, key),
		);
	}
	get fullscreen(): boolean {
		return this.navigation.focus.kind === "detail";
	}

	private withLiveElapsed(task: TaskRecord): TaskRecord {
		if (isTaskTurnInterrupted(task)) return task;
		const elapsedMs = taskElapsedMs(task, taskClockRunning(task.execution.kind), this.elapsedClocks);
		if (elapsedMs === undefined) return task;
		const copy = { ...task, metrics: { ...task.metrics, elapsedMs } };
		// The board and peek read a running span again: from this view's clock, which keeps what it showed.
		return task.elapsedSpan ? bindTaskClock(copy, this.elapsedClocks) : copy;
	}
	private withBoardElapsed(row: TaskBoardRow): TaskBoardRow {
		if (row.kind === "task") return { ...row, task: this.withLiveElapsed(row.task) };
		if (row.item.state === "queued") return row;
		const clocks = taskClockOf(row.item);
		if (clocks === undefined) return row;
		const elapsedMs = clocks.elapsedMs(row.item.id, row.item.elapsedMs, taskClockRunning(row.item.state));
		if (elapsedMs === undefined || elapsedMs === row.item.elapsedMs) return row;
		return { ...row, item: { ...row.item, elapsedMs } };
	}
	private stopNotice(): string {
		if (this.itemFinishedWhileArmed !== undefined) {
			const key = getKeybindings().getKeys("app.list.stop")[0] ?? "x";
			const action = this.itemFinishedAcknowledged ? "dismiss" : "acknowledge";
			return `${this.itemFinishedWhileArmed.name} finished · ${clickableKeyTextHint(key, ` to ${action}`)}`;
		}
		const finished = this.navigation.finishedWhileArmed;
		if (finished !== undefined) {
			const key = getKeybindings().getKeys("app.list.stop")[0] ?? "x";
			const action = this.navigation.finishedAcknowledged ? "dismiss" : "acknowledge";
			return `${taskDisplayText(finished.title || taskLabel(finished))} finished · ${clickableKeyTextHint(key, ` to ${action}`)}`;
		}
		const pending = this.navigation.stopConfirm.pending();
		if (pending === undefined) return "";
		const row = this.rowsById.get(pending);
		const task =
			this.tasksById.get(pending as TaskId) ??
			this.store.tasks.find((candidate) => candidate.ref.taskId === pending) ??
			this.waitedShellRecord(pending as TaskId);
		if (row === undefined && task === undefined) return "";
		const key = getKeybindings().getKeys("app.list.stop")[0] ?? "x";
		const name = task ? taskDisplayText(task.title || taskLabel(task)) : row ? rowName(row) : "the task";
		return `Press ${clickableKeyTextHint(key, " again")} within 3s to stop ${name}`;
	}
	renderPicker(width: number, availableRows: number): string[] {
		return this.renderViewport(width, Math.max(1, Math.min(12, availableRows)));
	}
	render(width: number): string[] {
		return this.renderViewport(width, Math.max(3, (process.stdout.rows || 24) - 5));
	}
	private renderShellPage(
		width: number,
		budget: number,
		transcript: TaskCommandOutputPage,
		task: TaskRecord | undefined,
		back: string,
		style: NavKeyStyle,
		chatKeybindings: NavKeybindings,
		backKeys: string,
	): string[] {
		const safeWidth = Math.max(1, width);
		const safeBudget = Math.max(1, budget);
		const fitWidth = (line: string) => truncateToWidth(line, safeWidth);
		const geometry = shellViewerBoxGeometry(safeWidth);
		const { gutter, lead, contentWidth, framed, boxWidth, innerWidth } = geometry;
		const liveTask = task ? this.withLiveElapsed(task) : undefined;
		const commandText = liveTask ? taskDisplayText(liveTask.title || taskLabel(liveTask)) : "Shell";
		const isActive =
			liveTask !== undefined && liveTask.execution.kind !== "settled" && liveTask.execution.kind !== "cancelling";
		const topRule = safeBudget >= 10 ? [theme.fg("borderMuted", "▔".repeat(safeWidth))] : [];
		const fullLayout = framed && safeBudget >= 18;
		const titleLines = wrapTextWithAnsi(commandText, contentWidth);
		const maxTitleLines = fullLayout ? 2 : 1;
		const titleRows = (
			titleLines.length > maxTitleLines
				? [
						...titleLines.slice(0, maxTitleLines - 1),
						truncateToWidth(`${titleLines[maxTitleLines - 1]!}…`, contentWidth, "…"),
					]
				: titleLines.length > 0
					? titleLines
					: ["Shell"]
		).map((line) => fitWidth(`${lead}${theme.bold(line)}`));
		const subtitleRows = safeBudget >= 14 ? [fitWidth(`${lead}${theme.fg("muted", "shell")}`)] : [];

		if (this.helpOpen) {
			const overlayWidth = framed ? boxWidth : safeWidth;
			const overlayRows = renderNavKeyOverlay(
				"keys · shell",
				SHELL_VIEWER_OVERLAY_KEYS.flatMap((entry) => {
					if (entry.action === "app.list.stop" && !isActive) return [];
					if (entry.action === "app.nav.back") return [{ keys: backKeys, label: entry.label }];
					return [entry];
				}),
				overlayWidth,
				style,
				chatKeybindings,
			).map((line) => fitWidth(`${lead}${line}`));
			const helpHeader = [...topRule, ...titleRows, ...subtitleRows, ...(fullLayout ? [""] : [])];
			return [...helpHeader, ...overlayRows].slice(0, safeBudget);
		}

		const metaRows: string[] = [];
		if (liveTask) {
			const appearance = taskStatusAppearance(liveTask);
			const exitCode =
				liveTask.execution.kind === "settled" && liveTask.execution.result.kind !== "cancelled"
					? liveTask.execution.result.exitCode
					: undefined;
			const unknownCommandExit =
				liveTask.kind === "command" &&
				liveTask.execution.kind === "settled" &&
				liveTask.execution.result.kind === "completed" &&
				exitCode === undefined;
			const statusValue =
				theme.fg(appearance.color, `${appearance.icon} ${appearance.label}`) +
				(exitCode !== undefined
					? theme.fg("dim", ` · exit ${exitCode}`)
					: unknownCommandExit
						? theme.fg("dim", " · exit status unknown")
						: "");
			const elapsedMs = liveTask.metrics?.elapsedMs;
			const runtimeText = elapsedMs === undefined ? undefined : formatPanelElapsed(elapsedMs);
			if (fullLayout) {
				metaRows.push("");
				metaRows.push(fitWidth(`${lead}${theme.bold("Status:".padEnd(SHELL_META_LABEL_WIDTH))}${statusValue}`));
				if (runtimeText !== undefined) {
					metaRows.push(fitWidth(`${lead}${theme.bold("Runtime:".padEnd(SHELL_META_LABEL_WIDTH))}${runtimeText}`));
				}
				if (liveTask.title) {
					metaRows.push(...formatShellMetaRows("Command", commandText, 3, contentWidth, lead).map(fitWidth));
				}
				if (liveTask.execution.kind === "settled" && liveTask.execution.result.kind === "failed") {
					const errorText = taskDisplayText(liveTask.execution.result.message);
					if (errorText) {
						metaRows.push(
							...formatShellMetaRows("Error", errorText, 2, contentWidth, lead, (text) =>
								theme.fg("error", text),
							).map(fitWidth),
						);
					}
				}
			} else {
				const compactMeta = statusValue + (runtimeText === undefined ? "" : theme.fg("dim", ` · ${runtimeText}`));
				metaRows.push(fitWidth(`${lead}${compactMeta}`));
			}
		}

		const outputLabelRows =
			safeBudget >= 14
				? [...(fullLayout ? [""] : []), fitWidth(`${lead}${theme.fg("muted", theme.bold("Output"))}`)]
				: [];
		const header = [...topRule, ...titleRows, ...subtitleRows, ...metaRows, ...outputLabelRows];

		const shellKeys: NavKey[] = [
			{ action: "app.nav.back", label: back },
			{ keys: "pgup/pgdn", label: "scroll" },
			...(isActive ? [{ action: "app.list.stop", label: "stop" }] : []),
			{ action: "app.keys.help", label: "keys" },
		];
		const hint = renderNavHintLine(shellKeys, safeWidth, style, chatKeybindings, gutter);
		const stopNotice = this.failureNotice ? "" : this.stopNotice();
		const warningText = this.failureNotice || stopNotice;
		const warningRows = warningText
			? [fitWidth(`${lead}${theme.fg("warning", truncateToWidth(warningText, contentWidth))}`)]
			: [];
		const statusRows = this.taskStatusRows(safeWidth);
		const baseNotes = [
			transcript.outputState === "loading" && transcript.status === "Loading output…" ? "" : transcript.status,
			this.status,
		]
			.filter(Boolean)
			.join(" · ");
		const baseNoteRows = baseNotes ? wrapNotes(baseNotes, contentWidth).length : 0;
		const sepReserve = fullLayout && warningRows.length === 0 ? 1 : 0;
		const maxOutputRoom = Math.max(
			1,
			safeBudget - header.length - baseNoteRows - sepReserve - warningRows.length - statusRows.length - 1,
		);

		const border = (text: string) => theme.fg("borderMuted", text);
		const buildOutputBlock = (availableRoom: number): string[] => {
			const state = transcript.outputState;
			if (state === "loading") {
				return [fitWidth(`${lead}${theme.fg("dim", "Loading output…")}`)];
			}
			if (state === "empty") {
				const emptyLabel =
					liveTask !== undefined && liveTask.execution.kind !== "settled"
						? "No output yet"
						: "No output available";
				return [fitWidth(`${lead}${theme.fg("dim", emptyLabel)}`)];
			}
			if (framed && availableRoom >= 3) {
				const contentRows = transcript.measureRows(innerWidth);
				const innerRows = Math.max(1, Math.min(contentRows, availableRoom - 2));
				const bodyLines = transcript.render(innerWidth, innerRows);
				const top = `${lead}${border(`╭${"─".repeat(Math.max(0, boxWidth - 2))}╮`)}`;
				const bottom = `${lead}${border(`╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`)}`;
				const framedRows = bodyLines.map((line) => {
					const clipped = truncateToWidth(line, innerWidth, "");
					const padRight = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
					return fitWidth(`${lead}${border("│ ")}${clipped}${padRight}${border(" │")}`);
				});
				return [fitWidth(top), ...framedRows, fitWidth(bottom)];
			}
			return transcript.render(contentWidth, Math.max(1, availableRoom)).map((line) => fitWidth(`${lead}${line}`));
		};

		let outputBlock = buildOutputBlock(maxOutputRoom);
		const scrollRange =
			transcript.outputState === "output" || transcript.outputState === "error"
				? shellScrollRange(transcript.paintedWindow())
				: undefined;
		let noteText = formatShellViewerNote(baseNotes, scrollRange);
		let noteRows = wrapNotes(noteText, contentWidth).map((line) => fitWidth(`${lead}${theme.fg("dim", line)}`));

		// If the wrapped range note expanded beyond the initial estimate, shrink the box once so the bottom hint never clips.
		const overflow =
			header.length + outputBlock.length + noteRows.length + warningRows.length + statusRows.length + 1 - safeBudget;
		if (overflow > 0 && maxOutputRoom - overflow >= 1) {
			outputBlock = buildOutputBlock(maxOutputRoom - overflow);
			const nextRange =
				transcript.outputState === "output" || transcript.outputState === "error"
					? shellScrollRange(transcript.paintedWindow())
					: undefined;
			noteText = formatShellViewerNote(baseNotes, nextRange);
			noteRows = wrapNotes(noteText, contentWidth).map((line) => fitWidth(`${lead}${theme.fg("dim", line)}`));
		}

		const spacerCount = Math.max(
			0,
			safeBudget - header.length - outputBlock.length - noteRows.length - warningRows.length - statusRows.length - 1,
		);
		this.transcriptTop = header.length + (framed && outputBlock.length >= 3 ? 1 : 0);
		return [
			...header,
			...outputBlock,
			...noteRows,
			...Array.from({ length: spacerCount }, () => ""),
			...warningRows,
			hint,
			...statusRows,
		].slice(0, safeBudget);
	}

	private renderTranscriptPage(width: number, budget: number, transcript: TaskTranscriptPage): string[] {
		this.transcriptTop = undefined;
		if (transcript.handlesBack()) {
			this.transcriptTop = 0;
			return transcript.render(width, budget);
		}
		const waitedShell = this.waitedShell;
		const selected = waitedShell === undefined ? this.selected() : this.waitedShellRecord(waitedShell.taskId);
		// A resumed subagent's chat shows the attempt that runs now.
		const task =
			selected?.kind === "agent"
				? (latestSubagentAttempt(this.store.tasks, selected.ref.taskId) ?? selected)
				: selected;
		const style = themedNavKeyStyle();
		const baseKeys = getKeybindings();
		const backKeys = baseKeys
			.getKeys("app.nav.back")
			.filter((key) => !matchesKey("\x1b", key))
			.map(navKeyText)
			.join("/");
		const chatKeybindings = {
			matches: (data: string, action: string) =>
				baseKeys.matches(data, action as Parameters<typeof baseKeys.matches>[1]),
			getKeys: (action: string) => {
				const resolved = baseKeys.getKeys(action as Parameters<typeof baseKeys.getKeys>[0]);
				return action === "app.interrupt"
					? resolved
					: resolved.filter((key) => key !== "esc" && key !== "escape" && !matchesKey("\x1b", key));
			},
		};
		const waitingAgent = waitedShell === undefined ? undefined : this.selected();
		const back =
			waitedShell?.returnTo === "chat"
				? taskDisplayText(waitingAgent ? taskLabel(waitingAgent) : "agent")
				: waitedShell?.returnTo === "list"
					? "tasks"
					: waitedShell !== undefined
						? "task"
						: this.chatFrom === "caller"
							? this.callerLabel
							: this.chatFrom === "list"
								? "tasks"
								: "task";
		if (transcript instanceof TaskCommandOutputPage) {
			return this.renderShellPage(width, budget, transcript, task, back, style, chatKeybindings, backKeys);
		}
		const liveTask = task ? this.withLiveElapsed(task) : undefined;
		const fitWidth = (line: string) => truncateToWidth(line, Math.max(1, width));
		const header = [
			theme.bold(`Transcript · ${liveTask ? taskDisplayText(taskLabel(liveTask)) : "Task"}`),
			liveTask ? taskDetailSummary(liveTask) : "",
			theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
		].map(fitWidth);
		const notes = [transcript.status, this.status].filter(Boolean).join(" · ");
		const questionActive = transcript.takesEscape?.() === true;
		const interruptible = !questionActive && transcript.interruptible();
		const hasTasks = !questionActive && transcript.hasTasks?.() === true;
		const expandable = transcript.expandable?.() === true;
		if (this.helpOpen)
			return [
				...header,
				...renderNavKeyOverlay(
					"keys · task chat",
					TASK_CHAT_OVERLAY_KEYS.flatMap((entry) => {
						if (entry.keys === "enter" && transcript.canSend?.() !== true) return [];
						if (entry.action === "app.thinking.toggle" && liveTask?.kind !== "agent") return [];
						if (entry.keys === "esc" && !interruptible) return [];
						if (entry.action === "app.tools.expand" && !expandable) return [];
						const mapped = entry.action === "app.nav.back" ? { keys: backKeys, label: entry.label } : entry;
						if (entry.action === "app.nav.back" && hasTasks)
							return [mapped, { action: "app.agents.focus", label: "agents, on an empty prompt" }];
						return [mapped];
					}),
					width,
					style,
					chatKeybindings,
				),
			].slice(0, Math.max(1, budget));
		const chatKeys = taskChatKeys(back, interruptible, hasTasks, expandable).flatMap((entry) => {
			if (entry.action === "app.nav.back") {
				return !questionActive || transcript.cursorAtStart()
					? [questionActive ? { keys: backKeys, label: back } : entry]
					: [];
			}
			if (entry.keys === "pgup/pgdn" && transcript.capturesPageScroll?.() === true) {
				return [{ keys: "pgup/pgdn", label: "page" }];
			}
			if (questionActive && entry.action === "app.keys.help") return [];
			return [entry];
		});
		const noteIndent = width >= 24 ? 2 : 0;
		const noteLead = " ".repeat(noteIndent);
		const hint = renderNavHintLine(chatKeys, width, style, chatKeybindings, noteIndent);
		const footer = [
			...wrapNotes(notes, Math.max(1, width - noteIndent)).map((line) =>
				fitWidth(`${noteLead}${theme.fg("dim", line)}`),
			),
			...(transcript.handlesBack() ? [] : [hint]),
		];
		const failure = this.failureNotice
			? [
					fitWidth(
						`${noteLead}${theme.fg("warning", truncateToWidth(this.failureNotice, Math.max(1, width - noteIndent)))}`,
					),
				]
			: [];
		const statusRows = this.taskStatusRows(width);
		const room = Math.max(1, budget - header.length - footer.length - failure.length - statusRows.length);
		const body = transcript.render(width, room);
		this.transcriptTop = header.length;
		return [
			...header,
			...body,
			...Array.from({ length: Math.max(0, room - body.length) }, () => ""),
			...footer,
			...failure,
			...statusRows,
		].slice(0, Math.max(1, budget));
	}
	renderViewport(width: number, budget: number): string[] {
		if (this.transcript && this.navigation.focus.kind === "detail") {
			this.paintedBoard = undefined;
			return this.renderTranscriptPage(width, budget, this.transcript);
		}
		this.transcriptTop = undefined;
		const style = themedNavKeyStyle();
		if (this.helpOpen) {
			this.paintedBoard = undefined;
			const detailOpen = this.navigation.focus.kind === "detail";
			return renderNavKeyOverlay(
				detailOpen ? "keys · task" : "keys · tasks",
				detailOpen ? detailKeys() : listKeys(),
				width,
				style,
				getKeybindings(),
			).slice(-Math.max(1, budget));
		}
		if (this.navigation.focus.kind === "stdin") {
			this.paintedBoard = undefined;
			return this.renderInputSheet(width, budget);
		}
		if (this.navigation.focus.kind !== "detail") return this.renderBoard(width, budget);
		this.paintedBoard = undefined;
		const framed = width >= 20 && budget >= 7;
		const inner = Math.max(1, width - (framed ? 4 : 0));
		const current = this.selected();
		this.navigation.paint(current ? [current] : []);
		const actions =
			current && !this.transcript
				? taskDetailActions(current.execution, current.attention, this.stdinAvailable())
				: [];
		this.actionIndex = Math.max(0, Math.min(this.actionIndex, actions.length - 1));
		const action = actions[this.actionIndex];
		const actionRow = action ? [theme.fg("accent", `› ${taskDetailLabels[action]}`)] : [];
		const rows = this.renderAll(inner);
		const compactSummary = !framed && current && budget >= 4 ? [taskDetailSummary(current)] : [];
		const statusRows = this.taskStatusRows(width);
		const height = Math.max(
			0,
			budget - (framed ? 4 : 1) - actionRow.length - compactSummary.length - statusRows.length,
		);
		this.scroll = Math.min(this.scroll, Math.max(0, rows.length - height));
		const view = rows.slice(this.scroll, this.scroll + height);
		const stopLabel =
			current?.execution.kind === "settled" && waitingReleasedTools(current) === undefined ? "dismiss" : "stop";
		const keys = detailKeys()
			.filter(
				(key) => current !== undefined || key.keys?.startsWith("esc") === true || key.action === "app.keys.help",
			)
			.map((key) => (key.action === "app.list.stop" ? { ...key, label: stopLabel } : key));
		const footer = renderNavHintLine(keys, width, style, getKeybindings());
		const notice = this.failureNotice || this.stopNotice();
		const detailNoticeLead = framed ? "  " : "";
		const failure = notice
			? [
					`${detailNoticeLead}${theme.fg("warning", truncateToWidth(notice, Math.max(1, width - detailNoticeLead.length)))}`,
				]
			: [];
		if (!framed)
			return [...compactSummary, ...view, ...actionRow, footer, ...failure, ...statusRows]
				.map((line) => truncateToWidth(line, width))
				.slice(-Math.max(1, budget));
		const title = current ? `${taskDisplayText(taskLabel(current))} › ${taskDisplayText(current.title)}` : "Tasks";
		const heading = ` ${truncateToWidth(title, Math.max(1, width - 5))} `;
		const border = (text: string) => theme.fg("borderMuted", text);
		const frameRow = (line: string) => {
			const text = truncateToWidth(line, inner);
			return border("│ ") + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + border(" │");
		};
		return [
			border("╭─") + theme.bold(heading) + border(`${"─".repeat(Math.max(0, width - visibleWidth(heading) - 3))}╮`),
			frameRow(current ? taskDetailSummary(current) : ""),
			...view.map(frameRow),
			...actionRow.map(frameRow),
			border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
			footer,
			...failure,
			...statusRows,
		].map((line) => truncateToWidth(line, width));
	}

	private renderInputSheet(width: number, budget: number): string[] {
		const clip = (line: string) => truncateToWidth(line, Math.max(1, width));
		const task = this.inputTaskForSheet();
		const name = task
			? taskDisplayText(task.title || taskLabel(task))
			: this.navigation.focus.kind === "stdin"
				? taskDisplayText(this.navigation.focus.taskId)
				: "";
		const summary = task ? `  ${taskDetailSummary(task)}` : "";
		const entry = (this.input.render(Math.max(1, width - 4))[0] ?? "").replace(/^> /, "");
		const sheetNoteLead = width >= 20 ? "  " : "";
		const notes = [
			...(this.status ? [`${sheetNoteLead}${theme.fg("muted", taskDisplayText(this.status))}`] : []),
			...(this.failureNotice ? [`${sheetNoteLead}${theme.fg("warning", taskDisplayText(this.failureNotice))}`] : []),
		];
		const hint = renderNavHintLine(
			[
				{ keys: "enter", label: "send" },
				{ action: "app.nav.back", label: "back to list" },
			],
			width,
			themedNavKeyStyle(),
			getKeybindings(),
		);
		return [
			theme.fg("borderMuted", "▔".repeat(Math.max(1, width))),
			` ${theme.bold(`Input to ${name}`)}${summary}`,
			` ${theme.fg("accent", "❯")} ${entry}`,
			...notes,
			hint,
		]
			.map(clip)
			.slice(-Math.max(1, budget));
	}

	private renderBoard(width: number, budget: number): string[] {
		this.boardBudget = budget;
		const style = themedNavKeyStyle();
		const clip = (line: string) => truncateToWidth(line, Math.max(1, width));
		let all: TaskBoardRow[];
		let rows: TaskBoardRow[];
		let groups: ReturnType<typeof taskBoardGroups>;
		if (!this.boardStale && this.preparedBoard !== undefined) {
			all = this.preparedBoard.all;
			rows = this.preparedBoard.rows;
			groups = this.preparedBoard.groups;
			this.preparedBoard = undefined;
		} else {
			all = this.allRows();
			rows = this.boardRows(all);
			if (this.boardStale) this.refreshOrder(rows);
			groups = this.lastBoardGroups?.rows === rows ? this.lastBoardGroups.groups : taskBoardGroups(rows);
			this.preparedBoard = undefined;
		}
		const selected = this.selectedRow();
		if (selected !== undefined && this.peekId === selected.id) this.dropStaleReply(selected);
		const stopNotice = this.failureNotice ? "" : this.stopNotice();
		const notice = this.failureNotice || stopNotice || this.status;
		const counts = taskBoardCounts(all);
		const edge = theme.fg("borderMuted", "▔".repeat(Math.max(1, width)));
		const header = ` ${theme.bold("Tasks")}${counts ? `  ${theme.fg("muted", counts)}` : ""}`;
		const filterRow = this.filtering
			? [
					` ${theme.fg("accent", "⌕")} ${(this.filterInput.render(Math.max(1, width - 2))[0] ?? "").replace(/^> /, "")}`,
				]
			: this.filter
				? [theme.fg("muted", ` ⌕ ${taskDisplayText(this.filter)}`)]
				: [];
		const body: (string | TaskBoardRow)[] = [];
		let selectedLine = -1;
		let selectedEnd = -1;
		if (!all.length) body.push(theme.fg("muted", "   No background work. Subagents and shells appear here."));
		else if (!rows.length) body.push(theme.fg("muted", `   Nothing matches "${taskDisplayText(this.filter)}".`));
		for (const group of groups) {
			body.push(theme.fg("muted", theme.bold(`   ${group.title}`)));
			for (const sourceRow of group.rows) {
				const row = selected && sourceRow.id === selected.id ? selected : sourceRow;
				const isSelected = row.id === selected?.id;
				if (isSelected) selectedLine = body.length;
				body.push(row);
				if (isSelected && this.peekId === row.id) {
					const replyLines = this.sending
						? [theme.fg("muted", "Sending…")]
						: this.peekReplies(row)
							? [
									`${theme.fg("accent", "❯")} ${(this.reply.render(Math.max(1, width - 8))[0] ?? "").replace(/^> /, "")}`,
								]
							: [];
					body.push(
						...renderPeekCard(
							rowName(row),
							this.peekContent(row),
							replyLines,
							Math.max(10, width - 3),
							this.peekMaxLines(row, budget, notice),
						).map((line) => `   ${line}`),
					);
				}
				if (isSelected) selectedEnd = body.length - 1;
			}
		}
		const peekOpen = this.peekId !== undefined && this.peekId === selected?.id;
		const replying = peekOpen && selected !== undefined && this.peekReplies(selected);
		const head = [edge, clip(header), ...filterRow.map(clip)];
		const lineBudget = Math.max(1, budget);
		const minRoom = peekOpen ? 3 + (this.sending || replying ? 1 : 0) : 1;
		const footerLines = 1 + (notice ? 1 : 0);
		const shortViewport = lineBudget < head.length + footerLines + minRoom;
		const room = shortViewport
			? Math.max(1, lineBudget - (lineBudget >= 2 ? 1 : 0))
			: lineBudget - head.length - footerLines;
		const end = room === 1 && (this.sending || replying) ? selectedEnd - 1 : selectedEnd;
		const topNeeded =
			selectedLine > 0 && typeof body[selectedLine - 1] === "string" ? selectedLine - 1 : selectedLine;
		let start =
			selectedLine < 0
				? 0
				: keepSpanInView(this.currentBoardScroll(), topNeeded, selectedLine, end, room, body.length);
		if (replying && selected?.kind === "item") {
			const currentPrompt = promptAnswerOptionsOf(selected.item);
			const previousPrompt = this.paintedPrompts.get(selected.id);
			const questionLine = selectedLine + 2;
			if (
				currentPrompt !== undefined &&
				(previousPrompt === undefined || !samePromptOptions(previousPrompt, currentPrompt)) &&
				(questionLine < start || questionLine >= start + room)
			) {
				start = questionLine;
			}
		}
		this.selectionPhase = { kind: "browsing", scroll: start };
		const cardChoices = replying && selected !== undefined ? this.peekChoices(selected, budget, notice) : [];
		const firstChoiceLine = selectedLine + 3;
		const visibleChoices =
			firstChoiceLine >= start && firstChoiceLine < start + room
				? cardChoices.slice(0, Math.max(0, start + room - firstChoiceLine))
				: [];
		this.drawnChoices = replying ? visibleChoices : undefined;
		const replyValue = this.reply.getValue();
		const openNativeDetail = replying && selected?.kind === "task" && replyValue.trim() === "";
		const openNativeKeys = [
			...new Set(["enter", ...(getKeybindings().getKeys?.("app.list.open") ?? []).map(navKeyText)]),
		].join("/");
		const keys: NavKey[] = this.sending
			? [{ keys: escAndBack(), label: "close" }]
			: this.filtering
				? [
						{ keys: "↑↓", label: "select" },
						{ keys: "type", label: "filter" },
						{ keys: "enter", label: "done" },
						{ keys: "esc", label: "clear" },
					]
				: replying
					? [
							{ keys: "↑↓", label: "select" },
							...(replyValue === "" && visibleChoices.length
								? [{ keys: `1-${visibleChoices.length}`, label: "choose" }]
								: []),
							{ keys: openNativeDetail ? openNativeKeys : "enter", label: openNativeDetail ? "open" : "send" },
							{ keys: this.reply.getCursor() === 0 ? escAndBack() : "esc", label: "close" },
						]
					: listKeys()
							.filter(
								(key) =>
									selected !== undefined ||
									key.keys?.startsWith("esc") === true ||
									key.action === "app.keys.help" ||
									key.action === "app.list.filter",
							)
							.flatMap((key) => {
								if (key.action === "app.tasks.openWaited")
									return selected?.kind === "task" &&
										waitingReleasedShells(selected.task, this.store.ownerTasks ?? this.store.tasks).length > 0
										? [key]
										: [];
								if (key.action === "app.list.stop") {
									const finished =
										selected?.kind === "task"
											? selected.task.execution.kind === "settled" &&
												waitingReleasedTools(selected.task) === undefined
											: selected !== undefined && rowFinished(selected);
									return [{ ...key, label: finished ? "dismiss" : "stop" }];
								}
								const asking =
									!peekOpen && selected?.kind === "task" && selected.task.attention.kind === "input-needed";
								if (asking && key.action === "app.list.peek") return [];
								if (asking && key.action === "app.list.open") {
									const openKeys = [
										navActionText(getKeybindings(), "app.list.peek"),
										navActionText(getKeybindings(), "app.list.open"),
									];
									return [{ keys: openKeys.filter(Boolean).join("/"), label: "answer" }];
								}
								if (!peekOpen) return [key];
								if (key.action === "app.list.peek") return [];
								if (key.keys?.startsWith("esc") !== true) return [key];
								const peekKey = navActionText(getKeybindings(), "app.list.peek");
								return [{ ...key, keys: peekKey ? `${peekKey}/${key.keys}` : key.keys }];
							});
		const hint = renderNavHintLine(keys, width, style, getKeybindings(), 2, { compact: true });
		// A stop notice names its tasks sanitized already, and marks the key a click presses, which sanitizing drops.
		const noticeText = stopNotice ? stopNotice : taskDisplayText(notice);
		const boardNoticeLead = width >= 20 ? "  " : "";
		const footer = [
			...(notice
				? [
						`${boardNoticeLead}${theme.fg("warning", truncateToWidth(noticeText, Math.max(1, width - boardNoticeLead.length)))}`,
					]
				: []),
			hint,
		];
		const recordPaintedRow = (row: TaskBoardRow, drawnTasks: TaskRecord[]) => {
			if (row.kind === "item") {
				this.paintedItemFinished.set(row.id, rowFinished(row));
				const prompt = promptAnswerOptionsOf(row.item);
				if (prompt !== undefined) {
					const question = taskDisplayText(prompt.question ?? "").trim();
					const questionLine = body[selectedLine + 2];
					const shownCardLine =
						typeof questionLine === "string" ? stripVTControlCharacters(clip(questionLine)) : "";
					const cardPrefix = "   │ ";
					const shownQuestion = shownCardLine.startsWith(cardPrefix)
						? shownCardLine.slice(cardPrefix.length).trimStart()
						: "";
					const questionPrefix = truncateToWidth(question, 2, "");
					const questionInCard =
						peekOpen &&
						row.id === selected?.id &&
						selectedLine + 2 >= start &&
						selectedLine + 2 < start + room &&
						questionPrefix !== "" &&
						shownQuestion.startsWith(questionPrefix);
					const shownRow = stripVTControlCharacters(
						renderBoardRow(row, row.id === selected?.id, width - 1, modelOf(row)),
					);
					if (questionInCard || (question !== "" && shownRow.includes(question)))
						this.paintedPrompts.set(row.id, prompt);
				}
			} else {
				drawnTasks.push(row.task);
				if (this.peekReplies(row)) {
					this.paintedPrompts.set(row.id, taskReplyPrompt(row.task));
				}
			}
		};
		const slice = body.slice(start, start + room);
		// The rows as they are painted, with their live elapsed times: the model column is decided on those, once.
		const painted = slice.map((line) => (typeof line === "string" ? line : this.withBoardElapsed(line)));
		const paintedRows = painted.filter((line): line is TaskBoardRow => typeof line !== "string");
		// A row whose model became known while the board shows it waits for its reasoning level, so its task moves once.
		let models: Map<string, BoardRowModel> | undefined;
		// The widest label as the rows report it: a label still waiting for its level counts for whether any column fits.
		let widest = 0;
		if (width - 1 >= AGENT_PANEL_MODEL_MIN_WIDTH) {
			const reported = new Map(paintedRows.map((row) => [row.id, rowModel(row, this.store)] as const));
			for (const model of reported.values()) widest = Math.max(widest, model.width);
			const shown = this.modelColumn.paint(
				paintedRows.map(
					(row) => [row.id, rowModelReport(row, reported.get(row.id) ?? NO_MODEL, this.store)] as const,
				),
				all,
			);
			models = new Map(
				paintedRows.map((row) => [row.id, shown.has(row.id) ? (reported.get(row.id) ?? NO_MODEL) : NO_MODEL]),
			);
		} else this.modelColumn.forget();
		let measured = 0;
		for (const model of models?.values() ?? []) measured = Math.max(measured, model.width);
		const modelColumn = this.modelColumn.column(width - 1, measured, boardModelFits(paintedRows, width - 1), widest);
		const modelOf = (row: TaskBoardRow) =>
			modelColumn === 0
				? undefined
				: { column: modelColumn, cell: models?.get(row.id) ?? rowModel(row, this.store) };
		const previousSelectedPrompt = selected !== undefined ? this.paintedPrompts.get(selected.id) : undefined;
		this.paintedPrompts.clear();
		const drawnTasks: TaskRecord[] = [];
		let selectedRecorded = false;
		for (const line of slice) {
			if (typeof line !== "string") {
				if (line.id === selected?.id) selectedRecorded = true;
				recordPaintedRow(line, drawnTasks);
			}
		}
		const questionLine = selectedLine + 2;
		if (peekOpen && selected !== undefined && !selectedRecorded) {
			if (questionLine >= start && questionLine < start + room) {
				recordPaintedRow(selected, drawnTasks);
			} else if (selected.kind === "item" && previousSelectedPrompt !== undefined) {
				const currentPrompt = promptAnswerOptionsOf(selected.item);
				if (currentPrompt !== undefined && samePromptOptions(previousSelectedPrompt, currentPrompt)) {
					this.paintedPrompts.set(selected.id, previousSelectedPrompt);
				}
			} else if (selected.kind === "task" && previousSelectedPrompt !== undefined && this.peekReplies(selected)) {
				this.paintedPrompts.set(selected.id, previousSelectedPrompt);
			}
		}
		this.navigation.paint(drawnTasks);
		const windowRowIds = painted.map((line) => (typeof line === "string" ? undefined : line.id));
		const renderedWindow = painted.map((line) =>
			clip(
				typeof line === "string"
					? line
					: ` ${renderBoardRow(line, line.id === selected?.id, width - 1, modelOf(line))}`,
			),
		);
		const paintedRowsById = new Map(paintedRows.map((row) => [row.id, row]));
		if (shortViewport) {
			const shortHint = lineBudget >= 2 ? footer.slice(-1) : [];
			this.paintedBoard = {
				rowsByLine: [...windowRowIds, ...shortHint.map(() => undefined)].slice(0, lineBudget),
				rowsById: paintedRowsById,
			};
			return [...renderedWindow, ...shortHint].slice(0, lineBudget);
		}
		this.paintedBoard = {
			rowsByLine: [...head.map(() => undefined), ...windowRowIds, ...footer.map(() => undefined)],
			rowsById: paintedRowsById,
		};
		return [...head, ...renderedWindow, ...footer];
	}
	private renderAll(width: number): string[] {
		const task = this.selected();
		if (!task) return [];
		return [
			...new TaskDetail(task, {
				...this.detailContent,
				stdinAvailable: this.stdinAvailable(),
				tasks: this.store.ownerTasks ?? this.store.tasks,
				activity: this.store.recentActivity(task.ref.taskId),
				activityOmitted: this.store.activityOmitted(task.ref.taskId),
			}).renderContent(width),
			taskDisplayText(this.status),
		];
	}
}

export { wrapNotes };
