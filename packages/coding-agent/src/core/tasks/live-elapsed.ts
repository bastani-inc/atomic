import type { AgentPanelState } from "./agent-panel-source.ts";
import { type Execution, spanElapsedMs, type TaskElapsedSpan, type TaskRecord } from "./contracts.js";

export function taskClockRunning(state: Execution["kind"] | AgentPanelState): boolean {
	return state === "running" || state === "cancelling" || state === "stopping" || state === "input";
}

export function liveElapsedFromRead(
	reportedMs: number | undefined,
	readAt: number,
	running: boolean,
	now = Date.now(),
): number | undefined {
	return reportedMs === undefined || !running ? reportedMs : reportedMs + Math.max(0, now - readAt);
}

/** The most a view has shown for one dispatch, which a wall-clock step back must not lower. */
type ShownSpan = { dispatchedAt: number; shownMs: number };
type ElapsedClock = {
	since: number;
	displayed: number;
	frozen?: number;
	settled?: boolean;
	ended?: boolean;
	span?: ShownSpan;
};
type ClockReference = {
	readonly table: Map<string, WeakRef<ElapsedClock>>;
	readonly taskId: string;
	readonly reference: WeakRef<ElapsedClock>;
};

const released = new FinalizationRegistry<ClockReference>(({ table, taskId, reference }) => {
	if (table.get(taskId) === reference) table.delete(taskId);
});

const defaultTable = new Map<string, WeakRef<ElapsedClock>>();

function readClock(
	table: Map<string, WeakRef<ElapsedClock>>,
	taskId: string,
	reportedMs: number | undefined,
	running: boolean,
	now: number,
	ended = false,
): { readonly elapsedMs: number | undefined; readonly clock: ElapsedClock | undefined } {
	let entry = table.get(taskId)?.deref();
	if (!running || entry?.settled) {
		if (entry === undefined) return { elapsedMs: reportedMs, clock: undefined };
		entry.frozen = Math.max(entry.frozen ?? 0, reportedMs ?? 0, entry.displayed);
		if (ended) entry.ended = true;
		return { elapsedMs: entry.frozen, clock: entry };
	}
	if (entry === undefined || entry.frozen !== undefined) {
		const resumedMs = entry?.ended ? (reportedMs ?? 0) : Math.max(reportedMs ?? 0, entry?.frozen ?? 0);
		const span = entry?.span;
		entry = { since: now - resumedMs, displayed: resumedMs, ...(span === undefined ? {} : { span }) };
		trackClock(table, taskId, entry);
	}
	if (reportedMs !== undefined) entry.since = Math.min(entry.since, now - reportedMs);
	entry.displayed = Math.max(entry.displayed, reportedMs ?? 0, now - entry.since);
	return { elapsedMs: entry.displayed, clock: entry };
}

function trackClock(table: Map<string, WeakRef<ElapsedClock>>, taskId: string, entry: ElapsedClock): void {
	const reference = new WeakRef(entry);
	table.set(taskId, reference);
	released.register(entry, { table, taskId, reference });
}

function readSpanClock(
	table: Map<string, WeakRef<ElapsedClock>>,
	taskId: string,
	span: TaskElapsedSpan,
	now: number,
): { readonly elapsedMs: number; readonly clock: ElapsedClock } {
	const elapsedMs = spanElapsedMs(span, now);
	let entry = table.get(taskId)?.deref();
	if (entry === undefined) {
		entry = { since: now - elapsedMs, displayed: elapsedMs };
		trackClock(table, taskId, entry);
	}
	if (entry.span?.dispatchedAt === span.dispatchedAt) entry.span.shownMs = Math.max(entry.span.shownMs, elapsedMs);
	else entry.span = { dispatchedAt: span.dispatchedAt, shownMs: elapsedMs };
	return { elapsedMs: entry.span.shownMs, clock: entry };
}

/**
 * A dispatch's elapsed time as a view shows it: never less than that view already showed for the same dispatch, even
 * if the wall clock steps back. A new dispatch starts from its own time.
 */
export function shownSpanMs(
	taskId: string,
	span: TaskElapsedSpan,
	clocks?: TaskElapsedClocks,
	now = Date.now(),
): number {
	return clocks?.spanMs(taskId, span, now) ?? readSpanClock(defaultTable, taskId, span, now).elapsedMs;
}

export function liveElapsedMs(
	taskId: string,
	reportedMs: number | undefined,
	running: boolean,
	now = Date.now(),
	ended = false,
): number | undefined {
	return readClock(defaultTable, taskId, reportedMs, running, now, ended).elapsedMs;
}

/** A dispatched child carries its own clock, including over a late or remote observation. */
export function taskElapsedMs(
	task: TaskRecord,
	running: boolean,
	clocks = taskClockOf(task),
	now = Date.now(),
): number | undefined {
	if (task.elapsedSpan) return shownSpanMs(task.ref.taskId, task.elapsedSpan, clocks, now);
	const reported = task.metrics?.elapsedMs;
	return (
		clocks?.elapsedMs(task.ref.taskId, reported, running, now) ??
		liveElapsedMs(task.ref.taskId, reported, running, now)
	);
}

export class TaskElapsedClocks {
	private readonly table: Map<string, WeakRef<ElapsedClock>>;
	private readonly retained = new Map<string, ElapsedClock>();
	private readonly sourceSlots = new Map<string, number>();

	constructor(table: Map<string, WeakRef<ElapsedClock>> = new Map()) {
		this.table = table;
	}

	has(taskId: string): boolean {
		return this.retained.has(taskId) || this.table.has(taskId);
	}

	hasEntries(): boolean {
		return this.retained.size > 0 || this.table.size > 0;
	}

	elapsedMs(
		taskId: string,
		reportedMs: number | undefined,
		running: boolean,
		now = Date.now(),
		ended = false,
	): number | undefined {
		const { elapsedMs, clock } = readClock(this.table, taskId, reportedMs, running, now, ended);
		if (clock !== undefined) this.retained.set(taskId, clock);
		return elapsedMs;
	}

	/** See `shownSpanMs`. */
	spanMs(taskId: string, span: TaskElapsedSpan, now = Date.now()): number {
		const { elapsedMs, clock } = readSpanClock(this.table, taskId, span, now);
		this.retained.set(taskId, clock);
		return elapsedMs;
	}

	settle(taskId: string, reportedMs: number | undefined, now = Date.now()): void {
		const entry = this.table.get(taskId)?.deref();
		if (entry === undefined || entry.settled) return;
		entry.frozen = Math.max(entry.frozen ?? 0, reportedMs ?? 0, entry.displayed, now - entry.since);
		entry.settled = true;
		this.retained.set(taskId, entry);
	}

	syncTasks(tasks: readonly TaskRecord[]): void {
		let missing: Set<string> | undefined;
		for (const id of this.retained.keys()) {
			const slot = this.sourceSlots.get(id);
			const task = slot === undefined ? undefined : tasks[slot];
			if (task?.ref.taskId !== id) {
				missing ??= new Set();
				missing.add(id);
			} else if (task.execution.kind === "settled") this.elapsedMs(id, task.metrics?.elapsedMs, false);
		}
		if (missing === undefined) return;
		for (let index = 0; index < tasks.length; index++) {
			const task = tasks[index]!;
			const id = task.ref.taskId;
			if (!missing.delete(id)) continue;
			this.sourceSlots.set(id, index);
			if (task.execution.kind === "settled") this.elapsedMs(id, task.metrics?.elapsedMs, false);
			if (missing.size === 0) return;
		}
		for (const id of missing) this.delete(id);
	}

	delete(taskId: string): void {
		this.sourceSlots.delete(taskId);
		this.retained.delete(taskId);
		this.table.delete(taskId);
	}

	prune(taskIds: ReadonlySet<string>): void {
		for (const id of this.retained.keys()) {
			if (!taskIds.has(id)) {
				this.delete(id);
			}
		}
		for (const id of this.table.keys()) if (!taskIds.has(id)) this.table.delete(id);
	}

	clear(): void {
		this.retained.clear();
		this.sourceSlots.clear();
		this.table.clear();
	}
}

type ClockSourceLike = {
	readonly tasks?: readonly TaskRecord[];
	readonly backgroundTasks?: readonly TaskRecord[];
	subscribe?: (listener: () => void) => () => void;
};

const clockSources = new WeakMap<object, object>();
const clocksBySource = new WeakMap<object, TaskElapsedClocks>();
const clocksByTarget = new WeakMap<object, TaskElapsedClocks>();
const managedSources = new WeakSet<object>();
const subscribedSources = new WeakSet<object>();

function rootClockSource(source: object): object {
	let current: object | null = source;
	while (current !== null) {
		const mapped = clockSources.get(current);
		if (mapped !== undefined) {
			let root = mapped;
			while (clockSources.has(root)) root = clockSources.get(root)!;
			if (source !== root) clockSources.set(source, root);
			return root;
		}
		if (clocksBySource.has(current) || managedSources.has(current)) {
			if (source !== current) clockSources.set(source, current);
			return current;
		}
		current = Object.getPrototypeOf(current);
	}
	return source;
}

export function createManagedTaskClocks(source: object): TaskElapsedClocks {
	const root = rootClockSource(source);
	let clocks = clocksBySource.get(root);
	if (clocks === undefined) {
		clocks = new TaskElapsedClocks();
		clocksBySource.set(root, clocks);
	}
	managedSources.add(root);
	return clocks;
}

export function bindTaskClockSource(target: object, source: object): void {
	const root = rootClockSource(source);
	if (target !== root) clockSources.set(target, root);
}

export function bindTaskClock<T extends object>(target: T, clocks: TaskElapsedClocks): T {
	clocksByTarget.set(target, clocks);
	return target;
}

export function taskClockOf(target: object): TaskElapsedClocks | undefined {
	const direct = clocksByTarget.get(target);
	if (direct !== undefined) return direct;
	const root = rootClockSource(target);
	return clocksBySource.get(root);
}

function syncSourceClocks(root: ClockSourceLike & object, clocks: TaskElapsedClocks): void {
	if (!clocks.hasEntries()) return;
	const tasks = root.tasks;
	const list = Array.isArray(tasks) ? tasks : root.backgroundTasks;
	if (Array.isArray(list)) clocks.syncTasks(list);
}

export function taskClocksFor(source: object): TaskElapsedClocks {
	const direct = clocksByTarget.get(source);
	if (direct !== undefined) return direct;
	const root = rootClockSource(source);
	let clocks = clocksBySource.get(root);
	if (clocks === undefined) {
		clocks = new TaskElapsedClocks();
		clocksBySource.set(root, clocks);
	}
	if (!managedSources.has(root) && !subscribedSources.has(root)) {
		const candidate = root as ClockSourceLike & object;
		if (typeof candidate.subscribe === "function") {
			subscribedSources.add(root);
			const weakRoot = new WeakRef(candidate);
			candidate.subscribe(() => {
				const deref = weakRoot.deref();
				if (deref !== undefined) syncSourceClocks(deref, clocks);
			});
		}
		syncSourceClocks(candidate, clocks);
	}
	return clocks;
}
