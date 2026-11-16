import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	getKeybindings,
	Input,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@bastani/atomic-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { PromptRoute, TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import { liveElapsedMs } from "../../../core/tasks/live-elapsed.ts";
import { OwnerTaskStore } from "../../../core/tasks/owner-store.js";
import { ownerTaskViewSource, type TaskViewSource } from "../../../core/tasks/task-view-source.js";
import { theme } from "../theme/theme.js";
import { parseWheelReport } from "./chat-transcript.js";
import { renderExtensionStatusRow } from "./footer.ts";
import {
	isNavHelpKey,
	NAV_CONFIRM_WINDOW_MS,
	type NavKey,
	navActionText,
	renderNavHintLine,
	renderNavKeyOverlay,
} from "./nav-keys.ts";
import {
	type PeekContent,
	renderBoardRow,
	renderPeekCard,
	rowFinished,
	rowMatches,
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
	TaskAgentTranscriptPage,
	TaskCommandOutputPage,
	type TaskTranscriptEnvironment,
	type TaskTranscriptPage,
} from "./task-transcript-page.ts";

const DETAIL_WHEEL_ROWS = 4;

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
		{ keys: "↑↓", label: "select" },
		{ action: "app.list.peek", label: "peek" },
		{ action: "app.list.open", label: "open" },
		{ action: "app.list.stop", label: "stop" },
		{ action: "app.list.filter", label: "filter" },
		{ keys: escAndBack(), label: "back" },
		{ action: "app.keys.help", label: "keys" },
	];
}
/**
 * How long after a reply is sent from a peek card an Enter is still taken as part of that send: long enough for a
 * double press, short enough that a deliberate Enter on the row afterwards opens it.
 */
export const REPLY_ENTER_GUARD_MS = 300;
/** Another source's rows in /tasks, such as workflow runs, with what its keys do to them. */
export type TaskBoardSource = {
	items(): readonly TaskBoardItem[];
	subscribe(listener: () => void): () => void;
	open?(id: string, options?: { readonly onReturn?: () => void }): void;
	stop?(id: string): Promise<{ ok: true } | { ok: false; reason: string }>;
	answer?(id: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }>;
	/** Records an `x` dismissal of a finished row (`task:<id>` for a task), so every view of the source leaves it out. */
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
/** A task's chat: ← goes back one level, Esc only interrupts. */
export function taskChatKeys(back: string, interruptible: boolean): NavKey[] {
	return [
		{ action: "app.nav.back", label: back },
		...(interruptible ? [{ keys: "esc", label: "interrupt" }] : []),
		{ keys: "pgup/pgdn", label: "scroll" },
		{ action: "app.tools.expand", label: "expand" },
		{ action: "app.keys.help", label: "keys" },
	];
}
const TASK_CHAT_OVERLAY_KEYS: readonly NavKey[] = [
	{ keys: "enter", label: "send the prompt to the agent" },
	{ action: "app.nav.back", label: "back, on an empty prompt" },
	{ keys: "esc", label: "interrupt the agent's turn" },
	{ keys: "pgup/pgdn", label: "scroll" },
	{ action: "tui.altScreen.top", label: "jump to the top" },
	{ action: "tui.altScreen.bottom", label: "jump to the latest message" },
	{ action: "app.tools.expand", label: "expand tool output" },
	{ action: "app.thinking.toggle", label: "show or hide thinking" },
	{ action: "app.agents.chord", label: "then the stop-all key: stop all background work" },
];

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
	/** The inspector closed by going back one level (← or ↓ in a chat opened by the caller), not by Ctrl+C. */
	closedByBack = false;
	/** What ← from a chat opened by the caller names, such as `main chat`. */
	private callerLabel = "back";
	/** Typed shell input per task, kept when the reader leaves the input and restored when they return. */
	private readonly inputDrafts = new Map<TaskId, string>();
	/** The open transcript of the selected task, on the shared chat stack. */
	private transcript?: TaskTranscriptPage;
	private status = "";
	/** Why the last stop did not reach its task; shown under the list until the next key. */
	/** A failure shown once on the task pages, until the next key. */
	private failureNotice = "";
	private scroll = 0;
	private detailContent: Omit<TaskDetailContent, "stdinAvailable"> = {};
	private detailTaskId?: TaskId;
	private detailGeneration = 0;
	private disposed = false;
	private statusWatch?: { taskId: TaskId; release: () => void };
	private readonly input = new Input();
	/** The selected row's peek card is open (Space), with a reply input when the row waits on an answer. */
	private peekId?: string;
	private readonly reply = new Input();
	/** `/` filter text, and whether keys are typing into it. */
	private filter = "";
	private filtering = false;
	private readonly filterInput = new Input();
	/** Rows other sources list, such as workflow runs, and what their keys do. */
	private boardSource?: TaskBoardSource;
	private releaseBoardSource?: () => void;
	/** Items dismissed with `x` after they finished, so the list leaves them out. */
	private readonly dismissedItems = new Set<string>();
	/** Typed peek-card replies per row, kept when the card closes and restored when it reopens. */
	private readonly replyDrafts = new Map<string, string>();
	/** A reply being sent: Enter waits for it instead of sending again or reaching the list. */
	private sending = false;
	/** When the last reply was sent; an Enter within {@link REPLY_ENTER_GUARD_MS} of it reaches nothing. */
	private sentAt = Number.NEGATIVE_INFINITY;
	/** A source's row that finished while its stop was armed: the next stop press only acknowledges it. */
	private itemFinishedWhileArmed?: { readonly id: string; readonly name: string };
	/** Reopens /tasks on a row, for the way back from a view a row opened, such as a run's graph. */
	private reopen?: (id: string) => void;
	/** Whether the reader or the caller has chosen a row, so new rows from a source don't move the selection. */
	private selectionChosen = false;
	private rowsById = new Map<string, TaskBoardRow>();
	private taskSections?: TaskListSection[];
	private tasksById = new Map<TaskId, TaskRecord>();
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
		this.requestRender = privateRender;
		this.close = privateClose;
		this.transcriptEnvironment = transcriptEnvironment;
		this.navigation = new TaskNavigation(getKeybindings() as KeybindingsManager, {
			inspect: () => {
				this.closeTranscript();
				this.actionIndex = 0;
				this.scroll = 0;
				void this.loadDetail();
			},
			openChat: () => {
				this.chatFrom = "list";
				this.detailGeneration++;
				this.openTranscript();
				// A task with no chat here (no transcript in this host) stays on its detail page.
				if (this.transcript === undefined) void this.loadDetail();
			},
			transcript: () => {
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
				this.refreshOrder();
				if (this.navigation.focus.kind === "detail") this.navigation.focus = { kind: "tasks" };
				this.requestRender();
			},
			cancel: (task) => {
				void this.store.cancelTask(task.ref.taskId).then((result) => {
					// A stop that did not reach the task says so, instead of leaving it looking untouched.
					this.failureNotice = result.ok ? "" : `Could not stop the task: ${result.error.message}`;
					this.requestRender();
				});
			},
			stdinAvailable: (task) => this.store.stdinAvailable(task.ref.taskId),
			input: (task) => {
				this.input.setValue(this.inputDrafts.get(task.ref.taskId) ?? "");
			},
			openQuestion: (route) => {
				if (openQuestion) {
					this.close();
					openQuestion(route);
				} else this.status = "Question is available in its owning session.";
			},
		});
		this.unsubscribe = this.store.subscribe(() => {
			this.taskSections = undefined;
			this.refreshOrder();
			if (this.transcript) this.transcript.refresh();
			else if (this.navigation.focus.kind === "detail") void this.loadDetail();
			this.requestRender();
		});
		this.refreshOrder();
		this.navigation.open();
		this.input.onSubmit = (text) => {
			void this.sendInput(text);
		};
	}
	private readonly store: TaskViewSource;
	private readonly requestRender: () => void;
	private readonly close: () => void;
	open(id?: TaskId): void {
		if (id !== undefined) this.selectionChosen = true;
		this.navigation.open(id);
	}
	/**
	 * Opens a task's chat directly, as Enter on its agent-panel row does: ← on its empty prompt closes the inspector,
	 * one level back to `backLabel`, instead of showing the task's list or detail page.
	 */
	openChat(id: TaskId, backLabel = "main chat"): void {
		this.selectionChosen = true;
		this.navigation.open(id);
		if (this.navigation.selectedTaskId !== id) return;
		this.chatFrom = "caller";
		this.callerLabel = backLabel;
		this.navigation.focus = { kind: "detail" };
		this.openTranscript();
	}
	/**
	 * Lists another source's rows, such as workflow runs, beside the task store's. Its changes repaint the list. Returns
	 * a disposer.
	 */
	setBoardSource(source: TaskBoardSource | undefined): () => void {
		this.releaseBoardSource?.();
		this.boardSource = source;
		this.releaseBoardSource = source?.subscribe(() => {
			this.refreshOrder();
			this.requestRender();
		});
		this.refreshOrder();
		// Until the reader picks a row, the list starts on its first row, which may now be another source's waiting run.
		const first = this.boardRows()[0];
		if (!this.selectionChosen && first !== undefined) this.navigation.select(first.id);
		this.requestRender();
		return () => {
			if (this.boardSource !== source) return;
			this.releaseBoardSource?.();
			this.releaseBoardSource = undefined;
			this.boardSource = undefined;
			this.refreshOrder();
		};
	}
	/** Every row /tasks lists, before grouping: the store's tasks, then other sources' items, less dismissed ones. */
	private allRows(): TaskBoardRow[] {
		const tasks: TaskBoardRow[] = this.orderedSections()
			.flatMap((section) => section.tasks)
			.map((task) => ({ id: task.ref.taskId, kind: "task", task }));
		const items: TaskBoardRow[] = (this.boardSource?.items() ?? [])
			.filter((item) => !this.dismissedItems.has(item.id))
			.map((item) => ({ id: item.id, kind: "item", item }));
		return [...tasks, ...items];
	}
	/** The rows the list shows, grouped Needs input, Working, Done, after the `/` filter. */
	private boardRows(all = this.allRows()): TaskBoardRow[] {
		const rows = taskBoardGroups(all.filter((row) => rowMatches(row, this.filter))).flatMap((group) => group.rows);
		this.rowsById = new Map(rows.map((row) => [row.id, row]));
		return rows;
	}
	private refreshOrder(): void {
		const rows = this.boardRows();
		const tasks = this.orderedSections().flatMap((section) => section.tasks);
		this.navigation.update(
			tasks,
			rows.map((row) => row.id),
		);
		if (this.peekId !== undefined && !rows.some((row) => row.id === this.peekId)) this.closePeek();
		// A source's row that finishes while its stop is armed is disarmed, as a task is, so the second press can't
		// dismiss a result nobody has seen.
		const armed = this.navigation.stopConfirm.pending();
		const finished = rows.find((row) => row.kind === "item" && row.id === armed && rowFinished(row));
		if (finished !== undefined) {
			this.navigation.stopConfirm.reset();
			this.itemFinishedWhileArmed = { id: finished.id, name: rowName(finished) };
		}
	}
	private selectedRow(): TaskBoardRow | undefined {
		const id = this.navigation.selectedId;
		const row = id === undefined ? undefined : this.rowsById.get(id);
		return row === undefined ? undefined : this.withBoardElapsed(row);
	}
	/** Closes the peek card, keeping a typed reply for when it opens again unless it was sent. */
	private closePeek(sent = false): void {
		if (this.peekId !== undefined) {
			const draft = this.reply.getValue();
			if (draft && !sent) this.replyDrafts.set(this.peekId, draft);
			else this.replyDrafts.delete(this.peekId);
		}
		this.peekId = undefined;
		this.reply.setValue("");
	}
	/** How /tasks reopens on a row when the reader comes back from the view that row opened. */
	setReopen(reopen: ((id: string) => void) | undefined): void {
		this.reopen = reopen;
	}
	private orderedSections(): TaskListSection[] {
		const dismissed = dismissedTasks(this.store);
		if (this.taskSections === undefined) {
			const tasks = this.store.backgroundTasks;
			this.tasksById = new Map(tasks.map((task) => [task.ref.taskId, task]));
			for (const task of tasks)
				if (!dismissed.has(task.ref.taskId))
					liveElapsedMs(task.ref.taskId, task.metrics?.elapsedMs, task.execution.kind === "running");
			this.taskSections = taskListSections(tasks, this.store.settlementOrder);
		}
		return this.taskSections
			.map((section) => ({ ...section, tasks: section.tasks.filter((task) => !dismissed.has(task.ref.taskId)) }))
			.filter((section) => section.tasks.length > 0);
	}
	dispose(): void {
		this.disposed = true;
		this.releaseBoardSource?.();
		this.releaseStatusWatch();
		this.closeTranscript();
		this.unsubscribe();
	}
	invalidate(): void {
		this.transcript?.invalidate();
	}
	private selected() {
		const id = this.navigation.selectedTaskId;
		return id === undefined ? undefined : this.tasksById.get(id);
	}
	private stdinAvailable(): boolean {
		const task = this.selected();
		if (!task || task.execution.kind === "settled") return false;
		return this.store.stdinAvailable(task.ref.taskId);
	}
	private async sendInput(text: string): Promise<void> {
		const task = this.selected();
		if (!task) return;
		const result = await this.store.writeTaskInput(task.ref.taskId, text);
		this.status = result.ok ? `Sent ${result.value.acceptedBytes} bytes` : result.error.message;
		if (result.ok) {
			this.input.setValue("");
			this.inputDrafts.delete(task.ref.taskId);
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
			this.status = "Transcript inspection is unavailable in this host.";
			this.requestRender();
			return;
		} else
			this.transcript = new TaskAgentTranscriptPage(
				this.store,
				task.ref.taskId,
				environment,
				this.requestRender,
				(reason) => this.reportLate(reason, environment),
			);
		this.requestRender();
		void this.transcript.load();
	}
	/** A transcript's message failed after the reader left it: on the task pages if they are open, else through the host. */
	private reportLate(reason: string, environment: TaskTranscriptEnvironment): void {
		if (this.disposed) {
			environment.notify?.(reason);
			return;
		}
		this.failureNotice = reason;
		this.requestRender();
	}
	private closeTranscript(): void {
		this.transcript?.dispose();
		this.transcript = undefined;
	}
	private async loadDetail(): Promise<void> {
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
		const read = this.store.taskDetailText(task.ref.taskId);
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
				} else this.status = output.error.message;
			} catch {
				if (!current()) return;
				this.status = "Command output unavailable";
			}
		}
		if (current()) this.requestRender();
	}
	/** Every key belongs to the inspector except the host's thinking toggle when it leaves that alone. */
	handleInput(data: string): boolean {
		this.selectionChosen = true;
		return this.route(data) || !isHostThinkingToggle(data);
	}
	private route(data: string): boolean {
		this.failureNotice = "";
		// The finished-while-armed notice stays through the stop key's presses and leaves with any other key.
		if (!getKeybindings().matches(data, "app.list.stop")) {
			this.navigation.finishedWhileArmed = undefined;
			this.itemFinishedWhileArmed = undefined;
		}
		if (this.helpOpen) {
			// The overlay is a dialog: Esc or `?` closes it, and other keys wait until it is closed.
			if (matchesKey(data, "escape") || isNavHelpKey(getKeybindings(), data)) this.helpOpen = false;
			this.requestRender();
			return true;
		}
		if (this.transcript) return this.handleTranscriptInput(data, this.transcript);
		if (this.navigation.focus.kind !== "stdin" && isNavHelpKey(getKeybindings(), data)) {
			this.helpOpen = true;
			this.requestRender();
			return true;
		}
		if (!getKeybindings().matches(data, "app.list.stop")) this.navigation.stopConfirm.reset();
		const wheel = parseWheelReport(data);
		if (wheel !== undefined) {
			if (this.navigation.focus.kind === "tasks") this.navigation.moveSelection(wheel.direction);
			else if (this.navigation.focus.kind === "detail")
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
			if (getKeybindings().matches(data, "app.nav.back") && this.input.getCursor() === 0) {
				this.navigation.focus = { kind: "tasks" };
				this.requestRender();
				return true;
			}
			this.input.handleInput(data);
			this.inputDrafts.set(focus.taskId, this.input.getValue());
			this.requestRender();
			return true;
		}
		if (focus.kind === "tasks" && this.handleBoardInput(data)) {
			this.requestRender();
			return true;
		}
		if (
			matchesKey(data, "escape") ||
			(getKeybindings().matches(data, "app.nav.back") && !this.configuredTaskKey(data))
		) {
			this.navigation.handleInput("\x1b", "tasks");
			if (this.navigation.focus.kind === "composer") this.close();
			this.requestRender();
			return true;
		}
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
			else if (!this.navigation.handleInput(data, "tasks")) return false;
		} else if (!this.navigation.handleInput(data, "tasks")) return false;
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
		// ← on an empty prompt, or at the start of a typed one (kept for the return), goes back one level.
		if (keys.matches(data, "app.nav.back") && transcript.cursorAtStart()) {
			if (this.chatFrom === "caller") {
				this.closedByBack = true;
				this.close();
				return true;
			}
			this.closeTranscript();
			this.detailGeneration++;
			this.scroll = 0;
			if (this.chatFrom === "list") this.navigation.focus = { kind: "tasks" };
			else void this.loadDetail();
			this.requestRender();
			return true;
		}
		// Opened from the agent panel, ↓ on an empty prompt goes to the panel too, as it does from the main chat.
		if (this.chatFrom === "caller" && keys.matches(data, "app.agents.focus") && !transcript.hasDraft()) {
			this.closedByBack = true;
			this.close();
			return true;
		}
		if (isNavHelpKey(keys, data) && !transcript.hasDraft()) {
			this.helpOpen = true;
			this.requestRender();
			return true;
		}
		if (matchesKey(data, "escape")) {
			if (transcript.interruptible()) void this.interruptTranscript(transcript);
			this.requestRender();
			return true;
		}
		return transcript.handleInput(data);
	}
	/**
	 * The list's own keys: the `/` filter, the Space peek card and its reply, and the keys of rows other sources list.
	 * Returns false for keys the task navigation handles.
	 */
	private handleBoardInput(data: string): boolean {
		const keys = getKeybindings();
		// A one-off notice, such as "Sent to …", lasts until the next key.
		this.status = "";
		if (this.filtering) {
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
			this.refreshOrder();
			return true;
		}
		if (matchesKey(data, "enter") && Date.now() - this.sentAt < REPLY_ENTER_GUARD_MS) return true;
		const row = this.selectedRow();
		if (this.peekId !== undefined && row?.id === this.peekId) {
			const replying = this.peekReplies(row);
			if (matchesKey(data, "escape")) {
				this.closePeek();
				return true;
			}
			if (keys.matches(data, "app.list.peek") && !replying) {
				this.closePeek();
				return true;
			}
			if (replying) {
				// ← on an empty reply, or at the start of a typed one (kept for next time), closes the card.
				if (keys.matches(data, "app.nav.back") && this.reply.getCursor() === 0) {
					this.closePeek();
					return true;
				}
				if (matchesKey(data, "enter")) {
					if (!this.sending) void this.sendReply(row);
					return true;
				}
				if (this.sending) return true;
				const choice =
					/^[1-9]$/.test(data) && this.reply.getValue() === ""
						? this.peekChoices(row)[Number(data) - 1]
						: undefined;
				if (choice !== undefined) {
					for (const char of choice) this.reply.handleInput(char);
					return true;
				}
				if (!matchesKey(data, "up") && !matchesKey(data, "down")) {
					this.reply.handleInput(data);
					return true;
				}
			}
			if (matchesKey(data, "up") || matchesKey(data, "down")) this.closePeek();
		}
		if (keys.matches(data, "app.list.filter")) {
			this.filtering = true;
			this.filterInput.setValue(this.filter);
			return true;
		}
		// Space peeks in a card under the row at a workflow run, or at a row waiting for an answer, which the card
		// takes. A task's peek otherwise is its detail page, which the task navigation opens.
		if (keys.matches(data, "app.list.peek") && row !== undefined && this.peeksInCard(row)) {
			this.peekId = row.id;
			this.reply.setValue("");
			for (const char of this.replyDrafts.get(row.id) ?? "") this.reply.handleInput(char);
			return true;
		}
		if (row?.kind !== "item") return false;
		if (keys.matches(data, "app.list.open")) {
			if (this.boardSource?.open) {
				this.close();
				const reopen = this.reopen;
				this.boardSource.open(row.id, reopen ? { onReturn: () => reopen(row.id) } : undefined);
			} else this.status = "This item can't be opened from here.";
			return true;
		}
		if (keys.matches(data, "app.list.stop")) {
			if (rowFinished(row) && this.itemFinishedWhileArmed?.id === row.id) {
				// The press meant for the stop: it acknowledges the finished notice, and a later press dismisses.
				this.itemFinishedWhileArmed = undefined;
			} else if (rowFinished(row)) {
				this.dismissedItems.add(row.id);
				this.boardSource?.dismiss?.(row.id);
				this.refreshOrder();
			} else if (this.navigation.stopConfirm.press(row.id as TaskId)) void this.stopItem(row);
			else {
				this.requestRender();
				const timer = setTimeout(() => this.requestRender(), NAV_CONFIRM_WINDOW_MS + 50);
				timer.unref?.();
			}
			return true;
		}
		return false;
	}
	private peeksInCard(row: TaskBoardRow): boolean {
		return row.kind === "item" || rowState(row) === "input";
	}
	/** A peek card takes a reply when its row waits on an answer this view can send. */
	private peekReplies(row: TaskBoardRow): boolean {
		return rowState(row) === "input" && this.boardSource?.answer !== undefined;
	}
	private peekChoices(row: TaskBoardRow): readonly string[] {
		return row.kind === "item" ? (row.item.choices ?? []) : [];
	}
	private async sendReply(row: TaskBoardRow): Promise<void> {
		const text = this.reply.getValue().trim();
		if (!text || !this.boardSource?.answer) return;
		const id = row.kind === "item" ? row.id : `task:${row.task.ref.taskId}`;
		this.sending = true;
		this.requestRender();
		try {
			const result = await this.boardSource.answer(id, text);
			if (result.ok) {
				this.sentAt = Date.now();
				this.closePeek(true);
				this.status = `Sent to ${rowName(row)}`;
			} else this.failureNotice = `Could not send the answer: ${result.reason}`;
		} finally {
			this.sending = false;
			this.requestRender();
		}
	}
	private async stopItem(row: Extract<TaskBoardRow, { kind: "item" }>): Promise<void> {
		if (!this.boardSource?.stop) {
			this.failureNotice = "This item can't be stopped from here.";
			this.requestRender();
			return;
		}
		const result = await this.boardSource.stop(row.id);
		this.failureNotice = result.ok ? "" : `Could not stop ${rowName(row)}: ${result.reason}`;
		this.requestRender();
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
		if (task.attention.kind === "input-needed") return { question: task.attention.prompt, lines: [] };
		const action =
			task.execution.kind !== "settled" && task.currentAction
				? [`${task.currentAction.tool} ${task.currentAction.text}`]
				: [];
		const metrics = taskMetricsText(task);
		return { lines: [...action, ...(metrics ? [metrics] : [])] };
	}
	private async interruptTranscript(transcript: TaskTranscriptPage): Promise<void> {
		const result = await transcript.interrupt();
		if (!result.ok) this.failureNotice = result.error.message;
		this.requestRender();
	}
	private configuredTaskKey(data: string): boolean {
		return (["app.list.open", "app.list.stop", "app.tasks.input"] as const).some((key) =>
			getKeybindings().matches(data, key),
		);
	}
	/** Only the task picker stays inline; drill-down owns the screen. */
	get fullscreen(): boolean {
		return this.navigation.focus.kind === "detail" || this.navigation.focus.kind === "stdin";
	}
	/** The waiting first press of `x`, as the line under the list shows it. */
	/** A running task's elapsed time advances between its own reports, on the clock every view shares. */
	private withLiveElapsed(task: TaskRecord): TaskRecord {
		const elapsedMs = liveElapsedMs(task.ref.taskId, task.metrics?.elapsedMs, task.execution.kind === "running");
		if (elapsedMs === undefined) return task;
		return { ...task, metrics: { ...task.metrics, elapsedMs } };
	}
	private withBoardElapsed(row: TaskBoardRow): TaskBoardRow {
		return row.kind === "task" ? { ...row, task: this.withLiveElapsed(row.task) } : row;
	}
	private stopNotice(): string {
		if (this.itemFinishedWhileArmed !== undefined) {
			const key = getKeybindings().getKeys("app.list.stop")[0] ?? "x";
			return `${this.itemFinishedWhileArmed.name} finished · ${key} to dismiss`;
		}
		const finished = this.navigation.finishedWhileArmed;
		if (finished !== undefined) {
			const key = getKeybindings().getKeys("app.list.stop")[0] ?? "x";
			return `${taskDisplayText(finished.title || taskLabel(finished))} finished · ${key} to dismiss`;
		}
		const pending = this.navigation.stopConfirm.pending();
		if (pending === undefined) return "";
		const row = this.rowsById.get(pending);
		const task = this.tasksById.get(pending as TaskId);
		const key = getKeybindings().getKeys("app.list.stop")[0] ?? "x";
		const name = task ? taskDisplayText(task.title || taskLabel(task)) : row ? rowName(row) : "the task";
		return `Press ${key} again within 3s to stop ${name}`;
	}
	renderPicker(width: number, availableRows: number): string[] {
		return this.renderViewport(width, Math.max(1, Math.min(12, availableRows)));
	}
	render(width: number): string[] {
		return this.renderViewport(width, Math.max(3, (process.stdout.rows || 24) - 5));
	}
	private renderTranscriptPage(width: number, budget: number, transcript: TaskTranscriptPage): string[] {
		const task = this.selected();
		const fitWidth = (line: string) => truncateToWidth(line, Math.max(1, width));
		// Opened from the agent panel, a subagent's chat is named by its composer's rule; the page needs no title.
		const header =
			this.chatFrom === "caller" && task?.kind === "agent"
				? []
				: [
						theme.bold(`Transcript · ${task ? taskDisplayText(taskLabel(task)) : "Task"}`),
						task ? taskDetailSummary(task) : "",
						theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
					].map(fitWidth);
		const notes = [transcript.status, this.status].filter(Boolean).join(" · ");
		const style = themedNavKeyStyle();
		if (this.helpOpen)
			return [
				...header,
				...renderNavKeyOverlay("keys · task chat", TASK_CHAT_OVERLAY_KEYS, width, style, getKeybindings()),
			].slice(0, Math.max(1, budget));
		const back = this.chatFrom === "caller" ? this.callerLabel : this.chatFrom === "list" ? "tasks" : "task";
		const chatKeys = taskChatKeys(back, transcript.interruptible());
		// From the agent panel, ↓ returns there as well.
		if (this.chatFrom === "caller" && back === "agents")
			chatKeys.splice(1, 0, { action: "app.agents.focus", label: "agents" });
		const hint = renderNavHintLine(chatKeys, width, style, getKeybindings());
		const footer = [...(notes ? [fitWidth(theme.fg("dim", notes))] : []), hint];
		const failure = this.failureNotice ? [fitWidth(theme.fg("warning", this.failureNotice))] : [];
		const statusRows = this.taskStatusRows(width);
		const room = Math.max(1, budget - header.length - footer.length - failure.length - statusRows.length);
		const body = transcript.render(width, room);
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
		if (this.transcript && this.navigation.focus.kind === "detail")
			return this.renderTranscriptPage(width, budget, this.transcript);
		const style = themedNavKeyStyle();
		if (this.helpOpen) {
			const detailOpen = this.navigation.focus.kind === "detail";
			return renderNavKeyOverlay(
				detailOpen ? "keys · task" : "keys · tasks",
				detailOpen ? detailKeys() : listKeys(),
				width,
				style,
				getKeybindings(),
			).slice(-Math.max(1, budget));
		}
		if (this.navigation.focus.kind === "tasks") return this.renderBoard(width, budget);
		const framed = width >= 20 && budget >= 7;
		const inner = Math.max(1, width - (framed ? 4 : 0));
		const current = this.selected();
		const detail = this.navigation.focus.kind === "detail";
		const selectingAction = current && detail && !this.transcript;
		const actions = selectingAction
			? taskDetailActions(current.execution, current.attention, this.stdinAvailable())
			: [];
		this.actionIndex = Math.max(0, Math.min(this.actionIndex, actions.length - 1));
		const action = actions[this.actionIndex];
		const actionRow = action ? [theme.fg("accent", `› ${taskDetailLabels[action]}`)] : [];
		const rows = this.renderAll(inner);
		const compactSummary = !framed && detail && current && budget >= 4 ? [taskDetailSummary(current)] : [];
		const statusRows = this.taskStatusRows(width);
		const height = Math.max(
			0,
			budget - (framed ? 4 : 1) - actionRow.length - compactSummary.length - statusRows.length,
		);
		const selected = detail ? -1 : rows.findIndex((row) => stripVTControlCharacters(row).startsWith("›"));
		this.scroll = Math.min(this.scroll, Math.max(0, rows.length - height));
		const selectionRows = Math.min(height, current?.kind === "agent" ? 3 : 2);
		const offset = detail ? this.scroll : Math.max(0, selected + selectionRows - height);
		const view = rows.slice(offset, offset + height);
		const stopLabel = current?.execution.kind === "settled" ? "dismiss" : "stop";
		const keys =
			this.navigation.focus.kind === "stdin"
				? [
						{ keys: "enter", label: "send" },
						{ action: "app.nav.back", label: "back to list" },
					]
				: (detail ? detailKeys() : listKeys())
						// An empty list has nothing to select, open or stop.
						.filter(
							(key) =>
								current !== undefined || key.keys?.startsWith("esc") === true || key.action === "app.keys.help",
						)
						.map((key) => (key.action === "app.list.stop" ? { ...key, label: stopLabel } : key));
		const footer = renderNavHintLine(keys, width, style, getKeybindings());
		const notice = this.failureNotice || this.stopNotice();
		const failure = notice ? [theme.fg("warning", truncateToWidth(notice, width))] : [];
		if (!framed)
			return [...compactSummary, ...view, ...actionRow, footer, ...failure, ...statusRows]
				.map((line) => truncateToWidth(line, width))
				.slice(-Math.max(1, budget));
		const live = this.store.backgroundTasks.filter((task) => task.execution.kind !== "settled").length;
		const title =
			detail && current
				? `${taskDisplayText(taskLabel(current))} › ${taskDisplayText(current.title)}`
				: "Background tasks";
		const heading = ` ${truncateToWidth(title, Math.max(1, width - 5))} `;
		const border = (text: string) => theme.fg("borderMuted", text);
		const frameRow = (line: string) => {
			const text = truncateToWidth(line, inner);
			return border("│ ") + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + border(" │");
		};
		return [
			border("╭─") + theme.bold(heading) + border(`${"─".repeat(Math.max(0, width - visibleWidth(heading) - 3))}╮`),
			frameRow(
				detail && current
					? taskDetailSummary(current)
					: theme.fg("muted", `${live} active · ${this.store.backgroundTasks.length} total`),
			),
			...view.map(frameRow),
			...actionRow.map(frameRow),
			border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
			footer,
			...failure,
			...statusRows,
		].map((line) => truncateToWidth(line, width));
	}
	/**
	 * The /tasks sheet: a `▔` top edge, `Tasks` with its counts, the Needs input, Working and Done groups, the selected
	 * row's peek card under it, and one hint line with the list's live keys.
	 */
	private renderBoard(width: number, budget: number): string[] {
		const style = themedNavKeyStyle();
		const clip = (line: string) => truncateToWidth(line, Math.max(1, width));
		const all = this.allRows();
		const rows = this.boardRows(all);
		const selected = this.selectedRow();
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
		if (!all.length)
			body.push(theme.fg("muted", "   No background work. Subagents, shells and workflow runs appear here."));
		else if (!rows.length) body.push(theme.fg("muted", `   Nothing matches "${taskDisplayText(this.filter)}".`));
		for (const group of taskBoardGroups(rows)) {
			body.push(theme.fg("muted", theme.bold(`   ${group.title}`)));
			for (const sourceRow of group.rows) {
				const row = selected && sourceRow.id === selected.id ? selected : sourceRow;
				const isSelected = row.id === selected?.id;
				if (isSelected) selectedLine = body.length;
				body.push(row);
				// The selected agent's model and what it is doing now, on a dim line under its row.
				if (isSelected && this.peekId !== row.id && row.kind === "task" && row.task.kind === "agent") {
					const live = row.task.execution.kind !== "settled" && row.task.currentAction;
					const detail = [
						taskModelText(row.task),
						live ? `${taskDisplayText(live.tool)} ${taskDisplayText(live.text)}` : "",
					]
						.filter(Boolean)
						.join(" · ");
					if (detail) body.push(theme.fg("dim", `      ${detail}`));
				}
				if (isSelected && this.peekId === row.id) {
					const replyLines = this.sending
						? [theme.fg("muted", "Sending…")]
						: this.peekReplies(row)
							? [
									`${theme.fg("accent", "❯")} ${(this.reply.render(Math.max(1, width - 8))[0] ?? "").replace(/^> /, "")}`,
								]
							: [];
					body.push(
						...renderPeekCard(rowName(row), this.peekContent(row), replyLines, Math.max(10, width - 3)).map(
							(line) => `   ${line}`,
						),
					);
				}
			}
		}
		const peekOpen = this.peekId !== undefined && this.peekId === selected?.id;
		const replying = peekOpen && selected !== undefined && this.peekReplies(selected);
		const keys: NavKey[] = this.filtering
			? [
					{ keys: "type", label: "filter" },
					{ keys: "enter", label: "done" },
					{ keys: "esc", label: "clear" },
				]
			: replying
				? [
						...(this.peekChoices(selected).length
							? [{ keys: `1-${this.peekChoices(selected).length}`, label: "choose" }]
							: []),
						{ keys: "enter", label: "send" },
						{ keys: "esc", label: "close" },
					]
				: listKeys()
						.filter(
							(key) =>
								selected !== undefined ||
								key.keys?.startsWith("esc") === true ||
								key.action === "app.keys.help" ||
								(key.action === "app.list.filter" && this.filter !== ""),
						)
						.map((key) =>
							key.action === "app.list.stop"
								? { ...key, label: selected && rowFinished(selected) ? "dismiss" : "stop" }
								: key.action === "app.list.peek" && peekOpen
									? { ...key, label: "close peek" }
									: key.keys?.startsWith("esc") === true && peekOpen
										? { keys: "esc", label: "close peek" }
										: key,
						);
		const hint = renderNavHintLine(keys, width, style, getKeybindings());
		const notice = this.failureNotice || this.stopNotice() || this.status;
		const footer = [...(notice ? [theme.fg("warning", clip(notice))] : []), hint];
		const head = [edge, clip(header), ...filterRow.map(clip)];
		const window = (room: number) => {
			const above = room > 1 ? 1 : 0;
			const start = selectedLine < 0 ? 0 : Math.max(0, Math.min(selectedLine - above, body.length - room));
			return body
				.slice(start, start + room)
				.map((line) =>
					clip(
						typeof line === "string"
							? line
							: ` ${renderBoardRow(this.withBoardElapsed(line), line.id === selected?.id, width - 1)}`,
					),
				);
		};
		// A short viewport keeps the rows around the selection first, then the hint line, then the header.
		const lineBudget = Math.max(1, budget);
		if (lineBudget < head.length + footer.length + 1) {
			const hint = lineBudget >= 2 ? footer.slice(-1) : [];
			return [...window(Math.max(1, lineBudget - hint.length)), ...hint].slice(0, lineBudget);
		}
		return [...head, ...window(lineBudget - head.length - footer.length), ...footer];
	}
	private renderAll(width: number): string[] {
		const task = this.selected();
		if (this.navigation.focus.kind === "stdin")
			return [`Input to ${task?.title}`, ...this.input.render(width), this.status];
		if (task && this.navigation.focus.kind === "detail") {
			return [
				...new TaskDetail(task, {
					...this.detailContent,
					stdinAvailable: this.stdinAvailable(),
					activity: this.store.recentActivity(task.ref.taskId),
					activityOmitted: this.store.activityOmitted(task.ref.taskId),
				}).renderContent(width),
				this.status,
			];
		}
		const sections = this.orderedSections();
		if (!sections.length)
			return new Text("No background tasks.\nBackground agents and shells will appear here.", 0, 0).render(width);
		return sections.flatMap((section) => [
			"",
			theme.fg("muted", theme.bold(`${section.title} (${section.tasks.length})`)),
			...section.tasks.flatMap((item) => {
				const selected = item.ref.taskId === this.navigation.selectedTaskId;
				const { label: state, color, icon } = taskStatusAppearance(item);
				const status = width < 32 ? ` ${icon}` : ` ${icon} ${state}`;
				const name = taskDisplayText(item.title || taskLabel(item));
				const marker = selected ? "› " : "  ";
				const title = marker + truncateToWidth(name, Math.max(1, width - visibleWidth(status) - 3));
				const row = `${selected ? theme.fg("accent", theme.bold(title)) : title}${" ".repeat(Math.max(1, width - visibleWidth(title) - visibleWidth(status)))}${theme.fg(color, status)}`;
				const metadata = [
					...(width < 32 ? [state] : []),
					taskLabel(item),
					taskMetricsText(this.withLiveElapsed(item)),
					item.currentAction ? `${item.currentAction.tool} ${item.currentAction.text}` : "",
				]
					.filter(Boolean)
					.join(" · ");
				return [
					truncateToWidth(row, width),
					...(item.kind === "agent" ? [theme.fg("dim", truncateToWidth(`  ${taskModelText(item)}`, width))] : []),
					...(selected ? [theme.fg("dim", truncateToWidth(`  ${taskDisplayText(metadata)}`, width))] : []),
				];
			}),
		]);
	}
}
