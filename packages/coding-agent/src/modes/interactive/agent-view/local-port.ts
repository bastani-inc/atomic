/**
 * A subagent of the task view in this process, as the single chat screen shows it: its transcript where the main
 * transcript is, its status for the prompt, rule, working line and panel, and the steering half the prompt sends
 * through. The isolated engine runs the same port for the views its host opens.
 */

import { firstSubagentAttempt, latestSubagentAttempt } from "../../../core/tasks/completion.js";
import type { TaskId } from "../../../core/tasks/contracts.js";
import type { TaskViewSource } from "../../../core/tasks/task-view-source.js";
import type { TaskTranscriptEnvironment } from "../components/task-transcript-page.ts";
import { TaskAgentTranscriptPage } from "../components/task-transcript-page.ts";
import { localAgentCommands } from "./agent-commands.ts";
import { localAgentPrompts } from "./agent-prompts.ts";
import { createLocalAgentSteering } from "./agent-steering.ts";
import type {
	AgentSteeringPort,
	AgentTranscriptComponent,
	AgentViewCommands,
	AgentViewPort,
	AgentViewStatus,
} from "./contracts.ts";

/** How often a shown subagent's status is read again while it runs, so its elapsed time advances. */
export const AGENT_VIEW_TICK_MS = 1_000;

export interface LocalAgentViewOptions {
	readonly source: TaskViewSource;
	/** Any attempt of the subagent; the port follows its latest. */
	readonly taskId: TaskId;
	readonly env: TaskTranscriptEnvironment;
	/** Repaint where the transcript is drawn. */
	readonly requestRender: () => void;
	/** The rows the transcript is drawn in when it is rendered by width alone (the engine's frame requests). */
	readonly rows?: () => number;
	/** A message the reader sent failed after they left the subagent. */
	readonly reportLate?: (reason: string) => void;
	/** Whether the panel or `/tasks` dismissed the attempt `taskId`: a dismissed subagent is gone from the screen. */
	readonly isDismissed?: (taskId: TaskId) => boolean;
	/** Changes beyond the task list that can make it gone, such as a dismissal; answers the unsubscribe. */
	readonly watch?: (listener: () => void) => () => void;
}

function renderSettingsKey(env: TaskTranscriptEnvironment): string {
	const settings = env.getChatRenderSettings?.();
	return `${settings?.toolOutputExpanded === true}|${settings?.hideThinkingBlock === true}`;
}

/** The transcript part of the page, as the transcript area draws it. */
export class AgentTranscriptView implements AgentTranscriptComponent {
	private readonly page: TaskAgentTranscriptPage;
	private readonly env: TaskTranscriptEnvironment;
	private readonly rows: () => number;
	private settingsKey: string;

	constructor(page: TaskAgentTranscriptPage, env: TaskTranscriptEnvironment, rows: () => number) {
		this.page = page;
		this.env = env;
		this.rows = rows;
		this.settingsKey = renderSettingsKey(env);
	}

	/** The main chat's Ctrl+O and thinking toggle reach the transcript shown in its place on its next frame. */
	private followRenderSettings(): void {
		const key = renderSettingsKey(this.env);
		if (key === this.settingsKey) return;
		const toolsToggled = key.split("|")[0] !== this.settingsKey.split("|")[0];
		this.settingsKey = key;
		if (toolsToggled) this.page.toolOutputToggled();
		else this.page.invalidate();
	}

	renderSized(width: number, height: number): string[] {
		this.followRenderSettings();
		return this.page.renderView(width, height);
	}

	render(width: number): string[] {
		return this.renderSized(width, Math.max(1, this.rows()));
	}

	handleViewKey(data: string): boolean {
		return this.page.handleViewKey(data);
	}

	capturesInput(): boolean {
		return this.page.capturesInput();
	}

	/**
	 * Keys for the transcript area: its question form's while one is open, else only scroll and paging keys (the engine
	 * forwards the host's this way). Nothing types into the page's own prompt, which the screen never shows.
	 */
	handleInput(data: string): boolean {
		return this.page.capturesInput() ? this.page.handleInput(data) : this.page.handleViewKey(data);
	}

	handleMouse(event: Parameters<NonNullable<TaskAgentTranscriptPage["handleMouse"]>>[0]) {
		return this.page.handleMouse(event);
	}

	paintedRowKey(row: number): string | undefined {
		return this.page.paintedRowKey(row);
	}

	invalidate(): void {
		this.page.invalidate();
	}
}

/** One subagent of `source`, shown through its own transcript page in view mode. */
export class LocalAgentViewPort implements AgentViewPort {
	readonly agentKey: string;
	readonly transcript: AgentTranscriptView;
	readonly steering: AgentSteeringPort["steering"];
	private readonly steeringPort: AgentSteeringPort;
	private readonly page: TaskAgentTranscriptPage;
	private readonly source: TaskViewSource;
	private readonly listeners = new Set<() => void>();
	private current: AgentViewStatus;
	private currentKey: string;
	private retained = 0;
	private disposed = false;
	private scheduled = false;
	private readonly unsubscribeSource: () => void;
	private readonly unwatch: () => void;
	private readonly isDismissed: ((taskId: TaskId) => boolean) | undefined;
	private readonly tick: ReturnType<typeof setInterval>;

	constructor(options: LocalAgentViewOptions) {
		const { source, env } = options;
		this.source = source;
		this.isDismissed = options.isDismissed;
		const first = firstSubagentAttempt(source.tasks, options.taskId);
		this.agentKey = first?.ref.taskId ?? options.taskId;
		const requestRender = () => {
			options.requestRender();
			this.scheduleStatus();
		};
		this.page = new TaskAgentTranscriptPage(
			source,
			options.taskId,
			env,
			requestRender,
			options.reportLate ?? ((reason) => env.notify?.(reason)),
			{ view: true },
		);
		this.transcript = new AgentTranscriptView(this.page, env, options.rows ?? (() => 24));
		this.current = this.readStatus();
		this.currentKey = JSON.stringify(this.current);
		this.steeringPort = createLocalAgentSteering({
			source,
			liveTaskId: () => this.status().taskId,
			status: () => this.status(),
			onStatus: (listener) => this.subscribe(listener),
		});
		this.steering = this.steeringPort.steering;
		// The task list changed: a resumed attempt, a settled run, a removal. The page follows it as the inspector did.
		this.unsubscribeSource = source.subscribe(() => {
			if (this.disposed) return;
			this.page.refresh();
			this.scheduleStatus();
			options.requestRender();
		});
		this.unwatch =
			options.watch?.(() => {
				if (this.disposed) return;
				if (this.publishStatus()) options.requestRender();
			}) ?? (() => {});
		this.tick = setInterval(() => {
			if (this.disposed) return;
			if (this.publishStatus()) options.requestRender();
		}, AGENT_VIEW_TICK_MS);
		this.tick.unref?.();
	}

	/** Read the latest page; the first one is in before the screen shows the subagent. */
	load(): Promise<void> {
		return this.page.load().then(() => {
			this.publishStatus();
		});
	}

	status(): AgentViewStatus {
		return this.current;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	pause() {
		return this.steeringPort.pause();
	}

	prompts(): Promise<readonly string[]> {
		return localAgentPrompts(this.source, this.status().taskId);
	}

	commands(): Promise<AgentViewCommands | undefined> {
		return localAgentCommands(this.source, this.status().taskId);
	}

	async lastAgentMessageText(): Promise<string | undefined> {
		return this.page.chat.lastAgentMessageText();
	}

	retain(): () => void {
		this.retained++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--this.retained === 0) this.dispose();
		};
	}

	/** Whether the subagent is an agent task this view lists. */
	static shows(source: TaskViewSource, taskId: TaskId): boolean {
		return latestSubagentAttempt(source.tasks, taskId)?.kind === "agent";
	}

	private scheduleStatus(): void {
		if (this.scheduled || this.disposed) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			this.publishStatus();
		});
	}

	/** Read the status again and tell the listeners when it changed. Answers whether it did. */
	private publishStatus(): boolean {
		if (this.disposed) return false;
		const next = this.readStatus();
		const key = JSON.stringify(next);
		if (key === this.currentKey) return false;
		this.current = next;
		this.currentKey = key;
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// A listener's failure must not stop the others.
			}
		}
		return true;
	}

	private readStatus(): AgentViewStatus {
		const status = this.page.viewStatus(this.agentKey);
		return !status.gone && this.isDismissed?.(status.taskId) === true ? { ...status, gone: true } : status;
	}

	private dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.tick);
		this.unsubscribeSource();
		this.unwatch();
		this.listeners.clear();
		this.page.dispose();
	}
}

/**
 * Open a port on the subagent `taskId` is an attempt of, once its first page is read: the screen never shows a
 * subagent before its transcript is there. Undefined when `source` lists no such agent task.
 */
export async function openLocalAgentViewPort(options: LocalAgentViewOptions): Promise<LocalAgentViewPort | undefined> {
	if (!LocalAgentViewPort.shows(options.source, options.taskId)) return undefined;
	const port = new LocalAgentViewPort(options);
	try {
		await port.load();
	} catch (error) {
		port.retain()();
		throw error;
	}
	return port;
}
