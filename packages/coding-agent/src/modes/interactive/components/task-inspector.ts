import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
import { taskOutputText } from "../../../core/tasks/command-output.js";
import type { OperationId, PromptRoute, TaskId } from "../../../core/tasks/contracts.js";
import type { OwnerTaskStore } from "../../../core/tasks/owner-store.js";
import { taskOwnTranscriptEntries, taskTranscriptSource } from "../../../core/tasks/supervisor.js";
import { readTaskTranscriptSnapshot } from "../../../core/tasks/transcript.js";
import { theme } from "../theme/theme.js";
import { chatEntriesFromAgentMessages, renderChatMessageEntry } from "./chat-message-renderer.ts";
import { mouseWheelDeltaRows } from "./chat-transcript.js";
import { keyHintIfBound } from "./keybinding-hints.js";
import {
	TaskDetail,
	type TaskDetailContent,
	taskDetailActions,
	taskDetailLabels,
	taskDetailSummary,
} from "./task-detail.js";
import { type TaskListSection, taskListSections } from "./task-list.js";
import { TaskLiveTranscript } from "./task-live-transcript.js";
import { TaskNavigation } from "./task-navigation.js";
import { taskDisplayText, taskLabel, taskMetricsText, taskModelText, taskStatusAppearance } from "./task-row.js";

/** Focused view only. The store and original session remain the authorities. */
export class TaskInspector implements Component {
	readonly navigation: TaskNavigation;
	private actionIndex = 0;
	private confirmation?: (answer: boolean) => void;
	private transcript?: Component[];
	private liveTranscript?: TaskLiveTranscript;
	private transcriptRefreshPending = false;
	private transcriptRequested = false;
	private transcriptLoading = false;
	private transcriptHistorical = false;
	private transcriptPageRows = 5;
	private cursor?: string;
	private status = "";
	private scroll = 0;
	private detailContent: Omit<TaskDetailContent, "stdinAvailable"> = {};
	private detailTaskId?: TaskId;
	private detailGeneration = 0;
	private disposed = false;
	private readonly input = new Input();
	private readonly unsubscribe: () => void;
	constructor(
		privateStore: OwnerTaskStore,
		privateRender: () => void,
		privateClose: () => void,
		openQuestion?: (route: PromptRoute) => void,
	) {
		this.store = privateStore;
		this.requestRender = privateRender;
		this.close = privateClose;
		this.navigation = new TaskNavigation(getKeybindings() as KeybindingsManager, {
			inspect: () => {
				this.releaseLiveTranscript();
				this.actionIndex = 0;
				this.scroll = 0;
				this.transcript = undefined;
				this.transcriptRequested = false;
				this.transcriptLoading = false;
				this.transcriptHistorical = false;
				void this.loadDetail();
			},
			transcript: () => {
				this.detailGeneration++;
				this.scroll = 0;
				void this.loadTranscript();
			},
			foreground: (task) => {
				const lease = this.store.resolveTask(task.ref.taskId);
				if (lease.ok)
					void this.store.supervisor.foregroundTask(lease.value).then((result) => {
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
				const lease = this.store.resolveTask(task.ref.taskId);
				if (lease.ok) void this.store.supervisor.cancelTask(lease.value, "user").then(() => this.requestRender());
			},
			stdinAvailable: (task) => {
				const lease = this.store.resolveTask(task.ref.taskId);
				return lease.ok && this.store.supervisor.taskStdin(lease.value).ok;
			},
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
			if (this.transcriptRequested) {
				this.refreshTranscript();
			} else if (this.navigation.focus.kind === "detail") void this.loadDetail();
			this.requestRender();
		});
		this.navigation.update(this.orderedSections().flatMap((section) => section.tasks));
		this.navigation.open();
		this.input.onSubmit = (text) => {
			void this.sendInput(text);
		};
	}
	private readonly store: OwnerTaskStore;
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
		this.releaseLiveTranscript();
		this.confirmation?.(false);
		this.unsubscribe();
	}
	invalidate(): void {
		for (const component of this.transcript ?? []) component.invalidate();
	}
	private selected() {
		return this.store.backgroundTasks.find((task) => task.ref.taskId === this.navigation.selectedTaskId);
	}
	private stdinAvailable(): boolean {
		const task = this.selected();
		if (!task || task.execution.kind === "settled") return false;
		const lease = this.store.resolveTask(task.ref.taskId);
		return lease.ok && this.store.supervisor.taskStdin(lease.value).ok;
	}
	private async sendInput(text: string): Promise<void> {
		const task = this.selected();
		if (!task) return;
		const lease = this.store.resolveTask(task.ref.taskId);
		if (!lease.ok) return;
		const stdin = this.store.supervisor.taskStdin(lease.value);
		if (!stdin.ok) {
			this.status = stdin.error.message;
			return;
		}
		const result = await this.store.supervisor.writeTaskInput(stdin.value, randomUUID() as OperationId, {
			kind: "bytes",
			bytes: Buffer.from(`${text}\n`),
		});
		this.status = result.ok ? `Sent ${result.value.acceptedBytes} bytes` : result.error.message;
		this.input.setValue("");
		this.requestRender();
	}
	private releaseLiveTranscript(): void {
		this.liveTranscript?.dispose();
		this.liveTranscript = undefined;
		this.transcriptRefreshPending = false;
	}
	private refreshTranscript(): void {
		if (this.disposed || !this.transcriptRequested) return;
		const task = this.selected();
		const lease = task && this.store.resolveTask(task.ref.taskId);
		const bound = lease?.ok ? taskTranscriptSource(lease.value) : undefined;
		if (bound?.ok && this.liveTranscript?.source === bound.value.session) return;
		// Legacy history-only sources have no live tail; keep their retained page anchored.
		if (bound?.ok && !bound.value.session.subscribe && this.transcriptHistorical) return;
		if (this.transcriptLoading) this.transcriptRefreshPending = true;
		else void this.loadTranscript();
	}
	private async loadTranscript(earlier = false): Promise<void> {
		const task = this.selected();
		if (!task) return;
		const generation = ++this.detailGeneration;
		const focus = this.navigation.focus;
		this.transcriptRequested = true;
		this.transcriptLoading = true;
		if (earlier) this.transcriptHistorical = true;
		this.requestRender();
		try {
			const lease = this.store.resolveTask(task.ref.taskId);
			if (!lease.ok) {
				this.status = lease.error.message;
				return;
			}
			if (task.kind === "command") {
				const count = BigInt(task.output.byteCount);
				const page = await this.store.supervisor.readTaskOutput(lease.value, {
					start: String(count > 8192n ? count - 8192n : 0n),
					maximumBytes: 8192,
				});
				if (
					this.disposed ||
					generation !== this.detailGeneration ||
					focus !== this.navigation.focus ||
					task.ref.taskId !== this.navigation.selectedTaskId
				)
					return;
				const text = page.ok ? taskOutputText(page.value) : page.error.message;
				this.transcript = [
					new Text(text.split("\n").map(taskDisplayText).join("\n") || "No output available", 0, 0),
				];
				this.cursor = undefined;
				this.status =
					count > 8192n ? "Earlier output omitted · showing retained 8 KiB tail" : "Retained shell output";
				this.requestRender();
				return;
			}
			const page = readTaskTranscriptSnapshot(lease.value, earlier ? this.cursor : undefined);
			if (
				this.disposed ||
				generation !== this.detailGeneration ||
				focus !== this.navigation.focus ||
				task.ref.taskId !== this.navigation.selectedTaskId
			)
				return;
			const bound = taskTranscriptSource(lease.value);
			if (!bound.ok || (!page.ok && !bound.value.session.subscribe)) {
				this.status = "Transcript unavailable";
				this.requestRender();
				return;
			}
			const ids = new Set(page.ok ? page.value.items.map((item) => item.source.entryId) : []);
			const messages = bound.value.session.getEntries().flatMap<AgentMessage>((entry) => {
				if (entry.type !== "message" || !ids.has(entry.id)) return [];
				const message = entry.message;
				if (message.role === "assistant")
					return [
						{
							...message,
							content: message.content.filter(
								(block, index) =>
									block.type !== "thinking" &&
									page.ok &&
									page.value.items.some(
										(item) => item.source.entryId === entry.id && item.source.contentIndex === index,
									),
							),
						},
					];
				return message.role === "user" || message.role === "toolResult" ? [message] : [];
			});
			const components = chatEntriesFromAgentMessages(messages).map((entry) =>
				renderChatMessageEntry(entry, {
					ui: { requestRender: this.requestRender },
					cwd: process.cwd(),
					hideThinkingBlock: true,
					toolOutputExpanded: true,
					showImages: false,
				}),
			);
			if (!earlier && bound.value.session.subscribe) {
				this.releaseLiveTranscript();
				this.liveTranscript = new TaskLiveTranscript(bound.value.session, messages, this.requestRender);
				this.transcript = [this.liveTranscript];
			} else this.transcript = earlier ? [...components, ...(this.transcript ?? [])] : components;
			this.cursor = page.ok ? page.value.nextCursor : undefined;
			this.status = this.cursor ? "PageUp: earlier retained messages" : "";
			this.requestRender();
		} catch {
			if (!this.disposed && generation === this.detailGeneration && focus === this.navigation.focus) {
				this.transcript = [];
				this.status = "Task output unavailable";
				this.requestRender();
			}
		} finally {
			if (generation === this.detailGeneration) {
				this.transcriptLoading = false;
				if (this.transcriptRefreshPending) {
					this.transcriptRefreshPending = false;
					this.refreshTranscript();
				}
			}
		}
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
		const lease = this.store.resolveTask(task.ref.taskId);
		if (!lease.ok) return;
		const ownEntries = taskOwnTranscriptEntries(lease.value);
		if (ownEntries) {
			const prompt = ownEntries.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (prompt?.type === "message" && prompt.message.role === "user")
				this.detailContent.prompt =
					typeof prompt.message.content === "string"
						? prompt.message.content
						: prompt.message.content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join("");
			const response = ownEntries
				.slice()
				.reverse()
				.find((entry) => entry.type === "message" && entry.message.role === "assistant");
			if (response?.type === "message" && response.message.role === "assistant")
				this.detailContent.output = response.message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("");
		}
		if (task.kind === "command") {
			try {
				const count = BigInt(task.output.byteCount);
				const output = await this.store.supervisor.readTaskOutput(lease.value, {
					start: String(count > 8192n ? count - 8192n : 0n),
					maximumBytes: 8192,
				});
				if (!current()) return;
				if (output.ok) {
					this.detailContent.output = taskOutputText(output.value);
					this.detailContent.outputOmitted = count > 8192n || output.value.omittedRanges.length > 0;
				} else this.status = output.error.message;
			} catch {
				if (!current()) return;
				this.status = "Command output unavailable";
			}
		}
		if (current()) this.requestRender();
	}
	handleInput(data: string): boolean {
		if (this.confirmation) {
			if (data === "y" || data === "n" || matchesKey(data, "escape")) {
				const answer = this.confirmation;
				this.confirmation = undefined;
				answer(data === "y");
			}
			this.requestRender();
			return true;
		}
		const wheel = mouseWheelDeltaRows(data);
		if (wheel !== 0) {
			if (this.navigation.focus.kind === "tasks") this.navigation.moveSelection(Math.sign(wheel));
			else if (this.navigation.focus.kind === "detail") {
				if (this.transcriptRequested && wheel < 0 && this.scroll === 0 && this.cursor && !this.transcriptLoading)
					void this.loadTranscript(true);
				else this.scroll = Math.max(0, this.scroll + wheel);
			}
			this.requestRender();
			return true;
		}
		// Mouse reports are never text input, including horizontal wheel/release.
		if (/^\x1b\[<\d+;\d+;\d+[mM]$/.test(data) || data.startsWith("\x1b[M")) return true;
		if (
			matchesKey(data, "escape") ||
			(matchesKey(data, "left") && this.navigation.focus.kind !== "stdin" && !this.configuredTaskKey(data))
		) {
			if (this.transcriptRequested) {
				this.releaseLiveTranscript();
				this.detailGeneration++;
				this.transcript = undefined;
				this.transcriptRequested = false;
				this.transcriptLoading = false;
				this.transcriptHistorical = false;
				this.scroll = 0;
				void this.loadDetail();
			} else {
				this.navigation.handleInput("\x1b", "tasks");
				if (this.navigation.focus.kind === "composer") this.close();
			}
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
		if (this.transcriptRequested) {
			if (this.configuredTaskKey(data)) this.navigation.handleInput(data, "tasks");
			else if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
			else if (matchesKey(data, "down")) this.scroll++;
			else if (matchesKey(data, "pageUp")) {
				if (this.scroll === 0 && this.cursor && !this.transcriptLoading) void this.loadTranscript(true);
				else this.scroll = Math.max(0, this.scroll - this.transcriptPageRows);
			} else if (matchesKey(data, "pageDown")) this.scroll += this.transcriptPageRows;
			else if (matchesKey(data, "home")) this.scroll = 0;
			else if (matchesKey(data, "end")) this.scroll = Number.MAX_SAFE_INTEGER;
			this.requestRender();
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
	private renderTranscriptViewport(width: number, budget: number): string[] {
		const task = this.selected();
		const room = Math.max(1, budget - 5);
		this.transcriptPageRows = room;
		const rows = this.transcript?.flatMap((component) => component.render(width)) ?? [
			this.transcriptLoading ? "Loading transcript…" : this.status,
		];
		this.scroll = Math.min(this.scroll, Math.max(0, rows.length - room));
		const visible = rows.slice(this.scroll, this.scroll + room);
		// Transcript tools own their backgrounds. Keep them out of a nested box,
		// strip terminal movement, and reset styles at every viewport row boundary.
		const safeLine = (line: string) =>
			line
				.split(/(\x1b\[[0-9;:]*m)/g)
				.map((part, index) =>
					index % 2 ? part : stripVTControlCharacters(part).replace(/[\x00-\x1f\x7f-\x9f]/g, " "),
				)
				.join("");
		const fit = (line: string) => truncateToWidth(safeLine(line), Math.max(1, width)) + "\x1b[0m";
		return [
			theme.bold(`Transcript · ${task ? taskDisplayText(taskLabel(task)) : "Task"}`),
			task ? taskDetailSummary(task) : "",
			theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
			...visible,
			...Array.from({ length: Math.max(0, room - visible.length) }, () => ""),
			theme.fg(
				"dim",
				`Lines ${rows.length ? this.scroll + 1 : 0}–${Math.min(rows.length, this.scroll + room)} of ${rows.length}${this.cursor ? " · PgUp at top: earlier history" : ""}${this.status ? ` · ${this.status}` : ""}`,
			),
			theme.fg("dim", "↑↓ scroll · PgUp/PgDn page · Home/End · ←/Esc back"),
		]
			.map(fit)
			.slice(0, Math.max(1, budget));
	}
	renderViewport(width: number, budget: number): string[] {
		if (this.transcriptRequested && !this.confirmation && this.navigation.focus.kind === "detail")
			return this.renderTranscriptViewport(width, budget);
		const framed = width >= 20 && budget >= 7;
		const inner = Math.max(1, width - (framed ? 4 : 0));
		const current = this.selected();
		const detail = this.navigation.focus.kind === "detail";
		const selectingAction = current && detail && !this.transcriptRequested && !this.confirmation;
		const actions = selectingAction
			? taskDetailActions(current.execution, current.attention, this.stdinAvailable())
			: [];
		this.actionIndex = Math.max(0, Math.min(this.actionIndex, actions.length - 1));
		const action = actions[this.actionIndex];
		const actionRow = action ? [theme.fg("accent", `› ${taskDetailLabels[action]}`)] : [];
		const rows = this.renderAll(inner);
		const compactSummary = !framed && detail && current && budget >= 4 ? [taskDetailSummary(current)] : [];
		const height = Math.max(0, budget - (framed ? 4 : 1) - actionRow.length - compactSummary.length);
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
				: this.transcriptRequested
					? "↑↓ scroll · PgUp/PgDn page · ←/Esc back"
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
		if (!framed)
			return [...compactSummary, ...view, ...actionRow, footer]
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
		if (this.transcript) return [...this.transcript.flatMap((component) => component.render(width)), this.status];
		if (this.transcriptRequested)
			return [this.transcriptLoading ? "Loading transcript…" : this.status || "Transcript unavailable"];
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
