import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	getKeybindings,
	Input,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { PromptRoute, TaskId } from "../../../core/tasks/contracts.js";
import { OwnerTaskStore } from "../../../core/tasks/owner-store.js";
import { ownerTaskViewSource, type TaskViewSource } from "../../../core/tasks/task-view-source.js";
import { theme } from "../theme/theme.js";
import { parseWheelReport } from "./chat-transcript.js";
import { renderExtensionStatusRow } from "./footer.ts";
import { keyHintIfBound, keyText } from "./keybinding-hints.js";
import {
	TaskDetail,
	type TaskDetailContent,
	taskDetailActions,
	taskDetailLabels,
	taskDetailSummary,
} from "./task-detail.js";
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

/** Focused view only. The task source and original session remain the authorities. */
export class TaskInspector implements Component {
	readonly navigation: TaskNavigation;
	private actionIndex = 0;
	private confirmation?: (answer: boolean) => void;
	/** The open transcript of the selected task, on the shared chat stack. */
	private transcript?: TaskTranscriptPage;
	private status = "";
	/** Why the last stop did not reach its task; shown under the list until the next key. */
	private stopFailure = "";
	private scroll = 0;
	private detailContent: Omit<TaskDetailContent, "stdinAvailable"> = {};
	private detailTaskId?: TaskId;
	private detailGeneration = 0;
	private disposed = false;
	private statusWatch?: { taskId: TaskId; release: () => void };
	private readonly input = new Input();
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
			transcript: () => {
				this.detailGeneration++;
				this.openTranscript();
			},
			foreground: (task) => {
				void this.store.foregroundTask(task.ref.taskId).then((result) => {
					this.status = result.ok ? result.value.kind : result.error.message;
					this.requestRender();
				});
			},
			confirmCancel: () =>
				new Promise<boolean>((resolve) => {
					this.confirmation = resolve;
					this.requestRender();
				}),
			cancel: (task) => {
				void this.store.cancelTask(task.ref.taskId).then((result) => {
					// A stop that did not reach the task says so, instead of leaving it looking untouched.
					this.stopFailure = result.ok ? "" : `Could not stop the task: ${result.error.message}`;
					this.requestRender();
				});
			},
			stdinAvailable: (task) => this.store.stdinAvailable(task.ref.taskId),
			input: () => {
				this.input.setValue("");
			},
			openQuestion: (route) => {
				if (openQuestion) {
					this.close();
					openQuestion(route);
				} else this.status = "Question is available in its owning session.";
			},
		});
		this.unsubscribe = this.store.subscribe(() => {
			this.navigation.update(this.orderedSections().flatMap((section) => section.tasks));
			if (this.transcript) this.transcript.refresh();
			else if (this.navigation.focus.kind === "detail") void this.loadDetail();
			this.requestRender();
		});
		this.navigation.update(this.orderedSections().flatMap((section) => section.tasks));
		this.navigation.open();
		this.input.onSubmit = (text) => {
			void this.sendInput(text);
		};
	}
	private readonly store: TaskViewSource;
	private readonly requestRender: () => void;
	private readonly close: () => void;
	open(id?: TaskId): void {
		this.navigation.open(id);
	}
	private orderedSections(): TaskListSection[] {
		return taskListSections(this.store.backgroundTasks, this.store.settlementOrder);
	}
	dispose(): void {
		this.disposed = true;
		this.releaseStatusWatch();
		this.closeTranscript();
		this.confirmation?.(false);
		this.unsubscribe();
	}
	invalidate(): void {
		this.transcript?.invalidate();
	}
	private selected() {
		return this.store.backgroundTasks.find((task) => task.ref.taskId === this.navigation.selectedTaskId);
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
		this.input.setValue("");
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
		const task = this.navigation.focus.kind === "detail" && !this.confirmation ? this.selected() : undefined;
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
			this.transcript = new TaskAgentTranscriptPage(this.store, task.ref.taskId, environment, this.requestRender);
		this.requestRender();
		void this.transcript.load();
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
	handleInput(data: string): boolean {
		this.stopFailure = "";
		if (this.confirmation) {
			if (data === "y" || data === "n" || matchesKey(data, "escape")) {
				const answer = this.confirmation;
				this.confirmation = undefined;
				answer(data === "y");
			}
			this.requestRender();
			return true;
		}
		if (this.transcript) return this.handleTranscriptInput(data, this.transcript);
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
		if (
			matchesKey(data, "escape") ||
			(matchesKey(data, "left") && this.navigation.focus.kind !== "stdin" && !this.configuredTaskKey(data))
		) {
			this.navigation.handleInput("\x1b", "tasks");
			if (this.navigation.focus.kind === "composer") this.close();
			this.requestRender();
			return true;
		}
		if (this.navigation.focus.kind === "stdin") {
			this.input.handleInput(data);
			this.requestRender();
			return true;
		}
		if (data === "x" && !this.configuredTaskKey(data)) {
			void this.navigation.activate("cancel");
			return true;
		}
		const task = this.selected();
		if (task && this.navigation.focus.kind === "detail") {
			const actions = taskDetailActions(task.execution, task.attention, this.stdinAvailable());
			if (this.configuredTaskKey(data)) {
				if (getKeybindings().matches(data, "app.tasks.inspect"))
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
			else if (getKeybindings().matches(data, "app.tasks.inspect"))
				void this.navigation.activate(actions[Math.min(this.actionIndex, actions.length - 1)]);
			else if (!this.navigation.handleInput(data, "tasks")) return false;
		} else if (!this.navigation.handleInput(data, "tasks")) return false;
		this.requestRender();
		return true;
	}
	/** A transcript is a chat: Escape, or Left with nothing typed, goes back; every other key belongs to it. */
	private handleTranscriptInput(data: string, transcript: TaskTranscriptPage): boolean {
		if (matchesKey(data, "escape") || (matchesKey(data, "left") && !transcript.hasDraft())) {
			this.closeTranscript();
			this.detailGeneration++;
			this.scroll = 0;
			void this.loadDetail();
			this.requestRender();
			return true;
		}
		return transcript.handleInput(data);
	}
	private configuredTaskKey(data: string): boolean {
		return (["app.tasks.inspect", "app.tasks.foreground", "app.tasks.cancel", "app.tasks.input"] as const).some(
			(key) => getKeybindings().matches(data, key),
		);
	}
	/** Only the task picker stays inline; drill-down and confirmation own the screen. */
	get fullscreen(): boolean {
		return (
			this.confirmation !== undefined ||
			this.navigation.focus.kind === "detail" ||
			this.navigation.focus.kind === "stdin"
		);
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
		const header = [
			theme.bold(`Transcript · ${task ? taskDisplayText(taskLabel(task)) : "Task"}`),
			task ? taskDetailSummary(task) : "",
			theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
		].map(fitWidth);
		const notes = [transcript.status, this.status].filter(Boolean).join(" · ");
		const hints = [
			"Esc back",
			task?.kind === "agent" && this.store.sendTaskMessage !== undefined ? "Enter messages the agent" : "",
			`${keyText("tui.altScreen.top")}/${keyText("tui.altScreen.bottom")} top/latest`,
		]
			.filter(Boolean)
			.join(" · ");
		const footer = [...(notes ? [notes] : []), hints].map((line) => fitWidth(theme.fg("dim", line)));
		const failure = this.stopFailure ? [fitWidth(theme.fg("warning", this.stopFailure))] : [];
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
		if (this.transcript && !this.confirmation && this.navigation.focus.kind === "detail")
			return this.renderTranscriptPage(width, budget, this.transcript);
		const framed = width >= 20 && budget >= 7;
		const inner = Math.max(1, width - (framed ? 4 : 0));
		const current = this.selected();
		const detail = this.navigation.focus.kind === "detail";
		const selectingAction = current && detail && !this.transcript && !this.confirmation;
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
		const inspect = keyHintIfBound("app.tasks.inspect", detail ? "select" : "view");
		const hints = this.confirmation
			? "y confirm · n/Esc keep running"
			: this.navigation.focus.kind === "stdin"
				? "Enter send · Esc back"
				: [
						detail ? "PgUp/PgDn scroll · ↑↓ actions" : "↑↓ select",
						inspect,
						current && current.execution.kind !== "settled"
							? keyHintIfBound("app.tasks.cancel", "stop") || (!this.configuredTaskKey("x") ? "x stop" : "")
							: "",
						"Esc back",
					]
						.filter(Boolean)
						.join(" · ");
		const footer = theme.fg("dim", truncateToWidth(`/tasks · ${hints}`, width));
		const failure = this.stopFailure ? [theme.fg("warning", truncateToWidth(this.stopFailure, width))] : [];
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
	private renderAll(width: number): string[] {
		const task = this.selected();
		if (this.confirmation)
			return new Text(
				`Cancel ${task?.title}\nTask ${task?.ref.taskId}\ny: confirm · n/Escape: keep running`,
				0,
				0,
			).render(width);
		if (this.navigation.focus.kind === "stdin")
			return [`Input to ${task?.title} · Escape: tasks`, ...this.input.render(width), this.status];
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
					taskMetricsText(item),
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
