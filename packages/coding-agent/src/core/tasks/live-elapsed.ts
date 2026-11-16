import type { AgentPanelState } from "./agent-panel-source.ts";
import type { Execution, TaskRecord } from "./contracts.js";

export function taskClockRunning(state: Execution["kind"] | AgentPanelState): boolean {
	return (
		state === "running" || state === "cancelling" || state === "stopping" || state === "input" || state === "paused"
	);
}

type ElapsedClock = { since: number; displayed: number; frozen?: number; settled?: boolean };
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
): { readonly elapsedMs: number | undefined; readonly clock: ElapsedClock | undefined } {
	let entry = table.get(taskId)?.deref();
	if (!running || entry?.settled) {
		if (entry === undefined) return { elapsedMs: reportedMs, clock: undefined };
		entry.frozen = Math.max(entry.frozen ?? 0, reportedMs ?? 0, entry.displayed);
		return { elapsedMs: entry.frozen, clock: entry };
	}
	if (entry === undefined || entry.frozen !== undefined) {
		entry = { since: now - (reportedMs ?? 0), displayed: reportedMs ?? 0 };
		const reference = new WeakRef(entry);
		table.set(taskId, reference);
		released.register(entry, { table, taskId, reference });
	}
	if (reportedMs !== undefined) entry.since = Math.min(entry.since, now - reportedMs);
	entry.displayed = Math.max(entry.displayed, reportedMs ?? 0, now - entry.since);
	return { elapsedMs: entry.displayed, clock: entry };
}

export function liveElapsedMs(
	taskId: string,
	reportedMs: number | undefined,
	running: boolean,
	now = Date.now(),
): number | undefined {
	return readClock(defaultTable, taskId, reportedMs, running, now).elapsedMs;
}

export class TaskElapsedClocks {
	private readonly table: Map<string, WeakRef<ElapsedClock>>;
	private readonly retained = new Map<string, ElapsedClock>();

	constructor(table: Map<string, WeakRef<ElapsedClock>> = new Map()) {
		this.table = table;
	}

	elapsedMs(taskId: string, reportedMs: number | undefined, running: boolean, now = Date.now()): number | undefined {
		const { elapsedMs, clock } = readClock(this.table, taskId, reportedMs, running, now);
		if (clock !== undefined) this.retained.set(taskId, clock);
		return elapsedMs;
	}

	settle(taskId: string, reportedMs: number | undefined, now = Date.now()): void {
		const entry = this.table.get(taskId)?.deref();
		if (entry === undefined || entry.settled) return;
		entry.frozen = Math.max(entry.frozen ?? 0, reportedMs ?? 0, entry.displayed, now - entry.since);
		entry.settled = true;
		this.retained.set(taskId, entry);
	}

	delete(taskId: string): void {
		this.retained.delete(taskId);
		this.table.delete(taskId);
	}

	prune(taskIds: ReadonlySet<string>): void {
		for (const id of this.retained.keys()) {
			if (!taskIds.has(id)) {
				this.retained.delete(id);
				this.table.delete(id);
			}
		}
		for (const id of this.table.keys()) if (!taskIds.has(id)) this.table.delete(id);
	}

	clear(): void {
		this.retained.clear();
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
	const tasks = root.tasks;
	const list = Array.isArray(tasks) ? tasks : root.backgroundTasks;
	if (!Array.isArray(list)) return;
	const live = new Set<string>();
	for (const task of list) {
		live.add(task.ref.taskId);
		if (clocksByTarget.get(task) !== clocks) bindTaskClock(task, clocks);
		if (task.execution.kind === "settled") clocks.settle(task.ref.taskId, task.metrics?.elapsedMs);
	}
	clocks.prune(live);
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
	if (!managedSources.has(root)) {
		const candidate = root as ClockSourceLike & object;
		if (!subscribedSources.has(root) && typeof candidate.subscribe === "function") {
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
