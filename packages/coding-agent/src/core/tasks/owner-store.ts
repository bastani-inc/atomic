import type {
	ActivityReport,
	Cursor,
	NativeEvent,
	OwnerSnapshot,
	Result,
	TaskId,
	TaskRecord,
	WaitError,
	WatchError,
} from "./contracts.js";
import {
	bindTaskClock,
	createManagedTaskClocks,
	type TaskElapsedClocks,
	taskClockOf,
	taskClockRunning,
	taskClocksFor,
} from "./live-elapsed.js";
import { scopedBackgroundTasks, sessionTasks } from "./session-scope.js";
import {
	type OwnerLease,
	type TaskLease,
	type TaskSubscription,
	type TaskSupervisor,
	taskTranscriptSource,
} from "./supervisor.js";
import { bindReleasedTaskOwner } from "./task-resumer.ts";

const interruptedByClock = new WeakMap<TaskElapsedClocks, Set<TaskId>>();
const resumedTurnsByClock = new WeakMap<TaskElapsedClocks, ReadonlyMap<TaskId, number>>();
const storeByClock = new WeakMap<TaskElapsedClocks, WeakRef<OwnerTaskStore>>();

/** Activity previews are bounded independently of authoritative session history. */
export const TASK_ACTIVITY_LIMIT = 64;
export const TASK_ACTIVITY_BYTES = 8192;
export type TaskAnchor = {
	taskId: TaskId;
	activitySequence: Cursor["sequence"];
	cellOffset: number;
	followBottom: boolean;
};
export type TaskActivity = { cursor: Cursor; report: ActivityReport };

function isBackground(observation: TaskRecord["observation"] | undefined): boolean {
	// Admission starts unobserved; that placeholder is not a background launch.
	return observation?.kind === "background" && observation.reason !== "not-observed";
}

/**
 * A session's view of its task owner. A subagent running in this owner launches its shells here too; the view lists
 * only this session's own tasks (its shells, and the subagents it launched), and `ownerTasks` all of the owner's.
 * A view subscription owns neither the owner nor its executions.
 */
export class OwnerTaskStore {
	private subscription?: TaskSubscription;
	private listeners = new Set<() => void>();
	private records = new Map<TaskId, TaskRecord>();
	private panelRevisionValue = 0;
	private activity = new Map<TaskId, TaskActivity[]>();
	private activityCursors = new Map<TaskId, bigint>();
	private omittedActivity = new Set<TaskId>();
	private backgroundIds = new Set<TaskId>();
	private settlements = new Map<TaskId, bigint>();
	private turnInterruptedIds = new Set<TaskId>();
	/** How many times each subagent's interrupted turn was resumed: the run it rests from after it stops again. */
	private resumedTurns = new Map<TaskId, number>();
	private readonly elapsedClocks = createManagedTaskClocks(this);
	readonly anchors = new Map<TaskId, TaskAnchor>();
	private current?: OwnerSnapshot;
	readonly supervisor: TaskSupervisor;
	private readonly owner: OwnerLease;
	constructor(supervisor: TaskSupervisor, owner: OwnerLease) {
		this.supervisor = supervisor;
		this.owner = owner;
		interruptedByClock.set(this.elapsedClocks, this.turnInterruptedIds);
		resumedTurnsByClock.set(this.elapsedClocks, this.resumedTurns);
		storeByClock.set(this.elapsedClocks, new WeakRef(this));
	}

	get snapshot(): OwnerSnapshot | undefined {
		return this.current;
	}
	get cursor(): Cursor | undefined {
		return this.current?.cursor;
	}
	/** This session's own tasks: its shells and the subagents it launched, never a subagent's shells. */
	get tasks(): TaskRecord[] {
		return sessionTasks(this.ownerTasks, undefined);
	}
	/** This session's own background tasks. Background membership survives foreground waits and terminal cleanup. */
	get backgroundTasks(): TaskRecord[] {
		return scopedBackgroundTasks(
			this,
			this.tasks.filter((task) => this.inBackground(task)),
		);
	}
	/** Every task of the owner, including the shells subagents running in it launched. */
	get ownerTasks(): TaskRecord[] {
		return [...this.records.values()];
	}
	get panelRevision(): number {
		return this.panelRevisionValue;
	}
	taskRecord(id: TaskId): TaskRecord | undefined {
		return this.records.get(id);
	}
	get ownerBackgroundTasks(): TaskRecord[] {
		return this.ownerTasks.filter((task) => this.inBackground(task));
	}
	private inBackground(task: TaskRecord): boolean {
		return task.wasBackground === true || isBackground(task.observation) || this.backgroundIds.has(task.ref.taskId);
	}
	/**
	 * Journal sequence at which each task settled; higher is more recent. Tasks first seen settled in a
	 * snapshot without their settlement event share that snapshot's sequence, so their order is unknown.
	 */
	get settlementOrder(): ReadonlyMap<TaskId, bigint> {
		return this.settlements;
	}
	getTask(id: TaskId): TaskRecord | undefined {
		return this.records.get(id);
	}
	/** Resolve only within the owner that authorized this store. */
	resolveTask(id: TaskId): Result<TaskLease, WaitError> {
		return this.supervisor.lookupTask(this.owner, id);
	}
	recentActivity(id: TaskId): TaskActivity[] {
		return [...(this.activity.get(id) ?? [])];
	}
	activityOmitted(id: TaskId): boolean {
		return this.omittedActivity.has(id);
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	connect(): Result<void, WatchError> {
		this.dispose();
		const watched = this.supervisor.watchOwnerTasks(this.owner, this.cursor);
		if (!watched.ok) return watched;
		const subscription = watched.value;
		this.subscription = subscription;
		this.reconcile(subscription.snapshot, []);
		subscription.onReconcile = (snapshot, events) => this.reconcile(snapshot, events);
		void this.observe(subscription);
		return { ok: true, value: undefined };
	}
	/** Useful at explicit host barriers; no transcript repaint timer is installed. */
	drain(): void {
		this.subscription?.drain();
	}
	dispose(): void {
		this.subscription?.dispose();
		this.subscription = undefined;
	}
	setTurnInterrupted(id: TaskId, interrupted: boolean): void {
		const record = this.records.get(id);
		if (interrupted) {
			if (record?.kind !== "agent" || record.execution.kind !== "running") return;
			if (this.turnInterruptedIds.has(id)) return;
			this.turnInterruptedIds.add(id);
			this.elapsedClocks.elapsedMs(id, record.metrics?.elapsedMs, false);
			this.panelRevisionValue++;
			this.notify();
			return;
		}
		if (!this.turnInterruptedIds.delete(id)) return;
		this.countResumedTurn(id);
		if (record !== undefined && record.execution.kind === "running") {
			this.elapsedClocks.elapsedMs(id, record.metrics?.elapsedMs, true);
		}
		this.panelRevisionValue++;
		this.notify();
	}
	private reconcile(snapshot: OwnerSnapshot, events: readonly NativeEvent[]): void {
		if (
			this.current &&
			(snapshot.ownerId !== this.current.ownerId || snapshot.generation !== this.current.generation)
		)
			throw new Error("StaleGeneration: cannot replace a task owner projection");
		if (this.current && BigInt(snapshot.cursor.sequence) <= BigInt(this.current.cursor.sequence)) return;
		this.current = snapshot;
		const priorSize = this.records.size;
		let existingSeen = 0;
		for (const event of events)
			if (event.payload.kind === "task-settled" && !this.settlements.has(event.payload.ref.taskId))
				this.settlements.set(event.payload.ref.taskId, BigInt(event.cursor.sequence));
		for (const task of snapshot.tasks) {
			const previous = this.records.get(task.ref.taskId);
			if (previous !== undefined) existingSeen++;
			if (previous === task) continue;
			if (
				previous === undefined ||
				previous.kind !== task.kind ||
				previous.execution.kind !== task.execution.kind ||
				previous.attention.kind !== task.attention.kind ||
				previous.parentTaskId !== task.parentTaskId ||
				previous.title !== task.title ||
				previous.agentName !== task.agentName ||
				previous.wasBackground !== task.wasBackground ||
				isBackground(previous.observation) !== isBackground(task.observation)
			) {
				this.panelRevisionValue++;
			}
			if (task.execution.kind !== "running") {
				this.turnInterruptedIds.delete(task.ref.taskId);
			}
			if (
				task.elapsedSpan === undefined &&
				previous?.execution.kind !== "settled" &&
				task.execution.kind !== "queued" &&
				(previous?.execution.kind !== task.execution.kind ||
					previous?.metrics?.elapsedMs !== task.metrics?.elapsedMs)
			) {
				if (task.execution.kind === "settled" && previous !== undefined)
					this.elapsedClocks.settle(task.ref.taskId, task.metrics?.elapsedMs);
				else
					this.elapsedClocks.elapsedMs(
						task.ref.taskId,
						task.metrics?.elapsedMs,
						taskClockRunning(task.execution.kind) && !this.turnInterruptedIds.has(task.ref.taskId),
					);
			}
			if (isBackground(task.observation) || isBackground(previous?.observation)) {
				if (!this.backgroundIds.has(task.ref.taskId)) {
					this.backgroundIds.add(task.ref.taskId);
				}
			}
			// Native settlement is immutable, even when recovering a view from a snapshot.
			const record =
				previous?.execution.kind === "settled" && task.execution !== previous.execution
					? { ...task, execution: previous.execution }
					: task;
			if (record !== previous) {
				bindTaskClock(record, this.elapsedClocks);
				if (
					record.execution.kind === "settled" &&
					record.execution.result.kind === "cancelled" &&
					record.execution.result.released !== undefined
				) {
					bindReleasedTaskOwner(record.ref, this.supervisor);
				}
			}
			this.records.set(task.ref.taskId, record);
			if (
				record.kind === "agent" &&
				record.execution.kind === "running" &&
				this.turnInterruptedIds.has(record.ref.taskId)
			) {
				const lease = this.resolveTask(record.ref.taskId);
				const bound = lease.ok ? taskTranscriptSource(lease.value) : undefined;
				if (bound?.ok && bound.value.session.isRunning?.() === true) {
					this.turnInterruptedIds.delete(record.ref.taskId);
					this.countResumedTurn(record.ref.taskId);
					this.panelRevisionValue++;
				}
			}
			if (task.execution.kind === "settled" && !this.settlements.has(task.ref.taskId))
				this.settlements.set(task.ref.taskId, BigInt(snapshot.cursor.sequence));
			if (!this.anchors.has(task.ref.taskId))
				this.anchors.set(task.ref.taskId, {
					taskId: task.ref.taskId,
					activitySequence: snapshot.cursor.sequence,
					cellOffset: 0,
					followBottom: true,
				});
		}
		if (existingSeen < priorSize) this.forgetEvicted(snapshot);
		this.notify();
	}
	private countResumedTurn(id: TaskId): void {
		this.resumedTurns.set(id, (this.resumedTurns.get(id) ?? 0) + 1);
	}
	/** A task absent from the authoritative projection was evicted by its owner (#4385): keep none of its view state. */
	private forgetEvicted(snapshot: OwnerSnapshot): void {
		const retained = new Set(snapshot.tasks.map((task) => task.ref.taskId));
		for (const id of [...this.records.keys()]) {
			if (retained.has(id)) continue;
			this.turnInterruptedIds.delete(id);
			this.resumedTurns.delete(id);
			this.records.delete(id);
			this.panelRevisionValue++;
			this.elapsedClocks.delete(id);
			this.settlements.delete(id);
			this.anchors.delete(id);
			this.backgroundIds.delete(id);
			this.activity.delete(id);
			this.activityCursors.delete(id);
			this.omittedActivity.delete(id);
		}
	}
	private async observe(subscription: TaskSubscription): Promise<void> {
		// Journal overflow ends the old iterator after publishing a reset snapshot.
		while (this.subscription === subscription && this.current?.state !== "closed") {
			for await (const event of subscription.events) {
				if (this.subscription !== subscription) return;
				this.retainActivity(event);
			}
			if (this.subscription !== subscription || this.snapshot?.state === "closed") return;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	private retainActivity(event: NativeEvent): void {
		if (event.payload.kind === "host-observation-changed" && isBackground(event.payload.observation)) {
			if (!this.backgroundIds.has(event.payload.ref.taskId)) {
				this.panelRevisionValue++;
			}
			this.backgroundIds.add(event.payload.ref.taskId);
			this.notify();
		}
		if (event.payload.kind !== "task-activity") return;
		const id = event.payload.ref.taskId;
		const sequence = BigInt(event.cursor.sequence);
		if (sequence <= (this.activityCursors.get(id) ?? -1n)) return;
		this.activityCursors.set(id, sequence);
		const entries = this.activity.get(id) ?? [];
		entries.push({ cursor: event.cursor, report: event.payload.activity });
		while (entries.length > TASK_ACTIVITY_LIMIT || Buffer.byteLength(JSON.stringify(entries)) > TASK_ACTIVITY_BYTES) {
			entries.shift();
			this.omittedActivity.add(id);
		}
		this.activity.set(id, entries);
		this.notify();
	}
	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}

// Host adapters bind their existing session object, never a model-provided owner id.
const sessionStores = new WeakMap<object, OwnerTaskStore>();
const storeSessions = new WeakMap<object, WeakRef<object>>();
const bindingListeners = new WeakMap<object, Set<() => void>>();
export function bindOwnerTaskStore(session: object, store: OwnerTaskStore): void {
	sessionStores.set(session, store);
	const weakSession = new WeakRef(session);
	storeSessions.set(store, weakSession);
	const clocks = taskClockOf(store);
	if (clocks !== undefined) storeSessions.set(clocks, weakSession);
	for (const listener of bindingListeners.get(session) ?? []) listener();
}
export function getOwnerTaskStore(session: object): OwnerTaskStore | undefined {
	return sessionStores.get(session);
}
export function getOwnerTaskSession(target: object): object | undefined {
	const clocks = taskClockOf(target);
	return (storeSessions.get(target) ?? (clocks === undefined ? undefined : storeSessions.get(clocks)))?.deref();
}
export function isTaskTurnInterrupted(task: TaskRecord): boolean {
	if (task.kind !== "agent" || task.execution.kind !== "running") return false;
	if (task.turnInterrupted === true) return true;
	const clocks = taskClockOf(task);
	return clocks !== undefined && interruptedByClock.get(clocks)?.has(task.ref.taskId) === true;
}
/**
 * How many times a subagent's interrupted turn was resumed, or undefined if it never was. It identifies the run the
 * subagent rests from: a turn resumed and interrupted or stopped again rests from a new one, however briefly it ran.
 */
export function taskResumedTurns(task: TaskRecord): number | undefined {
	if (task.resumedTurns !== undefined) return task.resumedTurns;
	const clocks = taskClockOf(task);
	return clocks === undefined ? undefined : resumedTurnsByClock.get(clocks)?.get(task.ref.taskId);
}
export function setTaskTurnInterrupted(target: object, id: TaskId, interrupted: boolean): void {
	if (target instanceof OwnerTaskStore) {
		target.setTurnInterrupted(id, interrupted);
		return;
	}
	const clocks = taskClockOf(target) ?? taskClocksFor(target);
	storeByClock.get(clocks)?.deref()?.setTurnInterrupted(id, interrupted);
}

/** Observe lazy producer binding without waiting for another tool/session event. */
export function watchOwnerTaskStoreBinding(session: object, listener: () => void): () => void {
	let listeners = bindingListeners.get(session);
	if (!listeners) {
		listeners = new Set();
		bindingListeners.set(session, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
