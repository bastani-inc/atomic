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

const hubWatchers = new Set<(notifiedHub?: AgentPanelSourceHub) => void>();
let nextSourceVersion = 1;
const sourceVersions = new WeakMap<AgentPanelSource, number>();

function bumpSourceVersion(source: AgentPanelSource): void {
	sourceVersions.set(source, ++nextSourceVersion);
}

function bumpHubSources(hub: AgentPanelSourceHub | undefined): void {
	if (hub === undefined) return;
	for (const source of hub.all()) bumpSourceVersion(source);
}

export class AgentPanelSourceHub {
	private readonly sources = new Map<AgentPanelSource, () => void>();
	private readonly listeners = new Set<() => void>();
	private readonly regIds = new Map<AgentPanelSource, number>();
	private nextRegId = 0;
	private disposing = false;
	register(source: AgentPanelSource): AgentPanelSourceRegistration {
		if (this.disposing) return { dispose() {} };
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
			unsubscribe = source.subscribe(() => {
				if (this.sources.get(source) !== cleanup) return;
				bumpSourceVersion(source);
				this.notify();
			});
		} catch {
			if (this.regIds.get(source) === regId) this.regIds.delete(source);
			return { dispose() {} };
		}
		if (this.regIds.get(source) !== regId) {
			cleanup();
			return { dispose() {} };
		}
		const previous = this.sources.get(source);
		this.sources.set(source, cleanup);
		reportedSources.delete(source);
		bumpSourceVersion(source);
		previous?.();
		this.notify();
		return {
			dispose: () => {
				if (this.sources.get(source) !== cleanup) return;
				this.sources.delete(source);
				this.regIds.delete(source);
				bumpSourceVersion(source);
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
		this.disposing = true;
		try {
			const sources = [...this.sources.keys()];
			const cleanups = [...this.sources.values()];
			this.sources.clear();
			this.regIds.clear();
			for (const source of sources) bumpSourceVersion(source);
			for (const cleanup of cleanups) cleanup();
			this.notify();
			this.listeners.clear();
		} finally {
			this.disposing = false;
		}
		queueMicrotask(() => {
			for (const watcher of [...hubWatchers]) safelyCall(() => watcher(undefined));
		});
	}
	private notify(): void {
		for (const watcher of [...hubWatchers]) safelyCall(() => watcher(this));
		for (const listener of [...this.listeners]) safelyCall(listener);
	}
}

export interface AgentPanelSession {
	readonly extensionRunner?: { getAgentPanelSourceHub?(): AgentPanelSourceHub | undefined };
}

function hubOf(session: AgentPanelSession): AgentPanelSourceHub | undefined {
	try {
		return session.extensionRunner?.getAgentPanelSourceHub?.();
	} catch {
		return undefined;
	}
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

export function sourceError(error: unknown): Error {
	try {
		if (typeof error === "string") return new Error(error || "Agent panel source failed.");
		const message = error instanceof Error ? String(error.message) : String(error);
		return new Error(message || "Agent panel source failed.");
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

function reportSourceOnce(source: AgentPanelSource, error: Error, onError?: (error: Error) => void): void {
	if (onError === undefined || reportedSources.has(source)) return;
	reportedSources.add(source);
	safelyCall(() => onError(error));
}

const VALID_KINDS: ReadonlySet<AgentPanelItem["kind"]> = new Set(["agent", "shell", "workflow"]);
const VALID_STATES: ReadonlySet<AgentPanelState> = new Set([
	"running",
	"queued",
	"input",
	"paused",
	"stopping",
	"done",
	"failed",
	"stopped",
]);

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return isFiniteNonNegative(value) && Number.isInteger(value);
}

function validateItem(raw: unknown): AgentPanelItem | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const item = raw as Record<string, unknown>;
	const id = item.id;
	const kind = item.kind;
	const state = item.state;
	const name = item.name;
	const task = item.task;
	const elapsedMs = item.elapsedMs;
	const tokens = item.tokens;
	const progressRaw = item.progress;
	const question = item.question;
	const choicesRaw = item.choices;
	const reason = item.reason;
	const queued = item.queued;
	const endedAt = item.endedAt;

	let progress: { readonly done: number; readonly total: number } | undefined;
	let progressValid = true;
	if (progressRaw !== undefined) {
		if (typeof progressRaw !== "object" || progressRaw === null) {
			progressValid = false;
		} else {
			const done = (progressRaw as { readonly done?: unknown }).done;
			const total = (progressRaw as { readonly total?: unknown }).total;
			if (!isFiniteNonNegative(done) || !isFiniteNonNegative(total)) {
				progressValid = false;
			} else {
				progress = { done, total };
			}
		}
	}

	let choices: string[] | undefined;
	let choicesValid = true;
	if (choicesRaw !== undefined) {
		if (typeof choicesRaw !== "object" || choicesRaw === null) {
			choicesValid = false;
		} else {
			choices = [];
			for (const choice of choicesRaw as Iterable<unknown>) {
				if (typeof choice !== "string") {
					choicesValid = false;
					break;
				}
				choices.push(choice);
			}
		}
	}

	if (!progressValid || !choicesValid) return undefined;
	if (typeof id !== "string" || id.length === 0 || id === "main") return undefined;
	if (typeof kind !== "string" || !VALID_KINDS.has(kind as AgentPanelItem["kind"])) return undefined;
	if (typeof state !== "string" || !VALID_STATES.has(state as AgentPanelState)) return undefined;
	if (typeof name !== "string" || typeof task !== "string") return undefined;
	if (elapsedMs !== undefined && !isFiniteNonNegative(elapsedMs)) return undefined;
	if (tokens !== undefined && !isFiniteNonNegative(tokens)) return undefined;
	if (queued !== undefined && !isNonNegativeInteger(queued)) return undefined;
	if (endedAt !== undefined && !isFiniteNonNegative(endedAt)) return undefined;
	if (question !== undefined && typeof question !== "string") return undefined;
	if (reason !== undefined && typeof reason !== "string") return undefined;

	return {
		id,
		kind: kind as AgentPanelItem["kind"],
		state: state as AgentPanelState,
		name,
		task,
		...(elapsedMs === undefined ? {} : { elapsedMs }),
		...(tokens === undefined ? {} : { tokens }),
		...(progress === undefined ? {} : { progress }),
		...(question === undefined ? {} : { question }),
		...(choices === undefined ? {} : { choices }),
		...(reason === undefined ? {} : { reason }),
		...(queued === undefined ? {} : { queued }),
		...(endedAt === undefined ? {} : { endedAt }),
	};
}

interface SourceCacheEntry {
	readonly version: number;
	readonly items: readonly AgentPanelItem[];
	readonly error?: Error;
}

const sourceCache = new WeakMap<AgentPanelSource, SourceCacheEntry>();

function readSourceCache(source: AgentPanelSource): SourceCacheEntry {
	const version = sourceVersions.get(source) ?? 0;
	const cached = sourceCache.get(source);
	if (cached !== undefined && cached.version === version) return cached;
	try {
		const rawItems = source.items();
		if (typeof rawItems !== "object" || rawItems === null) {
			throw new TypeError("Agent panel source items must be an iterable object.");
		}
		const items: AgentPanelItem[] = [];
		const seenIds = new Set<string>(["main"]);
		let validationError: Error | undefined;
		for (const raw of rawItems) {
			const validated = validateItem(raw);
			if (validated === undefined) {
				validationError ??= new Error("Invalid agent panel item.");
				continue;
			}
			if (seenIds.has(validated.id)) {
				validationError ??= new Error(`Duplicate agent panel item id "${validated.id}".`);
				continue;
			}
			seenIds.add(validated.id);
			items.push(validated);
		}
		const entry: SourceCacheEntry = { version, items, error: validationError };
		sourceCache.set(source, entry);
		return entry;
	} catch (error) {
		const entry: SourceCacheEntry = { version, items: [], error: sourceError(error) };
		sourceCache.set(source, entry);
		return entry;
	}
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

function reservedTaskIds(session: object): Set<string> {
	const ids = new Set<string>(["main"]);
	const store = getOwnerTaskStore(session);
	if (store !== undefined) {
		for (const task of store.tasks) ids.add(`${taskPrefix}${task.ref.taskId}`);
	}
	return ids;
}

export function agentPanelItems(
	session: AgentPanelSession & object,
	onSourceError?: (error: Error) => void,
): AgentPanelItem[] {
	const dismissed = dismissedAgentPanelItems(session);
	const store = getOwnerTaskStore(session);
	const sources = hubOf(session)?.all() ?? [];
	if (store === undefined && dismissed.size === 0 && sources.length === 1) {
		return sourceItems(sources[0]!, onSourceError).slice();
	}
	const tasks = store === undefined ? [] : taskPanelItems(ownerTaskViewSource(store), dismissedTaskIds(session));
	const seenIds = reservedTaskIds(session);
	for (const task of tasks) seenIds.add(task.id);
	const extensions: AgentPanelItem[] = [];
	for (const source of sources) {
		for (const item of sourceItems(source, onSourceError)) {
			if (seenIds.has(item.id)) {
				reportSourceOnce(source, new Error(`Duplicate agent panel item id "${item.id}".`), onSourceError);
				continue;
			}
			seenIds.add(item.id);
			if (!dismissed.has(item.id)) extensions.push(item);
		}
	}
	return [...extensions, ...tasks];
}

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
	let currentHub = hubOf(session);
	let unsubscribeHub = currentHub?.subscribe(safeListener) ?? (() => {});
	const syncHub = (notifiedHub?: AgentPanelSourceHub) => {
		const nextHub = hubOf(session);
		if (nextHub === currentHub) return;
		unsubscribeHub();
		currentHub = nextHub;
		unsubscribeHub = currentHub?.subscribe(safeListener) ?? (() => {});
		if (notifiedHub !== currentHub) safeListener();
	};
	hubWatchers.add(syncHub);
	return () => {
		hubWatchers.delete(syncHub);
		unwatch();
		unsubscribeStore();
		unsubscribeHub();
	};
}

function sourceOf(session: AgentPanelSession & object, id: string): AgentPanelSource | undefined {
	if (typeof id !== "string" || id.length === 0 || id === "main") return undefined;
	const seenIds = reservedTaskIds(session);
	if (seenIds.has(id)) return undefined;
	for (const source of hubOf(session)?.all() ?? []) {
		for (const item of sourceItems(source)) {
			if (seenIds.has(item.id)) continue;
			seenIds.add(item.id);
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
	if (candidate.ok === true) return { ok: true };
	const reason = candidate.reason;
	return {
		ok: false,
		reason: typeof reason === "string" ? reason : sourceError(reason).message,
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
		const open = source?.open;
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
		return safelyCall(() => open.call(source, id, wrappedOptions));
	} catch {
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
				reason: typeof message === "string" && message.length > 0 ? message : sourceError(message).message,
			};
		}
		const stop = source?.stop;
		if (source === undefined || typeof stop !== "function") {
			return { ok: false, reason: "This item cannot be stopped from here." };
		}
		const result = await stop.call(source, id);
		bumpSourceVersion(source);
		return normalizeActionResult(result);
	} catch (error) {
		return { ok: false, reason: sourceError(error).message };
	}
}

export async function answerAgentPanelItem(
	session: AgentPanelSession & object,
	id: string,
	text: string,
): Promise<AgentPanelActionResult> {
	try {
		if (typeof id !== "string" || id.length === 0 || typeof text !== "string") {
			return { ok: false, reason: "This item cannot be answered from here." };
		}
		const source = sourceOf(session, id);
		const answer = source?.answer;
		if (source === undefined || typeof answer !== "function") {
			return { ok: false, reason: "This item cannot be answered from here." };
		}
		const result = await answer.call(source, id, text);
		bumpSourceVersion(source);
		return normalizeActionResult(result);
	} catch (error) {
		return { ok: false, reason: sourceError(error).message };
	}
}
