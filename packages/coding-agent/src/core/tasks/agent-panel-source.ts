import { inspect, types } from "node:util";
import { graphemeAt, sanitizeTerminalText } from "../../utils/terminal-text.ts";
import type { ExtensionError } from "../extensions/runtime-types.ts";
import { waitingReleasedTools, withoutSupersededAttempts } from "./completion.js";
import type { TaskId, TaskRecord } from "./contracts.js";
import { bindTaskClock, TaskElapsedClocks, taskClockOf, taskClockRunning } from "./live-elapsed.js";
import {
	getOwnerTaskSession,
	getOwnerTaskStore,
	isTaskTurnInterrupted,
	taskResumedTurns,
	watchOwnerTaskStoreBinding,
} from "./owner-store.js";
import { ownerTaskViewSource, type TaskViewSource } from "./task-view-source.js";

export type AgentPanelState =
	| "running"
	| "queued"
	| "input"
	| "paused"
	| "stopping"
	| "waiting"
	| "done"
	| "failed"
	| "stopped";

export interface AgentPanelItem {
	readonly id: string;
	readonly kind: "agent" | "shell";
	readonly state: AgentPanelState;
	readonly name: string;
	readonly task: string;
	readonly elapsedMs?: number;
	readonly elapsedSpan?: TaskRecord["elapsedSpan"];
	readonly tokens?: number;
	/**
	 * The model the row's agent runs on now, as `provider/id`, shown after its name. A subagent's changes as soon as it
	 * switches model, as on a fallback; once it stops, it is the model its last turn ran on.
	 */
	readonly model?: string;
	/** The reasoning level it runs at, shown after the model. None for a model without reasoning levels. */
	readonly thinking?: string;
	readonly progress?: { readonly done: number; readonly total: number };
	readonly question?: string;
	readonly choices?: readonly string[];
	readonly promptId?: string;
	readonly reason?: string;
	/** What a `waiting` row waits on: the tools of the calls a released subagent wakes from. */
	readonly waitingOn?: string;
	readonly queued?: number;
	readonly endedAt?: number;
	/**
	 * An identity of the row's latest run: it changes whenever the row runs again (resumed, woken or sent a follow-up),
	 * however briefly. A stopped or paused row that left the panel is listed again once it changes, even when the panel
	 * never saw it running.
	 */
	readonly runGeneration?: string;
}

export interface AgentPanelOpenOptions {
	readonly onReturn?: () => void;
}

export interface AgentPanelAnswerOptions {
	readonly promptId?: string;
	readonly question?: string;
	readonly choices?: readonly string[];
	readonly choiceIndex?: number;
}

export type AgentPanelActionResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface AgentPanelSource {
	items(): readonly AgentPanelItem[];
	subscribe(listener: () => void): () => void;
	open?:
		| ((id: string, options?: AgentPanelOpenOptions) => boolean)
		| ((id: string, options?: AgentPanelOpenOptions) => void);
	stop?(id: string): Promise<AgentPanelActionResult>;
	answer?(id: string, text: string, options?: AgentPanelAnswerOptions): Promise<AgentPanelActionResult>;
}

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
	failures(): readonly (readonly [AgentPanelSource, Error])[] {
		return [...this.failedSources];
	}
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

export interface AgentPanelSession {
	readonly extensionRunner?: {
		getAgentPanelSourceHub?(): AgentPanelSourceHub | undefined;
		emitError?(error: ExtensionError): void;
	};
}

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

export function taskPanelState(task: TaskRecord): AgentPanelState {
	switch (task.execution.kind) {
		case "queued":
			return "queued";
		case "cancelling":
			return "stopping";
		case "running":
			if (task.attention.kind !== "none") return "input";
			return isTaskTurnInterrupted(task) ? "paused" : "running";
		case "settled": {
			const result = task.execution.result;
			if (waitingReleasedTools(task) !== undefined) return "waiting";
			if (result.kind === "completed") return "done";
			if (result.kind === "failed") return "failed";
			return "stopped";
		}
	}
	return "running";
}

/**
 * The identity of a subagent task's latest run (`AgentPanelItem.runGeneration`): how many times its interrupted turn
 * was resumed. A settled task never runs again (a resume or a wake starts a new task), so it keeps the count it
 * settled with.
 */
export function taskRunGeneration(task: TaskRecord): string | undefined {
	const resumed = taskResumedTurns(task);
	return resumed === undefined ? undefined : `turn:${resumed}`;
}

const SHORT_TITLE_CHARS = 60;

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
	const end = cut.slice(0, space > SHORT_TITLE_CHARS / 2 ? space : SHORT_TITLE_CHARS - 1).trimEnd().length;
	// The next code point is enough to tell whether this cut (including a word break) splits a grapheme.
	const boundary = graphemeAt(line.slice(0, end + 2), end)!;
	return `${line.slice(0, boundary.index)}…`;
}

const cachedTaskItems = new WeakMap<
	TaskRecord,
	{
		readonly taskId: string;
		readonly clocks: TaskElapsedClocks | undefined;
		readonly interrupted: boolean;
		/** The reasoning level the record reports; the item shows it only for a model with reasoning levels. */
		readonly thinking: string | undefined;
		readonly item: AgentPanelItem;
	}
>();

/** What a session's model registry tells about a model: enough to know whether it has reasoning levels. */
interface ModelReasoningSession {
	readonly modelRuntime?: {
		getModel?(provider: string, modelId: string): { readonly reasoning?: boolean } | undefined;
	};
}

const MAX_KNOWN_REASONING = 256;
const knownReasoning = new WeakMap<object, Map<string, boolean>>();

/**
 * Whether the model registry of the session that owns `owner` (a task record or its owner's clocks) gives `model`
 * reasoning levels; undefined when that session, or its registry, does not know the model.
 */
function modelHasReasoning(owner: object, model: string): boolean | undefined {
	const runtime = (getOwnerTaskSession(owner) as ModelReasoningSession | undefined)?.modelRuntime;
	const slash = model.indexOf("/");
	if (runtime === undefined || typeof runtime.getModel !== "function" || slash <= 0) return undefined;
	let known = knownReasoning.get(runtime);
	const cached = known?.get(model);
	if (cached !== undefined) return cached;
	let reasoning: boolean | undefined;
	try {
		const found = runtime.getModel(model.slice(0, slash), model.slice(slash + 1));
		reasoning = found === undefined ? undefined : found.reasoning === true;
	} catch {
		return undefined;
	}
	if (reasoning === undefined) return undefined;
	if (known === undefined) {
		known = new Map();
		knownReasoning.set(runtime, known);
	} else if (known.size >= MAX_KNOWN_REASONING) known.clear();
	known.set(model, reasoning);
	return reasoning;
}

/**
 * A subagent's model column (`AgentPanelItem.model` and `thinking`): the model its record says it runs on now, and the
 * level beside it, as the main footer shows the chat's own: none for a model without reasoning levels. A level for a
 * model the owner session's registry does not know is shown as reported. A shell has none.
 */
export function taskPanelModel(
	task: Pick<TaskRecord, "kind" | "model" | "thinking">,
	owner: object = task,
): { readonly model?: string; readonly thinking?: string } {
	if (task.kind !== "agent" || task.model === undefined) return {};
	const thinking =
		task.thinking === undefined || modelHasReasoning(owner, task.model) === false ? undefined : task.thinking;
	return thinking === undefined ? { model: task.model } : { model: task.model, thinking };
}
const lazyTaskItems = new WeakMap<
	TaskRecord,
	{
		readonly state: AgentPanelState;
		readonly clocks: TaskElapsedClocks | undefined;
		readonly interrupted: boolean;
		readonly runGeneration: string | undefined;
		readonly item: AgentPanelItem;
	}
>();
const lazyTaskRecords = new WeakMap<
	AgentPanelItem,
	{ readonly task: TaskRecord; readonly clocks: TaskElapsedClocks | undefined }
>();
const interruptedTaskItems = new WeakSet<object>();

export function markInterruptedPanelTask<T extends object>(item: T): T {
	interruptedTaskItems.add(item);
	return item;
}

export function isInterruptedPanelTask(item: object): boolean {
	return interruptedTaskItems.has(item);
}

/**
 * Which part of the agent panel a native task is: a subagent is a row and counts as an agent; a shell is never a row
 * and is counted on the hint line. Every task kind must be routed here explicitly, so a new kind cannot become an
 * agent row by default.
 */
export function taskPanelRole(task: Pick<TaskRecord, "kind">): "agent" | "shell" {
	switch (task.kind) {
		case "agent":
			return "agent";
		case "command":
			return "shell";
		default: {
			const unrouted: never = task.kind;
			return unrouted;
		}
	}
}

export function taskPanelItem(task: TaskRecord, sourceClocks?: TaskElapsedClocks): AgentPanelItem {
	const clocks = sourceClocks ?? taskClockOf(task);
	const cached = cachedTaskItems.get(task);
	const state = taskPanelState(task);
	const interrupted = task.execution.kind !== "settled" && state === "paused";
	const question = task.attention.kind === "input-needed" ? task.attention.prompt || undefined : undefined;
	const kind = taskPanelRole(task);
	const name = kind === "agent" ? (task.agentName ?? "agent") : "shell";
	const title = shortTaskTitle(task.title || "");
	const reason =
		state === "failed" && task.execution.kind === "settled" && task.execution.result.kind === "failed"
			? (task.execution.result.message.split("\n")[0] ?? "")
			: undefined;
	const waitingOn = waitingReleasedTools(task);
	const runGeneration = taskRunGeneration(task);
	if (
		cached !== undefined &&
		cached.clocks === clocks &&
		cached.interrupted === interrupted &&
		cached.taskId === task.ref.taskId &&
		cached.item.kind === kind &&
		cached.item.state === state &&
		cached.item.name === name &&
		cached.item.task === title &&
		cached.item.elapsedMs === task.metrics?.elapsedMs &&
		cached.item.tokens === task.metrics?.tokenCount &&
		cached.item.model === (kind === "agent" ? task.model : undefined) &&
		cached.thinking === task.thinking &&
		cached.item.question === question &&
		cached.item.reason === reason &&
		cached.item.waitingOn === waitingOn &&
		cached.item.runGeneration === runGeneration
	)
		return cached.item;
	const model = taskPanelModel(task, clocks ?? task);
	const item: AgentPanelItem = {
		id: `${taskPrefix}${task.ref.taskId}`,
		kind,
		state,
		name,
		task: title,
		...(task.metrics?.elapsedMs === undefined ? {} : { elapsedMs: task.metrics.elapsedMs }),
		...(task.elapsedSpan === undefined ? {} : { elapsedSpan: task.elapsedSpan }),
		...(task.metrics?.tokenCount === undefined ? {} : { tokens: task.metrics.tokenCount }),
		...model,
		...(question ? { question } : {}),
		...(reason === undefined ? {} : { reason }),
		...(waitingOn === undefined ? {} : { waitingOn }),
		...(runGeneration === undefined ? {} : { runGeneration }),
	};
	if (interrupted) markInterruptedPanelTask(item);
	if (clocks !== undefined) bindTaskClock(item, clocks);
	cachedTaskItems.set(task, { taskId: task.ref.taskId, clocks, interrupted, thinking: task.thinking, item });
	return item;
}

export function lazyTaskPanelItem(task: TaskRecord, sourceClocks?: TaskElapsedClocks): AgentPanelItem {
	const state = taskPanelState(task);
	const interrupted = task.execution.kind !== "settled" && state === "paused";
	const runGeneration = taskRunGeneration(task);
	const cached = lazyTaskItems.get(task);
	if (
		cached !== undefined &&
		cached.state === state &&
		cached.clocks === sourceClocks &&
		cached.interrupted === interrupted &&
		cached.runGeneration === runGeneration
	) {
		return cached.item;
	}
	const item: AgentPanelItem = {
		id: `${taskPrefix}${task.ref.taskId}`,
		kind: taskPanelRole(task),
		state,
		...(runGeneration === undefined ? {} : { runGeneration }),
		get name() {
			return taskPanelItem(task, sourceClocks).name;
		},
		get task() {
			return taskPanelItem(task, sourceClocks).task;
		},
		get waitingOn() {
			return taskPanelItem(task, sourceClocks).waitingOn;
		},
		get model() {
			return taskPanelItem(task, sourceClocks).model;
		},
		get thinking() {
			return taskPanelItem(task, sourceClocks).thinking;
		},
	};
	if (interrupted) markInterruptedPanelTask(item);
	lazyTaskItems.set(task, { state, clocks: sourceClocks, interrupted, runGeneration, item });
	lazyTaskRecords.set(item, { task, clocks: sourceClocks });
	return item;
}

export function materializePanelItem(item: AgentPanelItem): AgentPanelItem {
	const entry = lazyTaskRecords.get(item);
	return entry === undefined ? item : taskPanelItem(entry.task, entry.clocks);
}

export function taskPanelItems(
	source: Pick<TaskViewSource, "backgroundTasks">,
	dismissed: ReadonlySet<TaskId>,
	options: { readonly topLevelOnly?: boolean } = {},
): AgentPanelItem[] {
	const topLevelOnly = options.topLevelOnly ?? true;
	const hasDismissed = dismissed.size > 0;
	const sourceClocks = taskClockOf(source);
	const items: AgentPanelItem[] = [];
	for (const task of withoutSupersededAttempts(source.backgroundTasks)) {
		if (topLevelOnly && task.parentTaskId !== undefined) continue;
		const finishedState = task.execution.kind === "settled";
		if (finishedState && hasDismissed && dismissed.has(task.ref.taskId)) continue;
		items.push(taskPanelItem(task, sourceClocks));
	}
	return items;
}

const reportedSources = new WeakSet<AgentPanelSource>();

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
const MAX_DRAIN_DEPTH = 32;
const MAX_DRAIN_STEPS = 256;
const drainQueue: Array<{ readonly value: unknown; readonly seen?: Set<object> }> = [];
let draining = false;
const unattachablePromises = new WeakSet<Promise<unknown>>();
let unattachableGuardInstalled = false;
const UNHANDLED_REJECTION_OWNER = Symbol.for("atomic.unhandled-rejection-owner");

function hasUnhandledRejectionOwner(
	self: (reason: unknown, rejected: Promise<unknown>) => void,
	rejected: Promise<unknown>,
	reason: unknown,
): boolean {
	for (const candidate of process.listeners("unhandledRejection")) {
		if (candidate === self) continue;
		const owns = (
			candidate as {
				readonly [UNHANDLED_REJECTION_OWNER]?: (
					promise: Promise<unknown> | undefined,
					rejectionReason?: unknown,
				) => boolean;
			}
		)[UNHANDLED_REJECTION_OWNER];
		if (typeof owns !== "function" || owns(rejected, reason)) return true;
	}
	return false;
}

function shouldThrowUnhandledRejection(reason: unknown): boolean {
	const args = [...(process.env.NODE_OPTIONS ?? "").split(/\s+/), ...process.execArgv];
	let mode = "throw";
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg.startsWith("--unhandled-rejections=")) mode = arg.slice("--unhandled-rejections=".length);
		else if (arg === "--unhandled-rejections" && args[index + 1] !== undefined) mode = args[index + 1] ?? mode;
	}
	if (mode === "none" || mode === "warn") return false;
	if (mode === "warn-with-error-code") {
		process.emitWarning(
			inspect(reason, { customInspect: false, getters: false }),
			"UnhandledPromiseRejectionWarning",
		);
		process.exitCode = 1;
		return false;
	}
	return true;
}

function markUnattachable(promise: Promise<unknown>): void {
	unattachablePromises.add(promise);
	if (unattachableGuardInstalled) return;
	unattachableGuardInstalled = true;
	const onUnattachableRejection = (reason: unknown, rejected: Promise<unknown>) => {
		if (unattachablePromises.has(rejected)) return;
		if (hasUnhandledRejectionOwner(onUnattachableRejection, rejected, reason)) return;
		if (!shouldThrowUnhandledRejection(reason)) return;
		throw reason;
	};
	Reflect.defineProperty(onUnattachableRejection, UNHANDLED_REJECTION_OWNER, {
		value: (rejected: Promise<unknown> | undefined) => rejected !== undefined && unattachablePromises.has(rejected),
	});
	process.on("unhandledRejection", onUnattachableRejection);
}

function attachNativePromise(promise: Promise<unknown>, seen?: Set<object>): void {
	if (drainedPromises.has(promise)) return;
	drainedPromises.add(promise);
	try {
		thenNativePromise(
			promise,
			(result: unknown) => drainCaught(result),
			(error: unknown) => drainCaught(error),
		);
	} catch (error) {
		drainCaught(error, seen ?? new Set([promise]));
	}
}

function drainCaught(value: unknown, seen?: Set<object>): void {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
	if (types.isPromise(value)) {
		attachNativePromise(value, seen);
		return;
	}
	if (drainQueue.length < MAX_DRAIN_STEPS) {
		drainQueue.push({ value, seen });
	}
	if (draining) return;
	draining = true;
	let steps = 0;
	try {
		while (drainQueue.length > 0 && steps < MAX_DRAIN_STEPS) {
			const next = drainQueue.shift()!;
			steps++;
			try {
				drainThenable(next.value, next.seen);
			} catch {}
		}
		drainQueue.length = 0;
	} finally {
		draining = false;
	}
}

function thenNativePromise(
	promise: Promise<unknown>,
	onFulfilled: (value: unknown) => void,
	onRejected: (error: unknown) => void,
): void {
	try {
		try {
			Promise.prototype.then.call(promise, onFulfilled, onRejected);
			return;
		} catch (firstError) {
			drainCaught(firstError);
			if (Reflect.getPrototypeOf(promise) !== Promise.prototype || Object.hasOwn(promise, "constructor")) {
				Reflect.defineProperty(promise, "constructor", { value: Promise, configurable: true, writable: true });
			}
			Promise.prototype.then.call(promise, onFulfilled, onRejected);
		}
	} catch (error) {
		markUnattachable(promise);
		throw error;
	}
}

function drainThenable(value: unknown, seen?: Set<object>): boolean {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
	if (types.isPromise(value)) {
		attachNativePromise(value, seen);
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
		let depth = 0;
		const settle = (initial: unknown): void => {
			let current: unknown = initial;
			while (true) {
				if ((typeof current !== "object" && typeof current !== "function") || current === null) {
					resolve({ value: current });
					return;
				}
				if (pending.has(current)) {
					reject(new TypeError("Agent panel source returned a cyclic thenable."));
					return;
				}
				if (depth >= MAX_DRAIN_DEPTH) {
					drainCaught(current);
					reject(new RangeError("Agent panel source exceeded maximum thenable depth."));
					return;
				}
				pending.add(current);
				depth++;
				let settled = false;
				let syncCall = true;
				let syncNext: { readonly value: unknown } | undefined;
				const accept = (next: unknown) => {
					if (settled) {
						drainCaught(next);
						return;
					}
					settled = true;
					if (syncCall) {
						syncNext = { value: next };
						return;
					}
					settle(next);
				};
				const fail = (error: unknown) => {
					drainCaught(error);
					if (settled) return;
					settled = true;
					reject(error);
				};
				try {
					if (types.isPromise(current)) {
						syncCall = false;
						thenNativePromise(current, accept, fail);
						return;
					}
					const then = (current as { readonly then?: unknown }).then;
					if (typeof then !== "function") {
						drainCaught(then);
						resolve({ value: current });
						return;
					}
					drainCaught(Reflect.apply(then, current, [accept, fail]));
				} catch (error) {
					fail(error);
					if (syncNext === undefined) return;
				}
				syncCall = false;
				if (syncNext === undefined) return;
				current = syncNext.value;
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
	const model = row.model;
	drainThenable(model);
	const thinking = row.thinking;
	drainThenable(thinking);
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
	const waitingOn = row.waitingOn;
	drainThenable(waitingOn);
	const queued = row.queued;
	drainThenable(queued);
	const endedAt = row.endedAt;
	drainThenable(endedAt);
	const runGeneration = row.runGeneration;
	drainThenable(runGeneration);

	if (
		typeof id !== "string" ||
		id.length === 0 ||
		id === "main" ||
		id.startsWith(taskPrefix) ||
		(kind !== "agent" && kind !== "shell") ||
		(state !== "running" &&
			state !== "queued" &&
			state !== "input" &&
			state !== "paused" &&
			state !== "stopping" &&
			state !== "waiting" &&
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
		(waitingOn !== undefined && typeof waitingOn !== "string") ||
		(runGeneration !== undefined && typeof runGeneration !== "string") ||
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
	// Rows that extensions wrote before these fields existed may carry their own `model` or `thinking` of another
	// kind: such a value is not shown, and the row stays.
	if (typeof model === "string") item.model = model;
	if (typeof thinking === "string") item.thinking = thinking;
	if (progress !== undefined) item.progress = progress;
	if (question !== undefined) item.question = question;
	if (choices !== undefined) item.choices = choices;
	if (promptId !== undefined) item.promptId = promptId;
	if (reason !== undefined) item.reason = reason;
	if (waitingOn !== undefined) item.waitingOn = waitingOn;
	if (queued !== undefined) item.queued = queued;
	if (endedAt !== undefined) item.endedAt = endedAt;
	if (runGeneration !== undefined) item.runGeneration = runGeneration;
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
				validationError ??= new Error(`Duplicate agent panel item id "${cleanReasonText(validated.id)}".`);
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

const hubBindingListeners = new WeakMap<object, Set<() => void>>();

export function notifyAgentPanelSourceHubRebound(session: object): void {
	for (const listener of [...(hubBindingListeners.get(session) ?? [])]) safelyCall(listener);
}

export function notifyAgentPanelChanged(session: object): void {
	if ((typeof session !== "object" && typeof session !== "function") || session === null) return;
	sourcesGeneration++;
	bumpHubSources(hubOf(session as AgentPanelSession));
	notifyAgentPanelSourceHubRebound(session);
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
				{ extensionPath: "agent panel source", event: "agent_panel", error: cleanReasonText(error.message) },
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

export function sampleAgentPanelSources(
	session: AgentPanelSession & object,
	onSourceError?: (error: Error) => void,
): void {
	const report = onSourceError ?? sourceErrorReporter(session);
	for (const source of hubOf(session)?.all() ?? []) sourceItems(source, report);
}

export function agentPanelExtensionItems(
	session: AgentPanelSession & object,
	onSourceError?: (error: Error) => void,
): AgentPanelItem[] {
	const report = onSourceError ?? sourceErrorReporter(session);
	const dismissed = dismissedAgentPanelItems(session);
	const hasDismissed = dismissed.size > 0;
	const hub = hubOf(session);
	const sources = hub?.all() ?? [];
	const hubFailures = hub?.failures();
	let hasSourceError = (hubFailures?.length ?? 0) > 0;
	if (report !== undefined && hubFailures !== undefined) {
		for (const [source, error] of hubFailures) reportSourceOnce(source, error, report);
	}
	const items: AgentPanelItem[] = [];
	const seenIds = sources.length > 1 ? new Set<string>() : undefined;
	for (const source of sources) {
		const entry = readSourceCache(source);
		if (entry.error !== undefined) {
			hasSourceError = true;
			reportSourceOnce(source, entry.error, report);
		}
		for (const item of entry.items) {
			if (seenIds !== undefined) {
				if (seenIds.has(item.id)) {
					reportSourceOnce(
						source,
						new Error(`Duplicate agent panel item id "${cleanReasonText(item.id)}".`),
						report,
					);
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
		if (item.state === "queued") continue;
		const owned = sessionExtensionClocks(session);
		clockIds ??= new Set();
		clockIds.add(item.id);
		bindTaskClock(item, owned);
		const state = item.state;
		owned.elapsedMs(
			item.id,
			item.elapsedMs,
			taskClockRunning(state),
			agentPanelItemReadAt(item),
			state === "done" || state === "failed" || state === "stopped",
		);
	}
	if (clockIds !== undefined) extensionClocksBySession.get(session)?.prune(clockIds);
	else clocks?.clear();
	const liveIds =
		!hasSourceError && hasDismissed && sources.length > 0 ? new Set(items.map((item) => item.id)) : undefined;
	if (hasDismissed) {
		if (liveIds !== undefined) {
			for (const id of [...dismissed]) {
				if (agentPanelTaskId(id) === undefined && !liveIds.has(id)) dismissed.delete(id);
			}
		}
		for (const item of items) {
			if (dismissed.has(item.id) && item.state !== "done" && item.state !== "failed" && item.state !== "stopped") {
				dismissed.delete(item.id);
			}
		}
		const store = getOwnerTaskStore(session);
		if (store !== undefined) {
			for (const id of [...dismissed]) {
				const taskId = agentPanelTaskId(id);
				if (taskId === undefined) continue;
				const task = store.taskRecord(taskId);
				if (task !== undefined && task.execution.kind !== "settled") {
					dismissed.delete(id);
				}
			}
		}
	}
	return dismissed.size > 0 ? items.filter((item) => !dismissed.has(item.id)) : items;
}

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
		const report = sourceErrorReporter(session);
		let opened: unknown;
		try {
			opened = Reflect.apply(open, source, [id, wrappedOptions]);
		} catch (error) {
			drainCaught(error);
			report?.(sourceError(error));
			return false;
		}
		if (opened === false) return false;
		if (drainThenable(opened)) {
			settleSourceResult(opened).catch((error: unknown) => {
				report?.(sourceError(error));
			});
		}
		notifyAgentPanelChanged(session);
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
