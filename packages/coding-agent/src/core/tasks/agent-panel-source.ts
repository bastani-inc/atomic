/**
 * What the agent panel below the main chat's prompt and `/tasks` list: one item per running or recent background
 * subagent, shell and workflow run of a session. The session's own tasks are built in; extensions add their own
 * items, as the workflows extension adds runs, with `pi.registerAgentPanelSource()`.
 */

import { sanitizeTerminalText } from "../../utils/terminal-text.ts";
import type { ExtensionError } from "../extensions/runtime-types.ts";
import type { TaskId, TaskRecord } from "./contracts.js";
import { bindTaskClock, type TaskElapsedClocks, taskClockOf } from "./live-elapsed.ts";
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
	readonly viewed?: boolean;
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
	open?:
		| ((id: string, options?: AgentPanelOpenOptions) => boolean)
		| ((id: string, options?: AgentPanelOpenOptions) => void);
	/** Stops a running item, after the second `x`. */
	stop?(id: string): Promise<AgentPanelActionResult>;
	/** Answers a waiting item's question with `text`. */
	answer?(id: string, text: string): Promise<AgentPanelActionResult>;
}

/** The registration `pi.registerAgentPanelSource()` returns; disposed with its extension generation. */
export interface AgentPanelSourceRegistration {
	dispose(): void;
}

const subscribeErrors = new WeakMap<AgentPanelSource, Error>();

export class AgentPanelSourceHub {
	private readonly sources = new Map<AgentPanelSource, () => void>();
	private readonly listeners = new Set<() => void>();
	private readonly errorReporters = new Set<(source: AgentPanelSource, error: Error) => void>();
	register(source: AgentPanelSource): AgentPanelSourceRegistration {
		let unsubscribe: () => void = () => {};
		try {
			const sub = source.subscribe(() => {
				if (this.sources.has(source)) this.notify();
			});
			if (typeof sub === "function") unsubscribe = sub;
			else throw new Error("Invalid agent panel source subscription.");
		} catch (error) {
			const err = sourceError(error);
			subscribeErrors.set(source, err);
			for (const report of [...this.errorReporters]) safelyCall(() => report(source, err));
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
	subscribe(listener: () => void, onError?: (source: AgentPanelSource, error: Error) => void): () => void {
		this.listeners.add(listener);
		if (onError !== undefined) {
			this.errorReporters.add(onError);
			for (const source of this.sources.keys()) {
				const err = subscribeErrors.get(source);
				if (err !== undefined) safelyCall(() => onError(source, err));
			}
		}
		return () => {
			this.listeners.delete(listener);
			if (onError !== undefined) this.errorReporters.delete(onError);
		};
	}
	dispose(): void {
		const cleanups = [...this.sources.values()];
		this.sources.clear();
		for (const cleanup of cleanups) cleanup();
		this.notify();
		this.listeners.clear();
		this.errorReporters.clear();
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

const cachedTaskItems = new WeakMap<
	TaskRecord,
	{ readonly clocks: TaskElapsedClocks | undefined; readonly item: AgentPanelItem }
>();

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
	const sourceClocks = taskClockOf(source);
	return source.backgroundTasks
		.filter((task) => !dismissed.has(task.ref.taskId) && (!topLevelOnly || task.parentTaskId === undefined))
		.map((task): AgentPanelItem => {
			const clocks = sourceClocks ?? taskClockOf(task);
			const cached = cachedTaskItems.get(task);
			if (cached !== undefined && cached.clocks === clocks) return cached.item;
			const state = taskState(task);
			const question = task.attention.kind === "input-needed" ? task.attention.prompt : undefined;
			const item: AgentPanelItem = {
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
			if (clocks !== undefined) bindTaskClock(item, clocks);
			cachedTaskItems.set(task, { clocks, item });
			return item;
		});
}

const reportedSources = new WeakSet<AgentPanelSource>();

function cleanReasonText(text: string): string {
	if (!/[\x00-\x1f\x7f-\x9f\p{Default_Ignorable_Code_Point}\u2028\u2029]/u.test(text)) return text;
	return sanitizeTerminalText(text)
		.replace(/\p{Default_Ignorable_Code_Point}/gu, "")
		.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");
}

function sourceError(error: unknown): Error {
	try {
		return new Error(cleanReasonText(error instanceof Error ? String(error.message) : String(error)));
	} catch {
		return new Error("Agent panel source failed.");
	}
}

function reasonText(reason: unknown): string {
	return typeof reason === "string" ? cleanReasonText(reason) : sourceError(reason).message;
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
const optionalBoolean = (v: unknown) => v === undefined || typeof v === "boolean";

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
		optionalBoolean(item.viewed) &&
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
	const subscribeError = subscribeErrors.get(source);
	if (subscribeError !== undefined) report(subscribeError);
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
					...(item.viewed === undefined ? {} : { viewed: item.viewed }),
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
const viewedBySession = new WeakMap<object, Set<string>>();
const hubBindingListeners = new WeakMap<object, Set<() => void>>();

export function dismissedAgentPanelItems(session: object): Set<string> {
	let dismissed = dismissedBySession.get(session);
	if (dismissed === undefined) {
		dismissed = new Set();
		dismissedBySession.set(session, dismissed);
	}
	return dismissed;
}

export function viewedAgentPanelItems(session: object): Set<string> {
	let viewed = viewedBySession.get(session);
	if (viewed === undefined) {
		viewed = new Set();
		viewedBySession.set(session, viewed);
	}
	return viewed;
}

export function notifyAgentPanelSourceHubRebound(session: object): void {
	for (const listener of [...(hubBindingListeners.get(session) ?? [])]) safelyCall(listener);
}

export function watchAgentPanelSourceHubBinding(session: object, listener: () => void): () => void {
	let listeners = hubBindingListeners.get(session);
	if (listeners === undefined) {
		listeners = new Set();
		hubBindingListeners.set(session, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function dismissedTaskIds(session: object): Set<TaskId> {
	const ids = new Set<TaskId>();
	for (const id of dismissedAgentPanelItems(session)) {
		const taskId = agentPanelTaskId(id);
		if (taskId !== undefined) ids.add(taskId);
	}
	return ids;
}

function sourceErrorReporter(session: AgentPanelSession): ((error: Error) => void) | undefined {
	const report = session.extensionRunner?.emitError;
	if (report === undefined) return undefined;
	return (error: Error) =>
		safelyCall(() =>
			report.call(session.extensionRunner, {
				extensionPath: "agent panel source",
				event: "agent_panel",
				error: error.message,
			}),
		);
}

export function agentPanelExtensionItems(session: AgentPanelSession & object): AgentPanelItem[] {
	const dismissed = dismissedAgentPanelItems(session);
	const viewed = viewedBySession.get(session);
	const onSourceError = sourceErrorReporter(session);
	const all = (hubOf(session)?.all() ?? []).flatMap((source) => sourceItems(source, onSourceError));
	if (viewed !== undefined && viewed.size > 0) {
		const liveIds = new Set(all.map((item) => item.id));
		for (const id of [...viewed]) {
			if (!liveIds.has(id)) viewed.delete(id);
		}
	}
	return all.filter((item) => !dismissed.has(item.id));
}

export function agentPanelItems(session: AgentPanelSession & object): AgentPanelItem[] {
	const store = getOwnerTaskStore(session);
	const tasks = store === undefined ? [] : taskPanelItems(ownerTaskViewSource(store), dismissedTaskIds(session));
	return [...agentPanelExtensionItems(session), ...tasks];
}

export function subscribeAgentPanelExtensions(session: AgentPanelSession, listener: () => void): () => void {
	let currentHub: AgentPanelSourceHub | undefined;
	let unsubscribeHub = () => {};
	const bind = (): void => {
		const nextHub = hubOf(session);
		if (nextHub === currentHub) return;
		unsubscribeHub();
		currentHub = nextHub;
		const onSourceError = sourceErrorReporter(session);
		const onHubSourceError =
			onSourceError === undefined
				? undefined
				: (source: AgentPanelSource, error: Error) => {
						if (reportedSources.has(source)) return;
						reportedSources.add(source);
						onSourceError(error);
					};
		unsubscribeHub = currentHub?.subscribe(listener, onHubSourceError) ?? (() => {});
	};
	bind();
	const unwatch =
		typeof session === "object" && session !== null
			? watchAgentPanelSourceHubBinding(session, () => {
					bind();
					listener();
				})
			: () => {};
	return () => {
		unwatch();
		unsubscribeHub();
	};
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
	const reportError = sourceErrorReporter(session);
	try {
		const source = sourceOf(session, id);
		if (source?.open === undefined) return false;
		const result = source.open(id, options);
		void Promise.resolve(result).catch((error) => reportError?.(sourceError(error)));
		if (result === false) return false;
		if (typeof session === "object" && session !== null) {
			viewedAgentPanelItems(session).add(id);
		}
		return true;
	} catch (error) {
		reportError?.(sourceError(error));
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
			return result.ok ? { ok: true } : { ok: false, reason: cleanReasonText(result.error.message) };
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
