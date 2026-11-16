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
	private readonly sources = new Map<AgentPanelSource, () => void>();
	private readonly listeners = new Set<() => void>();
	register(source: AgentPanelSource): AgentPanelSourceRegistration {
		let unsubscribe: () => void;
		try {
			unsubscribe = source.subscribe(() => {
				if (this.sources.has(source)) this.notify();
			});
		} catch {
			return { dispose() {} };
		}
		const cleanup = () => safelyCall(unsubscribe);
		this.sources.get(source)?.();
		this.sources.set(source, cleanup);
		this.notify();
		return {
			dispose: () => {
				if (this.sources.get(source) !== cleanup) return;
				this.sources.delete(source);
				cleanup();
				this.notify();
			},
		};
	}
	all(): readonly AgentPanelSource[] {
		return [...this.sources.keys()];
	}
	/** Calls `listener` when a source registers, leaves or reports a change. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	dispose(): void {
		const cleanups = [...this.sources.values()];
		this.sources.clear();
		for (const cleanup of cleanups) cleanup();
		this.notify();
		this.listeners.clear();
	}
	private notify(): void {
		for (const listener of [...this.listeners]) safelyCall(listener);
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

const SHORT_TITLE_CHARS = 60;

/**
 * What a row says a task works on: a subagent's whole prompt is too long for one, so its first line, cut at its first
 * sentence when that ends early enough, else at a word near {@link SHORT_TITLE_CHARS}.
 */
export function shortTaskTitle(title: string): string {
	const line =
		title
			.split("\n")
			.find((part) => part.trim().length > 0)
			?.trim() ?? "";
	const sentence = /^(.{12,}?[.!?])(\s|$)/.exec(line)?.[1];
	if (sentence !== undefined && sentence.length <= SHORT_TITLE_CHARS) return sentence;
	if (line.length <= SHORT_TITLE_CHARS) return line;
	const cut = line.slice(0, SHORT_TITLE_CHARS);
	const space = cut.lastIndexOf(" ");
	return `${(space > SHORT_TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * One panel item per background task of `source` that is not in `dismissed`, in admission order. The main chat's panel
 * lists only top-level tasks; a subagent's chat lists the tasks of that subagent, which all have a parent.
 */
export function taskPanelItems(
	source: Pick<TaskViewSource, "backgroundTasks">,
	dismissed: ReadonlySet<TaskId>,
	options: { readonly topLevelOnly?: boolean } = {},
) {
	const topLevelOnly = options.topLevelOnly ?? true;
	return source.backgroundTasks
		.filter((task) => !dismissed.has(task.ref.taskId) && (!topLevelOnly || task.parentTaskId === undefined))
		.map((task): AgentPanelItem => {
			const state = taskState(task);
			const question = task.attention.kind === "input-needed" ? task.attention.prompt : undefined;
			return {
				id: `${taskPrefix}${task.ref.taskId}`,
				kind: task.kind === "agent" ? "agent" : "shell",
				state,
				name: task.kind === "agent" ? (task.agentName ?? "agent") : "shell",
				task: shortTaskTitle(task.title || ""),
				...(task.metrics?.elapsedMs === undefined ? {} : { elapsedMs: task.metrics.elapsedMs }),
				...(task.metrics?.tokenCount === undefined ? {} : { tokens: task.metrics.tokenCount }),
				...(question ? { question } : {}),
				...(state === "failed" && task.execution.kind === "settled" && task.execution.result.kind === "failed"
					? { reason: task.execution.result.message.split("\n")[0] ?? "" }
					: {}),
			};
		});
}

const reportedSources = new WeakSet<AgentPanelSource>();

function sourceError(error: unknown): Error {
	try {
		return new Error(error instanceof Error ? String(error.message) : String(error));
	} catch {
		return new Error("Agent panel source failed.");
	}
}

function safelyCall(callback: () => void | PromiseLike<void>): boolean {
	try {
		const result = callback();
		if (result !== undefined) void Promise.resolve(result).catch(() => {});
		return true;
	} catch {
		return false;
	}
}

/** A source's items, or none when it throws: one broken extension never takes the panel or the host down. */
function sourceItems(source: AgentPanelSource, onError?: (error: Error) => void): readonly AgentPanelItem[] {
	try {
		return Array.from(source.items(), (item) => {
			const progress = item.progress;
			const choices = item.choices;
			return {
				id: item.id,
				kind: item.kind,
				state: item.state,
				name: item.name,
				task: item.task,
				elapsedMs: item.elapsedMs,
				tokens: item.tokens,
				progress: progress === undefined ? undefined : { done: progress.done, total: progress.total },
				question: item.question,
				choices: choices === undefined ? undefined : Array.from(choices),
				reason: item.reason,
				queued: item.queued,
				endedAt: item.endedAt,
			};
		});
	} catch (error) {
		if (onError !== undefined && !reportedSources.has(source)) {
			reportedSources.add(source);
			safelyCall(() => onError(sourceError(error)));
		}
		return [];
	}
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
export function agentPanelItems(
	session: AgentPanelSession & object,
	/** Told, once per source, when a source fails to list its items; that source is then left out. */
	onSourceError?: (error: Error) => void,
): AgentPanelItem[] {
	const dismissed = dismissedAgentPanelItems(session);
	const store = getOwnerTaskStore(session);
	const tasks = store === undefined ? [] : taskPanelItems(ownerTaskViewSource(store), dismissedTaskIds(session));
	const extensions = (hubOf(session)?.all() ?? []).flatMap((source) =>
		sourceItems(source, onSourceError).filter((item) => !dismissed.has(item.id)),
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
		.find((source) => sourceItems(source).some((item) => item.id === id));
}

/** Opens an extension's item (a workflow run's graph). Task items open through the task inspector instead. */
export function openAgentPanelItem(session: AgentPanelSession, id: string, options?: AgentPanelOpenOptions): boolean {
	try {
		const source = sourceOf(session, id);
		if (source?.open === undefined) return false;
		return safelyCall(() => source.open?.(id, options));
	} catch {
		return false;
	}
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
	try {
		const source = sourceOf(session, id);
		if (source?.stop === undefined) return { ok: false, reason: "This item cannot be stopped from here." };
		const result = await source.stop(id);
		return result.ok ? { ok: true } : { ok: false, reason: result.reason };
	} catch (error) {
		return { ok: false, reason: sourceError(error).message };
	}
}

/** Answers a waiting extension item's question; tasks answer through their own question route. */
export async function answerAgentPanelItem(
	session: AgentPanelSession,
	id: string,
	text: string,
): Promise<AgentPanelActionResult> {
	try {
		const source = sourceOf(session, id);
		if (source?.answer === undefined) return { ok: false, reason: "This item cannot be answered from here." };
		const result = await source.answer(id, text);
		return result.ok ? { ok: true } : { ok: false, reason: result.reason };
	} catch (error) {
		return { ok: false, reason: sourceError(error).message };
	}
}
