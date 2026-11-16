/**
 * What the agent panel below the main chat's prompt and `/tasks` list: one item per running or recent background
 * subagent, shell and workflow run of a session. The session's own tasks are built in; extensions add their own
 * items, as the workflows extension adds runs, with `pi.registerAgentPanelSource()`.
 */

import type { TaskId, TaskRecord } from "./contracts.js";
import { getOwnerTaskStore, watchOwnerTaskStoreBinding } from "./owner-store.js";
import { ownerTaskViewSource, type TaskViewSource } from "./task-view-source.js";

/** What an item's glyph and state word say about it. */
export type AgentPanelState = "running" | "queued" | "input" | "paused" | "stopping" | "done" | "failed" | "stopped";

/** One row of the agent panel and `/tasks`. */
export interface AgentPanelItem {
	/** Unique among the session's items: `task:<taskId>` for its tasks, `<source>:<id>` for an extension's. */
	readonly id: string;
	readonly kind: "agent" | "shell" | "workflow";
	readonly state: AgentPanelState;
	/** Agent name, `shell`, or the workflow's name. */
	readonly name: string;
	/** What it works on: a task's title, a shell's command, a run's current stage (`stage <name>`). */
	readonly task: string;
	readonly elapsedMs?: number;
	readonly tokens?: number;
	/** Stages finished and in total, for a workflow run. */
	readonly progress?: { readonly done: number; readonly total: number };
	/** The exact question a waiting item asks. */
	readonly question?: string;
	/** Its numbered choices, when it asks to pick one. */
	readonly choices?: readonly string[];
	/** A failed item's one-line reason. */
	readonly reason?: string;
	/** Messages typed to it that it has not taken yet. */
	readonly queued?: number;
	/** When it finished, for finished items. */
	readonly endedAt?: number;
}

export interface AgentPanelOpenOptions {
	readonly onReturn?: () => void;
}

export type AgentPanelActionResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** A provider of panel items, registered by an extension with `pi.registerAgentPanelSource()`. */
export interface AgentPanelSource {
	items(): readonly AgentPanelItem[];
	/** Calls `listener` whenever {@link items} may have changed; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	/**
	 * Opens an item in the interactive UI, as Enter on its row does (a workflow run's graph). `onReturn` is called when
	 * the opened view goes back one level, so the view it was opened from (the agent panel, `/tasks`) shows again.
	 */
	open?(id: string, options?: AgentPanelOpenOptions): void;
	/** Stops a running item, after the second `x`. */
	stop?(id: string): Promise<AgentPanelActionResult>;
	/** Answers a waiting item's question with `text`. */
	answer?(id: string, text: string): Promise<AgentPanelActionResult>;
}

/** The registration `pi.registerAgentPanelSource()` returns; disposed with its extension generation. */
export interface AgentPanelSourceRegistration {
	dispose(): void;
}

/** The sources one extension generation registered, read by its sessions. */
export class AgentPanelSourceHub {
	private readonly sources = new Set<AgentPanelSource>();
	private readonly listeners = new Set<() => void>();
	register(source: AgentPanelSource): AgentPanelSourceRegistration {
		this.sources.add(source);
		const unsubscribe = source.subscribe(() => this.notify());
		this.notify();
		return {
			dispose: () => {
				if (!this.sources.delete(source)) return;
				unsubscribe();
				this.notify();
			},
		};
	}
	all(): readonly AgentPanelSource[] {
		return [...this.sources];
	}
	/** Calls `listener` when a source registers, leaves or reports a change. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	dispose(): void {
		this.sources.clear();
		this.notify();
		this.listeners.clear();
	}
	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

/** What the panel reads of a session: its task store (by identity) and its extensions' sources. */
export interface AgentPanelSession {
	readonly extensionRunner?: { getAgentPanelSourceHub?(): AgentPanelSourceHub | undefined };
}

function hubOf(session: AgentPanelSession): AgentPanelSourceHub | undefined {
	return session.extensionRunner?.getAgentPanelSourceHub?.();
}

const taskPrefix = "task:";

function taskState(task: TaskRecord): AgentPanelState {
	switch (task.execution.kind) {
		case "queued":
			return "queued";
		case "cancelling":
			return "stopping";
		case "running":
			return task.attention.kind === "none" ? "running" : "input";
		case "settled": {
			const result = task.execution.result;
			if (result.kind === "completed") return "done";
			if (result.kind === "failed") return "failed";
			return "stopped";
		}
	}
	return "running";
}

/** One panel item per top-level background task of `source` that is not in `dismissed`, in admission order. */
export function taskPanelItems(source: Pick<TaskViewSource, "backgroundTasks">, dismissed: ReadonlySet<TaskId>) {
	return source.backgroundTasks
		.filter((task) => !dismissed.has(task.ref.taskId) && task.parentTaskId === undefined)
		.map((task): AgentPanelItem => {
			const state = taskState(task);
			const question = task.attention.kind === "input-needed" ? task.attention.prompt : undefined;
			return {
				id: `${taskPrefix}${task.ref.taskId}`,
				kind: task.kind === "agent" ? "agent" : "shell",
				state,
				name: task.kind === "agent" ? (task.agentName ?? "agent") : "shell",
				task: task.title || "",
				...(task.metrics?.elapsedMs === undefined ? {} : { elapsedMs: task.metrics.elapsedMs }),
				...(task.metrics?.tokenCount === undefined ? {} : { tokens: task.metrics.tokenCount }),
				...(question ? { question } : {}),
				...(state === "failed" && task.execution.kind === "settled" && task.execution.result.kind === "failed"
					? { reason: task.execution.result.message.split("\n")[0] ?? "" }
					: {}),
			};
		});
}

/** The task id an item names, for items of the session's own tasks. */
export function agentPanelTaskId(id: string): TaskId | undefined {
	return id.startsWith(taskPrefix) ? (id.slice(taskPrefix.length) as TaskId) : undefined;
}

const dismissedBySession = new WeakMap<object, Set<string>>();

/** Items the user dismissed with `x` in the panel or `/tasks`; their tasks and results are untouched. */
export function dismissedAgentPanelItems(session: object): Set<string> {
	let dismissed = dismissedBySession.get(session);
	if (dismissed === undefined) {
		dismissed = new Set();
		dismissedBySession.set(session, dismissed);
	}
	return dismissed;
}

function dismissedTaskIds(session: object): Set<TaskId> {
	const ids = new Set<TaskId>();
	for (const id of dismissedAgentPanelItems(session)) {
		const taskId = agentPanelTaskId(id);
		if (taskId !== undefined) ids.add(taskId);
	}
	return ids;
}

/**
 * Every item of `session`: its extensions' items (workflow runs) first, then its own background tasks, each in launch
 * order. Dismissed items are left out.
 */
export function agentPanelItems(session: AgentPanelSession & object): AgentPanelItem[] {
	const dismissed = dismissedAgentPanelItems(session);
	const store = getOwnerTaskStore(session);
	const tasks = store === undefined ? [] : taskPanelItems(ownerTaskViewSource(store), dismissedTaskIds(session));
	const extensions = (hubOf(session)?.all() ?? []).flatMap((source) =>
		source.items().filter((item) => !dismissed.has(item.id)),
	);
	return [...extensions, ...tasks];
}

/** Calls `listener` when the items of `session` may have changed; returns the unsubscribe. */
export function subscribeAgentPanel(session: AgentPanelSession & object, listener: () => void): () => void {
	let unsubscribeStore = getOwnerTaskStore(session)?.subscribe(listener) ?? (() => {});
	const unwatch = watchOwnerTaskStoreBinding(session, () => {
		unsubscribeStore();
		unsubscribeStore = getOwnerTaskStore(session)?.subscribe(listener) ?? (() => {});
		listener();
	});
	const unsubscribeHub = hubOf(session)?.subscribe(listener) ?? (() => {});
	return () => {
		unwatch();
		unsubscribeStore();
		unsubscribeHub();
	};
}

function sourceOf(session: AgentPanelSession, id: string): AgentPanelSource | undefined {
	return hubOf(session)
		?.all()
		.find((source) => source.items().some((item) => item.id === id));
}

/** Opens an extension's item (a workflow run's graph). Task items open through the task inspector instead. */
export function openAgentPanelItem(session: AgentPanelSession, id: string, options?: AgentPanelOpenOptions): boolean {
	const source = sourceOf(session, id);
	if (source?.open === undefined) return false;
	source.open(id, options);
	return true;
}

/** Stops an item: a task through its owner, an extension's item through its source. */
export async function stopAgentPanelItem(
	session: AgentPanelSession & object,
	id: string,
): Promise<AgentPanelActionResult> {
	const taskId = agentPanelTaskId(id);
	if (taskId !== undefined) {
		const store = getOwnerTaskStore(session);
		if (store === undefined) return { ok: false, reason: "This task is no longer kept." };
		const result = await ownerTaskViewSource(store).cancelTask(taskId);
		return result.ok ? { ok: true } : { ok: false, reason: result.error.message };
	}
	const source = sourceOf(session, id);
	if (source?.stop === undefined) return { ok: false, reason: "This item cannot be stopped from here." };
	return source.stop(id);
}

/** Answers a waiting extension item's question; tasks answer through their own question route. */
export async function answerAgentPanelItem(
	session: AgentPanelSession,
	id: string,
	text: string,
): Promise<AgentPanelActionResult> {
	const source = sourceOf(session, id);
	if (source?.answer === undefined) return { ok: false, reason: "This item cannot be answered from here." };
	return source.answer(id, text);
}
