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

function notifyHubWatchers(notifiedHub?: AgentPanelSourceHub): void {
	if (hubWatchers.size === 0) return;
	for (const watcher of [...hubWatchers]) safelyCall(() => watcher(notifiedHub));
}

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
			const result: unknown = source.subscribe(() => {
				if (this.sources.get(source) !== cleanup) return;
				bumpSourceVersion(source);
				this.notify();
			});
			if (drainThenable(result) || typeof result !== "function") {
				if (this.regIds.get(source) === regId) this.regIds.delete(source);
				return { dispose() {} };
			}
			unsubscribe = result as () => void;
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
			notifyHubWatchers(this);
			this.notify();
			this.listeners.clear();
		} finally {
			this.disposing = false;
		}
		queueMicrotask(() => {
			notifyHubWatchers(undefined);
		});
	}
	private notify(): void {
		for (const listener of [...this.listeners]) safelyCall(listener);
	}
}

export interface AgentPanelSession {
	readonly extensionRunner?: { getAgentPanelSourceHub?(): AgentPanelSourceHub | undefined };
}

function hubOf(session: AgentPanelSession): AgentPanelSourceHub | undefined {
	try {
		const hub: unknown = session.extensionRunner?.getAgentPanelSourceHub?.();
		if (drainThenable(hub)) return undefined;
		return hub as AgentPanelSourceHub | undefined;
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
): AgentPanelItem[] {
	const topLevelOnly = options.topLevelOnly ?? true;
	const hasDismissed = dismissed.size > 0;
	const items: AgentPanelItem[] = [];
	for (const task of source.backgroundTasks) {
		if ((topLevelOnly && task.parentTaskId !== undefined) || (hasDismissed && dismissed.has(task.ref.taskId))) {
			continue;
		}
		const state = taskState(task);
		const item: {
			id: string;
			kind: AgentPanelItem["kind"];
			state: AgentPanelState;
			name: string;
			task: string;
			elapsedMs?: number;
			tokens?: number;
			question?: string;
			reason?: string;
		} = {
			id: `${taskPrefix}${task.ref.taskId}`,
			kind: task.kind === "agent" ? "agent" : "shell",
			state,
			name: task.kind === "agent" ? (task.agentName ?? "agent") : "shell",
			task: shortTaskTitle(task.title || ""),
		};
		const elapsedMs = task.metrics?.elapsedMs;
		if (elapsedMs !== undefined) item.elapsedMs = elapsedMs;
		const tokens = task.metrics?.tokenCount;
		if (tokens !== undefined) item.tokens = tokens;
		if (task.attention.kind === "input-needed" && task.attention.prompt) {
			item.question = task.attention.prompt;
		}
		if (state === "failed" && task.execution.kind === "settled" && task.execution.result.kind === "failed") {
			item.reason = task.execution.result.message.split("\n")[0] ?? "";
		}
		items.push(item);
	}
	return items;
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

function drainThenable(value: unknown): boolean {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
	try {
		const then = (value as { readonly then?: unknown }).then;
		if (typeof then !== "function") return false;
		void Promise.resolve(value).catch(() => {});
		return true;
	} catch {
		return true;
	}
}

function safelyCall(callback: () => unknown): boolean {
	try {
		const result = callback();
		drainThenable(result);
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

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function drainReadFields(
	raw: unknown,
	id: unknown,
	kind: unknown,
	state: unknown,
	name: unknown,
	task: unknown,
	elapsedMs: unknown,
	tokens: unknown,
	progressRaw: unknown,
	question: unknown,
	choicesRaw: unknown,
	reason: unknown,
	queued: unknown,
	endedAt: unknown,
): undefined {
	drainThenable(raw);
	drainThenable(id);
	drainThenable(kind);
	drainThenable(state);
	drainThenable(name);
	drainThenable(task);
	drainThenable(elapsedMs);
	drainThenable(tokens);
	drainThenable(question);
	drainThenable(reason);
	drainThenable(queued);
	drainThenable(endedAt);
	if (!drainThenable(progressRaw) && typeof progressRaw === "object" && progressRaw !== null) {
		try {
			drainThenable((progressRaw as { readonly done?: unknown }).done);
		} catch {}
		try {
			drainThenable((progressRaw as { readonly total?: unknown }).total);
		} catch {}
	}
	if (!drainThenable(choicesRaw) && Array.isArray(choicesRaw)) {
		const len = choicesRaw.length;
		for (let i = 0; i < len; i++) {
			try {
				drainThenable(choicesRaw[i]);
			} catch {}
		}
	}
	return undefined;
}

function validateItem(raw: unknown): AgentPanelItem | undefined {
	if (typeof raw !== "object" || raw === null) {
		drainThenable(raw);
		return undefined;
	}
	const rawThenable = drainThenable(raw);
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

	if (
		rawThenable ||
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
		(reason !== undefined && typeof reason !== "string")
	) {
		return drainReadFields(
			raw,
			id,
			kind,
			state,
			name,
			task,
			elapsedMs,
			tokens,
			progressRaw,
			question,
			choicesRaw,
			reason,
			queued,
			endedAt,
		);
	}

	let progress: { readonly done: number; readonly total: number } | undefined;
	if (progressRaw !== undefined) {
		if (drainThenable(progressRaw) || typeof progressRaw !== "object" || progressRaw === null) {
			return drainReadFields(
				raw,
				id,
				kind,
				state,
				name,
				task,
				elapsedMs,
				tokens,
				progressRaw,
				question,
				choicesRaw,
				reason,
				queued,
				endedAt,
			);
		}
		const done = (progressRaw as { readonly done?: unknown }).done;
		const total = (progressRaw as { readonly total?: unknown }).total;
		if (!isFiniteNonNegative(done) || !isFiniteNonNegative(total)) {
			drainThenable(done);
			drainThenable(total);
			return drainReadFields(
				raw,
				id,
				kind,
				state,
				name,
				task,
				elapsedMs,
				tokens,
				progressRaw,
				question,
				choicesRaw,
				reason,
				queued,
				endedAt,
			);
		}
		progress = { done, total };
	}

	let choices: string[] | undefined;
	if (choicesRaw !== undefined) {
		if (drainThenable(choicesRaw) || !Array.isArray(choicesRaw)) {
			return drainReadFields(
				raw,
				id,
				kind,
				state,
				name,
				task,
				elapsedMs,
				tokens,
				undefined,
				question,
				choicesRaw,
				reason,
				queued,
				endedAt,
			);
		}
		const len = choicesRaw.length;
		choices = new Array<string>(len);
		for (let i = 0; i < len; i++) {
			const choice: unknown = choicesRaw[i];
			if (typeof choice !== "string") {
				drainThenable(choice);
				for (let j = i + 1; j < len; j++) {
					try {
						drainThenable(choicesRaw[j]);
					} catch {}
				}
				return undefined;
			}
			choices[i] = choice;
		}
	}

	const validated: {
		id: string;
		kind: AgentPanelItem["kind"];
		state: AgentPanelState;
		name: string;
		task: string;
		elapsedMs?: number;
		tokens?: number;
		progress?: { readonly done: number; readonly total: number };
		question?: string;
		choices?: readonly string[];
		reason?: string;
		queued?: number;
		endedAt?: number;
	} = {
		id,
		kind,
		state,
		name,
		task,
	};
	if (elapsedMs !== undefined) validated.elapsedMs = elapsedMs;
	if (tokens !== undefined) validated.tokens = tokens;
	if (progress !== undefined) validated.progress = progress;
	if (question !== undefined) validated.question = question;
	if (choices !== undefined) validated.choices = choices;
	if (reason !== undefined) validated.reason = reason;
	if (queued !== undefined) validated.queued = queued;
	if (endedAt !== undefined) validated.endedAt = endedAt;
	return validated;
}

interface SourceCacheEntry {
	readonly version: number;
	readonly items: readonly AgentPanelItem[];
	readonly error?: Error;
}

const sourceCache = new WeakMap<AgentPanelSource, SourceCacheEntry>();
const itemReadAt = new WeakMap<AgentPanelItem, number>();

export function agentPanelItemReadAt(item: AgentPanelItem): number | undefined {
	return itemReadAt.get(item);
}

function readSourceCache(source: AgentPanelSource): SourceCacheEntry {
	const version = sourceVersions.get(source) ?? 0;
	const cached = sourceCache.get(source);
	if (cached !== undefined && cached.version === version) return cached;
	const readAt = Date.now();
	try {
		const rawItems: unknown = source.items();
		if (drainThenable(rawItems) || typeof rawItems !== "object" || rawItems === null) {
			throw new TypeError("Agent panel source items must be an iterable object.");
		}
		const items: AgentPanelItem[] = [];
		const seenIds = new Set<string>();
		let validationError: Error | undefined;
		for (const raw of rawItems as Iterable<unknown>) {
			let validated: AgentPanelItem | undefined;
			try {
				validated = validateItem(raw);
			} catch (error) {
				validationError ??= sourceError(error);
				continue;
			}
			if (validated === undefined) {
				validationError ??= new Error("Invalid agent panel item.");
				continue;
			}
			if (seenIds.has(validated.id)) {
				validationError ??= new Error(`Duplicate agent panel item id "${validated.id}".`);
				continue;
			}
			seenIds.add(validated.id);
			itemReadAt.set(validated, readAt);
			items.push(validated);
		}
		const entry: SourceCacheEntry = {
			version: sourceVersions.get(source) ?? 0,
			items,
			error: validationError,
		};
		sourceCache.set(source, entry);
		return entry;
	} catch (error) {
		const entry: SourceCacheEntry = {
			version: sourceVersions.get(source) ?? 0,
			items: [],
			error: sourceError(error),
		};
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

export function agentPanelItems(
	session: AgentPanelSession & object,
	onSourceError?: (error: Error) => void,
): AgentPanelItem[] {
	const dismissed = dismissedAgentPanelItems(session);
	const hasDismissed = dismissed.size > 0;
	const store = getOwnerTaskStore(session);
	const sources = hubOf(session)?.all() ?? [];
	if (sources.length === 0) {
		return store === undefined ? [] : taskPanelItems(ownerTaskViewSource(store), dismissedTaskIds(session));
	}
	if (sources.length === 1) {
		const rawExtensions = sourceItems(sources[0]!, onSourceError);
		const extensions = hasDismissed ? rawExtensions.filter((item) => !dismissed.has(item.id)) : rawExtensions;
		if (store === undefined) {
			return hasDismissed ? (extensions as AgentPanelItem[]) : extensions.slice();
		}
		const tasks = taskPanelItems(ownerTaskViewSource(store), dismissedTaskIds(session));
		if (extensions.length === 0) return tasks;
		if (tasks.length === 0) return hasDismissed ? (extensions as AgentPanelItem[]) : extensions.slice();
		return [...extensions, ...tasks];
	}
	const seenIds = new Set<string>();
	const extensions: AgentPanelItem[] = [];
	for (const source of sources) {
		for (const item of sourceItems(source, onSourceError)) {
			if (seenIds.has(item.id)) {
				reportSourceOnce(source, new Error(`Duplicate agent panel item id "${item.id}".`), onSourceError);
				continue;
			}
			seenIds.add(item.id);
			if (!hasDismissed || !dismissed.has(item.id)) extensions.push(item);
		}
	}
	if (store === undefined) return extensions;
	const tasks = taskPanelItems(ownerTaskViewSource(store), dismissedTaskIds(session));
	return tasks.length === 0 ? extensions : [...extensions, ...tasks];
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
	if (typeof id !== "string" || id.length === 0 || id === "main" || id.startsWith(taskPrefix)) return undefined;
	for (const source of hubOf(session)?.all() ?? []) {
		for (const item of sourceItems(source)) {
			if (item.id === id) return source;
		}
	}
	return undefined;
}

function normalizeActionResult(result: unknown): AgentPanelActionResult {
	if (drainThenable(result) || typeof result !== "object" || result === null) {
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
