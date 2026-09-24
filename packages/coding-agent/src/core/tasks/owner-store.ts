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
import type { OwnerLease, TaskLease, TaskSubscription, TaskSupervisor } from "./supervisor.js";

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

/** A view subscription owns neither the owner nor its executions. */
export class OwnerTaskStore {
	private subscription?: TaskSubscription;
	private listeners = new Set<() => void>();
	private records = new Map<TaskId, TaskRecord>();
	private activity = new Map<TaskId, TaskActivity[]>();
	private activityCursors = new Map<TaskId, bigint>();
	private omittedActivity = new Set<TaskId>();
	private backgroundIds = new Set<TaskId>();
	private settlements = new Map<TaskId, bigint>();
	readonly anchors = new Map<TaskId, TaskAnchor>();
	private current?: OwnerSnapshot;
	readonly supervisor: TaskSupervisor;
	private readonly owner: OwnerLease;
	constructor(supervisor: TaskSupervisor, owner: OwnerLease) {
		this.supervisor = supervisor;
		this.owner = owner;
	}

	get snapshot(): OwnerSnapshot | undefined {
		return this.current;
	}
	get cursor(): Cursor | undefined {
		return this.current?.cursor;
	}
	get tasks(): TaskRecord[] {
		return [...this.records.values()];
	}
	/** Background membership survives foreground waits and terminal observation cleanup. */
	get backgroundTasks(): TaskRecord[] {
		return this.tasks.filter(
			(task) => task.wasBackground || isBackground(task.observation) || this.backgroundIds.has(task.ref.taskId),
		);
	}
	/**
	 * Journal sequence at which each task settled; higher is more recent. Tasks first seen settled in a
	 * snapshot without their settlement event share that snapshot's sequence, so their order is unknown.
	 */
	get settlementOrder(): ReadonlyMap<TaskId, bigint> {
		return this.settlements;
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
	private reconcile(snapshot: OwnerSnapshot, events: readonly NativeEvent[]): void {
		if (
			this.current &&
			(snapshot.ownerId !== this.current.ownerId || snapshot.generation !== this.current.generation)
		)
			throw new Error("StaleGeneration: cannot replace a task owner projection");
		if (this.current && BigInt(snapshot.cursor.sequence) <= BigInt(this.current.cursor.sequence)) return;
		this.current = snapshot;
		for (const event of events)
			if (event.payload.kind === "task-settled" && !this.settlements.has(event.payload.ref.taskId))
				this.settlements.set(event.payload.ref.taskId, BigInt(event.cursor.sequence));
		for (const task of snapshot.tasks) {
			const previous = this.records.get(task.ref.taskId);
			if (isBackground(task.observation) || isBackground(previous?.observation))
				this.backgroundIds.add(task.ref.taskId);
			// Native settlement is immutable, even when recovering a view from a snapshot.
			this.records.set(
				task.ref.taskId,
				previous?.execution.kind === "settled" ? { ...task, execution: previous.execution } : task,
			);
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
		this.notify();
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
const bindingListeners = new WeakMap<object, Set<() => void>>();
export function bindOwnerTaskStore(session: object, store: OwnerTaskStore): void {
	sessionStores.set(session, store);
	for (const listener of bindingListeners.get(session) ?? []) listener();
}
export function getOwnerTaskStore(session: object): OwnerTaskStore | undefined {
	return sessionStores.get(session);
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
