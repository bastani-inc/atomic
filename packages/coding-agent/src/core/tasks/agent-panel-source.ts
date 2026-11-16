/**
 * What the agent panel below the main chat's prompt and `/tasks` list: one item per running or recent background
 * subagent, shell and workflow run of a session. The session's own tasks are built in; extensions add their own
 * items, as the workflows extension adds runs, with `pi.registerAgentPanelSource()`.
 */

import type { ExtensionError } from "../extensions/runtime-types.js";
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
	readonly extensionRunner?: {
		getAgentPanelSourceHub?(): AgentPanelSourceHub | undefined;
		emitError?(error: ExtensionError): void;
	};
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

const reportedSources = new WeakSet<AgentPanelSource>();

function sourceError(error: unknown): Error {
	try {
		return new Error(error instanceof Error ? String(error.message) : String(error));
	} catch {
		return new Error("Agent panel source failed.");
	}
}

function reasonText(reason: unknown): string {
	return typeof reason === "string" ? reason : sourceError(reason).message;
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

const PANEL_KINDS: ReadonlySet<unknown> = new Set(["agent", "shell", "workflow"]);
const PANEL_STATES: ReadonlySet<unknown> = new Set([
	"running",
	"queued",
	"input",
	"paused",
	"stopping",
	"done",
	"failed",
	"stopped",
]);
const optionalNumber = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);
const optionalString = (v: unknown) => v === undefined || typeof v === "string";

function isPanelItem(item: AgentPanelItem): boolean {
	const p = item.progress;
	return (
		typeof item.id === "string" &&
		PANEL_KINDS.has(item.kind) &&
		PANEL_STATES.has(item.state) &&
		typeof item.name === "string" &&
		typeof item.task === "string" &&
		optionalNumber(item.elapsedMs) &&
		optionalNumber(item.tokens) &&
		optionalNumber(item.queued) &&
		optionalNumber(item.endedAt) &&
		optionalString(item.question) &&
		optionalString(item.reason) &&
		(item.choices === undefined || item.choices.every((choice) => typeof choice === "string")) &&
		(p === undefined || (optionalNumber(p.done) && optionalNumber(p.total) && p.done >= 0 && p.total >= 0))
	);
}

function sourceItems(source: AgentPanelSource, onError?: (error: Error) => void): readonly AgentPanelItem[] {
	const report = (error: unknown) => {
		if (onError === undefined || reportedSources.has(source)) return;
		reportedSources.add(source);
		safelyCall(() => onError(sourceError(error)));
	};
	const items: AgentPanelItem[] = [];
	try {
		for (const item of source.items()) {
			try {
				if (typeof item !== "object" || item === null) throw new Error("Invalid agent panel item.");
				const progress = item.progress;
				const choices = item.choices;
				if (choices !== undefined && !Array.isArray(choices)) throw new Error("Invalid agent panel choices.");
				const copy = {
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
				if (isPanelItem(copy)) items.push(copy);
				else report(new Error("Invalid agent panel item."));
			} catch (error) {
				report(error);
			}
		}
	} catch (error) {
		report(error);
	}
	return items;
}

export function agentPanelTaskId(id: string): TaskId | undefined {
	return id.startsWith(taskPrefix) ? (id.slice(taskPrefix.length) as TaskId) : undefined;
}

const dismissedBySession = new WeakMap<object, Set<string>>();

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

export function agentPanelExtensionItems(session: AgentPanelSession & object): AgentPanelItem[] {
	const dismissed = dismissedAgentPanelItems(session);
	const report = session.extensionRunner?.emitError;
	const onSourceError =
		report === undefined
			? undefined
			: (error: Error) =>
					report.call(session.extensionRunner, {
						extensionPath: "agent panel source",
						event: "agent_panel",
						error: error.message,
					});
	return (hubOf(session)?.all() ?? []).flatMap((source) =>
		sourceItems(source, onSourceError).filter((item) => !dismissed.has(item.id)),
	);
}

export function agentPanelItems(session: AgentPanelSession & object): AgentPanelItem[] {
	const store = getOwnerTaskStore(session);
	const tasks = store === undefined ? [] : taskPanelItems(ownerTaskViewSource(store), dismissedTaskIds(session));
	return [...agentPanelExtensionItems(session), ...tasks];
}

export function subscribeAgentPanelExtensions(session: AgentPanelSession, listener: () => void): () => void {
	return hubOf(session)?.subscribe(listener) ?? (() => {});
}

export function subscribeAgentPanel(session: AgentPanelSession & object, listener: () => void): () => void {
	let unsubscribeStore = getOwnerTaskStore(session)?.subscribe(listener) ?? (() => {});
	const unwatch = watchOwnerTaskStoreBinding(session, () => {
		unsubscribeStore();
		unsubscribeStore = getOwnerTaskStore(session)?.subscribe(listener) ?? (() => {});
		listener();
	});
	const unsubscribeHub = subscribeAgentPanelExtensions(session, listener);
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

export function openAgentPanelItem(session: AgentPanelSession, id: string, options?: AgentPanelOpenOptions): boolean {
	try {
		const source = sourceOf(session, id);
		if (source?.open === undefined) return false;
		return safelyCall(() => source.open?.(id, options));
	} catch {
		return false;
	}
}

export async function stopAgentPanelItem(
	session: AgentPanelSession & object,
	id: string,
): Promise<AgentPanelActionResult> {
	try {
		const taskId = agentPanelTaskId(id);
		if (taskId !== undefined) {
			const store = getOwnerTaskStore(session);
			if (store === undefined) return { ok: false, reason: "This task is no longer kept." };
			const result = await ownerTaskViewSource(store).cancelTask(taskId);
			return result.ok ? { ok: true } : { ok: false, reason: result.error.message };
		}
		const source = sourceOf(session, id);
		if (source?.stop === undefined) return { ok: false, reason: "This item cannot be stopped from here." };
		const result = await source.stop(id);
		return result.ok ? { ok: true } : { ok: false, reason: reasonText(result.reason) };
	} catch (error) {
		return { ok: false, reason: sourceError(error).message };
	}
}

export async function answerAgentPanelItem(
	session: AgentPanelSession,
	id: string,
	text: string,
): Promise<AgentPanelActionResult> {
	try {
		const source = sourceOf(session, id);
		if (source?.answer === undefined) return { ok: false, reason: "This item cannot be answered from here." };
		const result = await source.answer(id, text);
		return result.ok ? { ok: true } : { ok: false, reason: reasonText(result.reason) };
	} catch (error) {
		return { ok: false, reason: sourceError(error).message };
	}
}
