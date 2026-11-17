/**
 * What the agent panel below the main chat's prompt and `/tasks` list: one item per running or recent background
 * subagent, shell and workflow run of a session. The session's own tasks are built in; extensions add their own
 * items, as the workflows extension adds runs, with `pi.registerAgentPanelSource()`.
 */

import { types } from "node:util";
import { sanitizeTerminalText } from "../../utils/terminal-text.ts";
import type { ExtensionError } from "../extensions/runtime-types.ts";
import type { TaskId, TaskRecord } from "./contracts.js";
import { bindTaskClock, TaskElapsedClocks, taskClockOf, taskClockRunning } from "./live-elapsed.ts";
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
	/** Identifies the question it asks, so an answer typed for an earlier question is refused. */
	readonly promptId?: string;
	/** A failed item's one-line reason. */
	readonly reason?: string;
	/** Messages typed to it that it has not taken yet. */
	readonly queued?: number;
	/** When it finished, for finished items. */
	readonly endedAt?: number;
	/** Whether its view was already opened, so a finished item can leave the panel. */
	readonly viewed?: boolean;
}

export interface AgentPanelOpenOptions {
	readonly onReturn?: () => void;
}

/** The question an answer was typed for, so a source can refuse an answer to a question it no longer asks. */
export interface AgentPanelAnswerOptions {
	readonly promptId?: string;
	readonly question?: string;
	readonly choices?: readonly string[];
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
	/** Answers a waiting item's question with `text`; `options` names the question it was typed for. */
	answer?(id: string, text: string, options?: AgentPanelAnswerOptions): Promise<AgentPanelActionResult>;
}

/** The registration `pi.registerAgentPanelSource()` returns; disposed with its extension generation. */
export interface AgentPanelSourceRegistration {
	dispose(): void;
}

const hubWatchers = new Set<(notifiedHub?: AgentPanelSourceHub) => void>();
interface SourceVersion {
	current: number;
}
const sourceVersions = new WeakMap<AgentPanelSource, SourceVersion>();

function sourceVersion(source: AgentPanelSource): SourceVersion {
	let version = sourceVersions.get(source);
	if (version === undefined) {
		version = { current: 0 };
		sourceVersions.set(source, version);
	}
	return version;
}

function notifyHubWatchers(notifiedHub?: AgentPanelSourceHub): void {
	if (hubWatchers.size === 0) return;
	for (const watcher of [...hubWatchers]) safelyCall(() => watcher(notifiedHub));
}

let sourcesGeneration = 0;

/**
 * Changes whenever any source's items may have changed, or a source registers or leaves: a view that ranked the
 * panel's items for one generation can reuse that ranking, without reading the items again, until it changes.
 */
export function agentPanelSourcesGeneration(): number {
	return sourcesGeneration;
}

function bumpSourceVersion(source: AgentPanelSource): void {
	sourceVersion(source).current++;
	sourcesGeneration++;
}

function bumpHubSources(hub: AgentPanelSourceHub | undefined): void {
	if (hub === undefined) return;
	for (const source of hub.all()) bumpSourceVersion(source);
}

export class AgentPanelSourceHub {
	private readonly sources = new Map<AgentPanelSource, () => void>();
	private readonly listeners = new Set<() => void>();
	private readonly regIds = new Map<AgentPanelSource, number>();
	private readonly errorReporters = new Set<(source: AgentPanelSource, error: Error) => void>();
	private readonly failedSources = new Map<AgentPanelSource, Error>();
	private nextRegId = 0;
	private disposing = false;
	private reportSubscribeFailure(source: AgentPanelSource, error: Error): void {
		this.failedSources.set(source, error);
		for (const report of [...this.errorReporters]) safelyCall(() => report(source, error));
	}
	register(source: AgentPanelSource): AgentPanelSourceRegistration {
		if (this.disposing) return { dispose() {} };
		const version = sourceVersion(source);
		const regId = ++this.nextRegId;
		this.regIds.set(source, regId);
		let unsubscribe: () => void;
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			safelyCall(unsubscribe);
		};
		try {
			const subscribe = readPanelField(source, "subscribe");
			if (typeof subscribe !== "function") {
				if (this.regIds.get(source) === regId) this.regIds.delete(source);
				this.reportSubscribeFailure(source, new Error("Invalid agent panel source subscription."));
				return { dispose() {} };
			}
			const result: unknown = Reflect.apply(subscribe, source, [
				() => {
					if (this.sources.get(source) !== cleanup) return;
					version.current++;
					sourcesGeneration++;
					this.notify();
				},
			]);
			if (drainThenable(result) || typeof result !== "function") {
				if (this.regIds.get(source) === regId) this.regIds.delete(source);
				this.reportSubscribeFailure(source, new Error("Invalid agent panel source subscription."));
				return { dispose() {} };
			}
			unsubscribe = result as () => void;
		} catch (error) {
			drainCaught(error);
			if (this.regIds.get(source) === regId) this.regIds.delete(source);
			this.reportSubscribeFailure(source, sourceError(error));
			return { dispose() {} };
		}
		if (this.regIds.get(source) !== regId) {
			cleanup();
			return { dispose() {} };
		}
		const previous = this.sources.get(source);
		this.sources.set(source, cleanup);
		this.failedSources.delete(source);
		reportedSources.delete(source);
		bumpSourceVersion(source);
		previous?.();
		notifyHubWatchers(this);
		this.notify();
		return {
			dispose: () => {
				if (this.sources.get(source) !== cleanup) return;
				this.sources.delete(source);
				this.regIds.delete(source);
				bumpSourceVersion(source);
				cleanup();
				notifyHubWatchers(this);
				this.notify();
			},
		};
	}
	all(): readonly AgentPanelSource[] {
		return [...this.sources.keys()];
	}
	/**
	 * Calls `listener` when a source registers, leaves or reports a change, and `onError` once for each source whose
	 * subscription failed, including one that failed before this call.
	 */
	subscribe(listener: () => void, onError?: (source: AgentPanelSource, error: Error) => void): () => void {
		this.listeners.add(listener);
		if (onError !== undefined) {
			this.errorReporters.add(onError);
			for (const [source, error] of [...this.failedSources]) safelyCall(() => onError(source, error));
		}
		return () => {
			this.listeners.delete(listener);
			if (onError !== undefined) this.errorReporters.delete(onError);
		};
	}
	dispose(): void {
		this.disposing = true;
		try {
			const sources = [...this.sources.keys()];
			const cleanups = [...this.sources.values()];
			this.sources.clear();
			this.regIds.clear();
			this.failedSources.clear();
			for (const source of sources) bumpSourceVersion(source);
			for (const cleanup of cleanups) cleanup();
			notifyHubWatchers(this);
			this.notify();
			this.listeners.clear();
			this.errorReporters.clear();
		} finally {
			this.disposing = false;
		}
		queueMicrotask(() => {
			notifyHubWatchers(undefined);
		});
	}
	private notify(): void {
		if (this.listeners.size === 0) notifyHubWatchers(this);
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

/** The session's source hub, or undefined when it has none or reading it fails. */
export function agentPanelSourceHubOf(session: AgentPanelSession): AgentPanelSourceHub | undefined {
	return hubOf(session);
}

function hubOf(session: AgentPanelSession): AgentPanelSourceHub | undefined {
	try {
		const hub: unknown = session.extensionRunner?.getAgentPanelSourceHub?.();
		if (drainThenable(hub)) return undefined;
		return hub as AgentPanelSourceHub | undefined;
	} catch (error) {
		drainCaught(error);
		return undefined;
	}
}

const taskPrefix = "task:";

/** What a task's glyph and state word say about it. */
export function taskPanelState(task: TaskRecord): AgentPanelState {
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

const cachedTaskItems = new WeakMap<
	TaskRecord,
	{ readonly taskId: string; readonly clocks: TaskElapsedClocks | undefined; readonly item: AgentPanelItem }
>();
const lazyTaskItems = new WeakMap<
	TaskRecord,
	{ readonly state: AgentPanelState; readonly clocks: TaskElapsedClocks | undefined; readonly item: AgentPanelItem }
>();
const lazyTaskRecords = new WeakMap<
	AgentPanelItem,
	{ readonly task: TaskRecord; readonly clocks: TaskElapsedClocks | undefined }
>();

/**
 * A task's panel item, bound to the clocks of the source it was read from so every view of it shows the same elapsed
 * time. The same item is returned while nothing it shows has changed.
 */
export function taskPanelItem(task: TaskRecord, sourceClocks?: TaskElapsedClocks): AgentPanelItem {
	const clocks = sourceClocks ?? taskClockOf(task);
	const cached = cachedTaskItems.get(task);
	const state = taskPanelState(task);
	const question = task.attention.kind === "input-needed" ? task.attention.prompt || undefined : undefined;
	const kind = task.kind === "agent" ? "agent" : "shell";
	const name = task.kind === "agent" ? (task.agentName ?? "agent") : "shell";
	const title = shortTaskTitle(task.title || "");
	const reason =
		state === "failed" && task.execution.kind === "settled" && task.execution.result.kind === "failed"
			? (task.execution.result.message.split("\n")[0] ?? "")
			: undefined;
	if (
		cached !== undefined &&
		cached.clocks === clocks &&
		cached.taskId === task.ref.taskId &&
		cached.item.kind === kind &&
		cached.item.state === state &&
		cached.item.name === name &&
		cached.item.task === title &&
		cached.item.elapsedMs === task.metrics?.elapsedMs &&
		cached.item.tokens === task.metrics?.tokenCount &&
		cached.item.question === question &&
		cached.item.reason === reason
	)
		return cached.item;
	const item: AgentPanelItem = {
		id: `${taskPrefix}${task.ref.taskId}`,
		kind,
		state,
		name,
		task: title,
		...(task.metrics?.elapsedMs === undefined ? {} : { elapsedMs: task.metrics.elapsedMs }),
		...(task.metrics?.tokenCount === undefined ? {} : { tokens: task.metrics.tokenCount }),
		...(question ? { question } : {}),
		...(reason === undefined ? {} : { reason }),
	};
	if (clocks !== undefined) bindTaskClock(item, clocks);
	cachedTaskItems.set(task, { taskId: task.ref.taskId, clocks, item });
	return item;
}

/** A task's item that builds its name and title only when a view reads them. */
export function lazyTaskPanelItem(task: TaskRecord, sourceClocks?: TaskElapsedClocks): AgentPanelItem {
	const state = taskPanelState(task);
	const cached = lazyTaskItems.get(task);
	if (cached !== undefined && cached.state === state && cached.clocks === sourceClocks) {
		return cached.item;
	}
	const item: AgentPanelItem = {
		id: `${taskPrefix}${task.ref.taskId}`,
		kind: task.kind === "agent" ? "agent" : "shell",
		state,
		get name() {
			return taskPanelItem(task, sourceClocks).name;
		},
		get task() {
			return taskPanelItem(task, sourceClocks).task;
		},
	};
	lazyTaskItems.set(task, { state, clocks: sourceClocks, item });
	lazyTaskRecords.set(item, { task, clocks: sourceClocks });
	return item;
}

/** The whole item a lazy item stands for; any other item as it is. */
export function materializePanelItem(item: AgentPanelItem): AgentPanelItem {
	const entry = lazyTaskRecords.get(item);
	return entry === undefined ? item : taskPanelItem(entry.task, entry.clocks);
}

/**
 * One panel item per background task of `source` that is not in `dismissed`, in admission order. The main chat's panel
 * lists only top-level tasks; a subagent's chat lists the tasks of that subagent, which all have a parent.
 */
export function taskPanelItems(
	source: Pick<TaskViewSource, "backgroundTasks">,
	dismissed: ReadonlySet<TaskId>,
	options: { readonly topLevelOnly?: boolean } = {},
): AgentPanelItem[] {
	const topLevelOnly = options.topLevelOnly ?? true;
	const hasDismissed = dismissed.size > 0;
	const sourceClocks = taskClockOf(source);
	const items: AgentPanelItem[] = [];
	for (const task of source.backgroundTasks) {
		if ((topLevelOnly && task.parentTaskId !== undefined) || (hasDismissed && dismissed.has(task.ref.taskId))) {
			continue;
		}
		items.push(taskPanelItem(task, sourceClocks));
	}
	return items;
}

const reportedSources = new WeakSet<AgentPanelSource>();

/** `text` with terminal controls and invisible characters removed, so a source's reason cannot restyle the screen. */
function cleanReasonText(text: string): string {
	if (!/[\x00-\x1f\x7f-\x9f\p{Default_Ignorable_Code_Point}\u2028\u2029]/u.test(text)) return text;
	return sanitizeTerminalText(text)
		.replace(/\p{Default_Ignorable_Code_Point}/gu, "")
		.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");
}

export function sourceError(error: unknown): Error {
	const raw = rawSourceError(error);
	const message = cleanReasonText(raw.message);
	return message === raw.message ? raw : new Error(message);
}

function rawSourceError(error: unknown): Error {
	if (typeof error === "string") return new Error(error || "Agent panel source failed.");
	if ((typeof error === "object" && error !== null) || typeof error === "function") {
		drainCaught(error);
		let message: unknown;
		try {
			message = (error as { readonly message?: unknown }).message;
		} catch (thrown) {
			drainCaught(thrown);
			return new Error("Agent panel source failed.");
		}
		drainCaught(message);
		return new Error(typeof message === "string" && message.length > 0 ? message : "Agent panel source failed.");
	}
	return new Error(String(error) || "Agent panel source failed.");
}

const drainedPromises = new WeakSet<Promise<unknown>>();

function drainCaught(value: unknown, seen?: Set<object>): void {
	drainThenable(value, seen);
}

function drainThenable(value: unknown, seen?: Set<object>): boolean {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
	if (types.isPromise(value)) {
		if (drainedPromises.has(value)) return true;
		drainedPromises.add(value);
		try {
			Promise.prototype.then.call(
				value,
				(result: unknown) => drainCaught(result),
				(error: unknown) => drainCaught(error),
			);
		} catch (error) {
			drainCaught(error, seen ?? new Set([value]));
		}
		return true;
	}
	if (seen?.has(value)) return true;
	seen?.add(value);
	let then: unknown;
	try {
		then = (value as { readonly then?: unknown }).then;
	} catch (error) {
		drainCaught(error, seen ?? new Set([value]));
		return true;
	}
	if (typeof then !== "function") {
		if (typeof then === "object" && then !== null) {
			drainCaught(then, seen ?? new Set([value]));
		}
		return false;
	}
	const visited = seen ?? new Set([value]);
	const discard = (result: unknown) => drainCaught(result, visited);
	try {
		drainCaught(Reflect.apply(then, value, [discard, discard]), visited);
	} catch (error) {
		drainCaught(error, visited);
	}
	return true;
}

interface SettledSourceResult {
	readonly value: unknown;
}

function settleSourceResult(value: unknown): Promise<SettledSourceResult> {
	return new Promise<SettledSourceResult>((resolve, reject) => {
		const pending = new Set<object>();
		const settle = (result: unknown): void => {
			if ((typeof result !== "object" && typeof result !== "function") || result === null) {
				resolve({ value: result });
				return;
			}
			if (pending.has(result)) {
				reject(new TypeError("Agent panel source returned a cyclic thenable."));
				return;
			}
			pending.add(result);
			let settled = false;
			const accept = (next: unknown) => {
				if (settled) {
					drainCaught(next);
					return;
				}
				settled = true;
				settle(next);
			};
			const fail = (error: unknown) => {
				drainCaught(error);
				if (settled) return;
				settled = true;
				reject(error);
			};
			try {
				if (types.isPromise(result)) {
					Promise.prototype.then.call(result, accept, fail);
					return;
				}
				const then = (result as { readonly then?: unknown }).then;
				if (typeof then !== "function") {
					drainCaught(then);
					resolve({ value: result });
					return;
				}
				drainCaught(Reflect.apply(then, result, [accept, fail]));
			} catch (error) {
				fail(error);
			}
		};
		settle(value);
	});
}

function safelyCall(callback: () => unknown): boolean {
	try {
		const result = callback();
		drainThenable(result);
		return true;
	} catch (error) {
		drainCaught(error);
		return false;
	}
}

function reportSourceOnce(source: AgentPanelSource, error: Error, onError?: (error: Error) => void): void {
	if (onError === undefined || reportedSources.has(source)) return;
	reportedSources.add(source);
	safelyCall(() => onError(error));
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const MAX_PANEL_CHOICES = 128;
const MAX_PANEL_SOURCE_ITEMS = 10_000;

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readPanelField(item: object, key: PropertyKey): unknown {
	const value = (item as Record<PropertyKey, unknown>)[key];
	drainThenable(value);
	return value;
}

function readPanelProgress(value: unknown): AgentPanelItem["progress"] | false {
	if (value === undefined) return undefined;
	if (drainThenable(value) || typeof value !== "object" || value === null) return false;
	const done = (value as { readonly done?: unknown }).done;
	drainThenable(done);
	const total = (value as { readonly total?: unknown }).total;
	drainThenable(total);
	return isFiniteNonNegative(done) && isFiniteNonNegative(total) ? { done, total } : false;
}

function readPanelChoices(value: unknown): string[] | false | undefined {
	if (value === undefined) return undefined;
	if (drainThenable(value) || !Array.isArray(value)) return false;
	const length = value.length;
	drainThenable(length);
	if (!isNonNegativeInteger(length)) return false;
	const count = Math.min(length, MAX_PANEL_CHOICES);
	const choices: string[] = [];
	let valid = length <= MAX_PANEL_CHOICES;
	for (let index = 0; index < count; index++) {
		const choice: unknown = value[index];
		drainThenable(choice);
		if (typeof choice === "string") choices.push(choice);
		else valid = false;
	}
	return valid ? choices : false;
}

function validateItem(raw: unknown, readAt: number): AgentPanelItem | undefined {
	if (drainThenable(raw) || typeof raw !== "object" || raw === null) return undefined;
	const row = raw as Partial<Record<keyof AgentPanelItem, unknown>>;
	const id = row.id;
	drainThenable(id);
	const kind = row.kind;
	drainThenable(kind);
	const state = row.state;
	drainThenable(state);
	const name = row.name;
	drainThenable(name);
	const task = row.task;
	drainThenable(task);
	const elapsedMs = row.elapsedMs;
	drainThenable(elapsedMs);
	const tokens = row.tokens;
	drainThenable(tokens);
	const rawProgress = row.progress;
	drainThenable(rawProgress);
	const progress = readPanelProgress(rawProgress);
	const question = row.question;
	drainThenable(question);
	const rawChoices = row.choices;
	drainThenable(rawChoices);
	const choices = readPanelChoices(rawChoices);
	const promptId = row.promptId;
	drainThenable(promptId);
	const reason = row.reason;
	drainThenable(reason);
	const viewed = row.viewed;
	drainThenable(viewed);
	const queued = row.queued;
	drainThenable(queued);
	const endedAt = row.endedAt;
	drainThenable(endedAt);

	if (
		typeof id !== "string" ||
		id.length === 0 ||
		id === "main" ||
		id.startsWith(taskPrefix) ||
		(kind !== "agent" && kind !== "shell" && kind !== "workflow") ||
		(state !== "running" &&
			state !== "queued" &&
			state !== "input" &&
			state !== "paused" &&
			state !== "stopping" &&
			state !== "done" &&
			state !== "failed" &&
			state !== "stopped") ||
		typeof name !== "string" ||
		typeof task !== "string" ||
		(elapsedMs !== undefined && !isFiniteNonNegative(elapsedMs)) ||
		(tokens !== undefined && !isNonNegativeInteger(tokens)) ||
		(queued !== undefined && !isNonNegativeInteger(queued)) ||
		(endedAt !== undefined && !isFiniteNonNegative(endedAt)) ||
		(question !== undefined && typeof question !== "string") ||
		(promptId !== undefined && typeof promptId !== "string") ||
		(reason !== undefined && typeof reason !== "string") ||
		(viewed !== undefined && typeof viewed !== "boolean") ||
		progress === false ||
		choices === false
	) {
		return undefined;
	}

	const item: { -readonly [Key in keyof AgentPanelItem]: AgentPanelItem[Key] } = {
		id,
		kind,
		state,
		name,
		task,
	};
	if (elapsedMs !== undefined) item.elapsedMs = elapsedMs;
	if (tokens !== undefined) item.tokens = tokens;
	if (progress !== undefined) item.progress = progress;
	if (question !== undefined) item.question = question;
	if (choices !== undefined) item.choices = choices;
	if (promptId !== undefined) item.promptId = promptId;
	if (reason !== undefined) item.reason = reason;
	if (queued !== undefined) item.queued = queued;
	if (endedAt !== undefined) item.endedAt = endedAt;
	if (viewed !== undefined) item.viewed = viewed;
	if (elapsedMs !== undefined && (state === "running" || state === "input" || state === "stopping")) {
		itemSampleTimes.set(item, readAt);
	}
	return item;
}

interface SourceCacheEntry {
	readonly version: number;
	readonly items: readonly AgentPanelItem[];
	readonly error?: Error;
}

const sourceCache = new WeakMap<AgentPanelSource, SourceCacheEntry>();
const itemSampleTimes = new WeakMap<AgentPanelItem, number>();

export function agentPanelItemReadAt(item: AgentPanelItem): number | undefined {
	return itemSampleTimes.get(item);
}

function readPanelIterable(rawItems: object): readonly unknown[] {
	const iterate = readPanelField(rawItems, Symbol.iterator);
	if (typeof iterate !== "function") {
		throw new TypeError("Agent panel source items must be an iterable object.");
	}
	const iterator: unknown = Reflect.apply(iterate, rawItems, []);
	if (drainThenable(iterator) || typeof iterator !== "object" || iterator === null) {
		throw new TypeError("Agent panel source iterator must be synchronous.");
	}
	const next = readPanelField(iterator, "next");
	if (typeof next !== "function") throw new TypeError("Invalid agent panel source iterator.");
	const rows: unknown[] = [];
	while (rows.length <= MAX_PANEL_SOURCE_ITEMS) {
		const step: unknown = Reflect.apply(next, iterator, []);
		if (drainThenable(step) || typeof step !== "object" || step === null) {
			throw new TypeError("Agent panel source iterator steps must be synchronous objects.");
		}
		const done = (step as { readonly done?: unknown }).done;
		if (drainThenable(done)) throw new TypeError("Agent panel source iterator state must be synchronous.");
		if (done) return rows;
		const value = (step as { readonly value?: unknown }).value;
		drainThenable(value);
		rows.push(value);
	}
	safelyCall(() => {
		const close = readPanelField(iterator, "return");
		if (typeof close === "function") return Reflect.apply(close, iterator, []);
	});
	return rows;
}

function readSourceSnapshot(source: AgentPanelSource): SourceCacheEntry {
	const readAt = Date.now();
	try {
		const itemsMethod = readPanelField(source, "items");
		if (typeof itemsMethod !== "function") {
			throw new TypeError("Agent panel source items must be a function.");
		}
		const rawItems: unknown = Reflect.apply(itemsMethod, source, []);
		if (drainThenable(rawItems) || typeof rawItems !== "object" || rawItems === null) {
			throw new TypeError("Agent panel source items must be an iterable object.");
		}
		const items: AgentPanelItem[] = [];
		const seenIds = new Set<string>();
		let validationError: Error | undefined;
		const rawRows: readonly unknown[] = Array.isArray(rawItems) ? rawItems : readPanelIterable(rawItems);
		const length = rawRows.length;
		drainThenable(length);
		if (!isNonNegativeInteger(length)) throw new TypeError("Invalid agent panel source length.");
		if (length > MAX_PANEL_SOURCE_ITEMS) {
			validationError = new Error(`Agent panel source exceeds ${MAX_PANEL_SOURCE_ITEMS} items.`);
		}
		const count = Math.min(length, MAX_PANEL_SOURCE_ITEMS);
		for (let index = 0; index < count; index++) {
			let validated: AgentPanelItem | undefined;
			try {
				validated = validateItem(rawRows[index], readAt);
			} catch (error) {
				drainCaught(error);
				validationError ??= sourceError(error);
				continue;
			}
			if (validated === undefined) {
				validationError ??= new Error("Invalid agent panel item.");
				continue;
			}
			const before = seenIds.size;
			seenIds.add(validated.id);
			if (seenIds.size === before) {
				validationError ??= new Error(`Duplicate agent panel item id "${validated.id}".`);
				continue;
			}
			items.push(validated);
		}
		return {
			version: sourceVersions.get(source)?.current ?? 0,
			items,
			error: validationError,
		};
	} catch (error) {
		return {
			version: sourceVersions.get(source)?.current ?? 0,
			items: [],
			error: sourceError(error),
		};
	}
}

function readSourceCache(source: AgentPanelSource): SourceCacheEntry {
	const version = sourceVersions.get(source)?.current ?? 0;
	const cached = sourceCache.get(source);
	if (cached !== undefined && cached.version === version) return cached;
	let entry = readSourceSnapshot(source);
	if (entry.version !== version) {
		entry = readSourceSnapshot(source);
	}
	sourceCache.set(source, entry);
	return entry;
}

function sourceItems(source: AgentPanelSource, onError?: (error: Error) => void): readonly AgentPanelItem[] {
	const entry = readSourceCache(source);
	if (entry.error !== undefined) reportSourceOnce(source, entry.error, onError);
	return entry.items;
}

export function agentPanelTaskId(id: string): TaskId | undefined {
	return typeof id === "string" && id.startsWith(taskPrefix) ? (id.slice(taskPrefix.length) as TaskId) : undefined;
}

const dismissedBySession = new WeakMap<object, Set<string>>();
const EMPTY_TASK_IDS: ReadonlySet<TaskId> = new Set();

export function dismissedAgentPanelItems(session: object): Set<string> {
	let dismissed = dismissedBySession.get(session);
	if (dismissed === undefined) {
		dismissed = new Set();
		dismissedBySession.set(session, dismissed);
	}
	return dismissed;
}

function dismissedTaskIds(session: object): ReadonlySet<TaskId> {
	const dismissed = dismissedAgentPanelItems(session);
	if (dismissed.size === 0) return EMPTY_TASK_IDS;
	const ids = new Set<TaskId>();
	for (const id of dismissed) {
		const taskId = agentPanelTaskId(id);
		if (taskId !== undefined) ids.add(taskId);
	}
	return ids;
}

const viewedBySession = new WeakMap<object, Set<string>>();
const hubBindingListeners = new WeakMap<object, Set<() => void>>();

/** The ids of the session's items whose view was opened, so a finished one can leave the panel. */
export function viewedAgentPanelItems(session: object): Set<string> {
	let viewed = viewedBySession.get(session);
	if (viewed === undefined) {
		viewed = new Set();
		viewedBySession.set(session, viewed);
	}
	return viewed;
}

/** Tells the session's panel subscribers that its extension runner now serves a different source hub. */
export function notifyAgentPanelSourceHubRebound(session: object): void {
	for (const listener of [...(hubBindingListeners.get(session) ?? [])]) safelyCall(listener);
}

/** Calls `listener` whenever {@link notifyAgentPanelSourceHubRebound} reports a new hub for `session`. */
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

function sourceErrorReporter(session: AgentPanelSession): ((error: Error) => void) | undefined {
	let report: ((error: ExtensionError) => void) | undefined;
	try {
		report = session.extensionRunner?.emitError;
	} catch (error) {
		drainCaught(error);
		return undefined;
	}
	if (typeof report !== "function") return undefined;
	const emit = report;
	return (error: Error) =>
		safelyCall(() =>
			Reflect.apply(emit, session.extensionRunner, [
				{ extensionPath: "agent panel source", event: "agent_panel", error: error.message },
			]),
		);
}

const extensionClocksBySession = new WeakMap<object, TaskElapsedClocks>();

function sessionExtensionClocks(session: object): TaskElapsedClocks {
	let clocks = extensionClocksBySession.get(session);
	if (clocks === undefined) {
		clocks = new TaskElapsedClocks();
		extensionClocksBySession.set(session, clocks);
	}
	return clocks;
}

/** Reads every source of the session once, so a source's failure is reported even while nothing shows its items. */
export function sampleAgentPanelSources(
	session: AgentPanelSession & object,
	onSourceError?: (error: Error) => void,
): void {
	const report = onSourceError ?? sourceErrorReporter(session);
	for (const source of hubOf(session)?.all() ?? []) sourceItems(source, report);
}

/**
 * The items the session's extensions list (workflow runs, an extension's agents and shells), without its own tasks and
 * dismissed items. An item's id is listed once, from the first source that has it; agent and shell items share one
 * clock per session, so every view shows the same elapsed time.
 */
export function agentPanelExtensionItems(
	session: AgentPanelSession & object,
	onSourceError?: (error: Error) => void,
): AgentPanelItem[] {
	const report = onSourceError ?? sourceErrorReporter(session);
	const dismissed = dismissedAgentPanelItems(session);
	const hasDismissed = dismissed.size > 0;
	const sources = hubOf(session)?.all() ?? [];
	const items: AgentPanelItem[] = [];
	const seenIds = sources.length > 1 ? new Set<string>() : undefined;
	for (const source of sources) {
		for (const item of sourceItems(source, report)) {
			if (seenIds !== undefined) {
				if (seenIds.has(item.id)) {
					reportSourceOnce(source, new Error(`Duplicate agent panel item id "${item.id}".`), report);
					continue;
				}
				seenIds.add(item.id);
			}
			items.push(item);
		}
	}
	const clocks = extensionClocksBySession.get(session);
	let clockIds: Set<string> | undefined;
	for (const item of items) {
		if (item.kind === "workflow" || item.state === "queued") continue;
		const owned = sessionExtensionClocks(session);
		clockIds ??= new Set();
		clockIds.add(item.id);
		bindTaskClock(item, owned);
		owned.elapsedMs(item.id, item.elapsedMs, taskClockRunning(item.state), agentPanelItemReadAt(item));
	}
	if (clockIds !== undefined) extensionClocksBySession.get(session)?.prune(clockIds);
	else clocks?.clear();
	const viewed = viewedBySession.get(session);
	if (viewed !== undefined && viewed.size > 0) {
		const liveIds = new Set(items.map((item) => item.id));
		for (const id of [...viewed]) if (!liveIds.has(id)) viewed.delete(id);
	}
	return hasDismissed ? items.filter((item) => !dismissed.has(item.id)) : items;
}

/** The session's items: its extensions' first, then its own top-level background tasks. */
export function agentPanelItems(
	session: AgentPanelSession & object,
	onSourceError?: (error: Error) => void,
): AgentPanelItem[] {
	const extensions = agentPanelExtensionItems(session, onSourceError);
	const store = getOwnerTaskStore(session);
	if (store === undefined) return extensions;
	const tasks = taskPanelItems(ownerTaskViewSource(store), dismissedTaskIds(session));
	if (extensions.length === 0) return tasks;
	return tasks.length === 0 ? extensions : [...extensions, ...tasks];
}

/**
 * Calls `listener` when the session's extensions' items may have changed, including when its extension runner is
 * bound to a different hub; a failed source subscription is reported once through the session's extension errors.
 */
export function subscribeAgentPanelExtensions(session: AgentPanelSession, listener: () => void): () => void {
	const safeListener = () => {
		safelyCall(listener);
	};
	let currentHub: AgentPanelSourceHub | undefined;
	let unsubscribeHub = () => {};
	const bind = (): boolean => {
		const nextHub = hubOf(session);
		if (nextHub === currentHub) return false;
		unsubscribeHub();
		currentHub = nextHub;
		const onSourceError = sourceErrorReporter(session);
		const onHubSourceError =
			onSourceError === undefined
				? undefined
				: (source: AgentPanelSource, error: Error) => reportSourceOnce(source, error, onSourceError);
		unsubscribeHub = currentHub?.subscribe(safeListener, onHubSourceError) ?? (() => {});
		return true;
	};
	bind();
	const syncHub = (notifiedHub?: AgentPanelSourceHub) => {
		if (bind() && notifiedHub !== currentHub) safeListener();
	};
	hubWatchers.add(syncHub);
	const unwatch =
		typeof session === "object" && session !== null
			? watchAgentPanelSourceHubBinding(session, () => {
					bind();
					safeListener();
				})
			: () => {};
	return () => {
		hubWatchers.delete(syncHub);
		unwatch();
		unsubscribeHub();
	};
}

/** Calls `listener` when any of the session's items may have changed: its task store's or its extensions'. */
export function subscribeAgentPanel(session: AgentPanelSession & object, listener: () => void): () => void {
	const safeListener = () => {
		safelyCall(listener);
	};
	let unsubscribeStore = getOwnerTaskStore(session)?.subscribe(safeListener) ?? (() => {});
	const unwatch = watchOwnerTaskStoreBinding(session, () => {
		unsubscribeStore();
		unsubscribeStore = getOwnerTaskStore(session)?.subscribe(safeListener) ?? (() => {});
		safeListener();
	});
	const unsubscribeHub = subscribeAgentPanelExtensions(session, safeListener);
	return () => {
		unwatch();
		unsubscribeStore();
		unsubscribeHub();
	};
}

/** What an answer typed into a waiting item names: the question it asks, so a stale answer is refused. */
export function promptAnswerOptionsOf(item: AgentPanelItem): AgentPanelAnswerOptions | undefined {
	if (item.state !== "input" || !item.question) return undefined;
	return {
		...(item.promptId === undefined ? {} : { promptId: item.promptId }),
		question: item.question,
		...(item.choices === undefined ? {} : { choices: [...item.choices] }),
	};
}

function sourceOf(session: AgentPanelSession & object, id: string): AgentPanelSource | undefined {
	if (typeof id !== "string" || id.length === 0 || id === "main" || id.startsWith(taskPrefix)) return undefined;
	for (const source of hubOf(session)?.all() ?? []) {
		for (const item of sourceItems(source)) {
			if (item.id === id) return source;
		}
	}
	return undefined;
}

function normalizeActionResult(result: unknown): AgentPanelActionResult {
	if (typeof result !== "object" || result === null) {
		return { ok: false, reason: sourceError(result).message };
	}
	const candidate = result as { readonly ok?: unknown; readonly reason?: unknown };
	const ok = candidate.ok;
	drainThenable(ok);
	if (ok === true) return { ok: true };
	const reason = candidate.reason;
	drainThenable(reason);
	return {
		ok: false,
		reason: typeof reason === "string" ? cleanReasonText(reason) : sourceError(reason).message,
	};
}

export function openAgentPanelItem(
	session: AgentPanelSession & object,
	id: string,
	options?: AgentPanelOpenOptions,
): boolean {
	try {
		if (typeof id !== "string" || id.length === 0) return false;
		const source = sourceOf(session, id);
		const open = source === undefined ? undefined : readPanelField(source, "open");
		if (source === undefined || typeof open !== "function") return false;
		const onReturn = options?.onReturn;
		const wrappedOptions: AgentPanelOpenOptions | undefined =
			onReturn === undefined
				? options
				: {
						...options,
						onReturn: () => {
							bumpHubSources(hubOf(session));
							safelyCall(onReturn);
						},
					};
		bumpSourceVersion(source);
		let opened: unknown;
		const called = safelyCall(() => {
			opened = Reflect.apply(open, source, [id, wrappedOptions]);
			return opened;
		});
		if (!called || opened === false) return false;
		viewedAgentPanelItems(session).add(id);
		return true;
	} catch (error) {
		drainCaught(error);
		return false;
	}
}

export async function stopAgentPanelItem(
	session: AgentPanelSession & object,
	id: string,
): Promise<AgentPanelActionResult> {
	try {
		if (typeof id !== "string" || id.length === 0) {
			return { ok: false, reason: "This item cannot be stopped from here." };
		}
		const source = sourceOf(session, id);
		const taskId = agentPanelTaskId(id);
		if (taskId !== undefined && source === undefined) {
			const store = getOwnerTaskStore(session);
			if (store === undefined) return { ok: false, reason: "This task is no longer kept." };
			const result = await ownerTaskViewSource(store).cancelTask(taskId);
			if (result.ok) return { ok: true };
			const message = result.error?.message;
			return {
				ok: false,
				reason:
					typeof message === "string" && message.length > 0
						? cleanReasonText(message)
						: sourceError(message).message,
			};
		}
		const stop = source === undefined ? undefined : readPanelField(source, "stop");
		if (source === undefined || typeof stop !== "function") {
			return { ok: false, reason: "This item cannot be stopped from here." };
		}
		const result = await settleSourceResult(Reflect.apply(stop, source, [id]));
		bumpSourceVersion(source);
		return normalizeActionResult(result.value);
	} catch (error) {
		return { ok: false, reason: sourceError(error).message };
	}
}

export async function answerAgentPanelItem(
	session: AgentPanelSession & object,
	id: string,
	text: string,
	options?: AgentPanelAnswerOptions,
): Promise<AgentPanelActionResult> {
	try {
		if (typeof id !== "string" || id.length === 0 || typeof text !== "string") {
			return { ok: false, reason: "This item cannot be answered from here." };
		}
		const source = sourceOf(session, id);
		const answer = source === undefined ? undefined : readPanelField(source, "answer");
		if (source === undefined || typeof answer !== "function") {
			return { ok: false, reason: "This item cannot be answered from here." };
		}
		const result = await settleSourceResult(
			Reflect.apply(answer, source, options === undefined ? [id, text] : [id, text, options]),
		);
		bumpSourceVersion(source);
		return normalizeActionResult(result.value);
	} catch (error) {
		return { ok: false, reason: sourceError(error).message };
	}
}
