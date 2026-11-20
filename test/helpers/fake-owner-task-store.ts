import type { TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";

/**
 * An owner task store whose records a test sets directly: the session's subagents, and the shells subagents running in
 * it launched (they name the subagent's session in `launchedBy` and its task in `parentTaskId`). Each change tells the
 * store's subscribers, as a reconciled snapshot does.
 */
export class FakeOwnerTaskStore extends OwnerTaskStore {
	private fakeRecords: TaskRecord[];
	private fakeRevision = 1;
	private readonly fakeListeners = new Set<() => void>();
	/** The tasks stopped through this store, in order. A stopped shell settles as stopped by the user. */
	readonly cancelled: string[] = [];
	constructor(records: TaskRecord[]) {
		const supervisor = {
			cancelTask: async (lease: { readonly fakeTaskId: string }) => {
				this.cancelled.push(lease.fakeTaskId);
				this.update(lease.fakeTaskId, (task) => ({
					...task,
					execution: { kind: "settled", result: { kind: "cancelled", cause: "user" } },
				}));
				return { ok: true, value: undefined };
			},
		};
		super(supervisor as never, {} as never);
		this.fakeRecords = records;
	}
	override get ownerTasks(): TaskRecord[] {
		return [...this.fakeRecords];
	}
	override get panelRevision(): number {
		return this.fakeRevision;
	}
	override taskRecord(id: TaskId): TaskRecord | undefined {
		return this.fakeRecords.find((task) => task.ref.taskId === id);
	}
	override getTask(id: TaskId): TaskRecord | undefined {
		return this.taskRecord(id);
	}
	/** A shell resolves to a lease only this store's stop takes; no subagent runs here, so none resolves. */
	override resolveTask(id: TaskId): ReturnType<OwnerTaskStore["resolveTask"]> {
		if (this.taskRecord(id)?.kind === "command") return { ok: true, value: { fakeTaskId: id } } as never;
		return { ok: false, error: { code: "TaskNotFound", message: "This task is not running here." } } as never;
	}
	override subscribe(listener: () => void): () => void {
		this.fakeListeners.add(listener);
		return () => {
			this.fakeListeners.delete(listener);
		};
	}
	set(records: TaskRecord[]): void {
		this.fakeRecords = records;
		this.fakeRevision++;
		for (const listener of [...this.fakeListeners]) listener();
	}
	update(id: string, change: (task: TaskRecord) => TaskRecord): void {
		this.set(this.fakeRecords.map((task) => (task.ref.taskId === id ? change(task) : task)));
	}
}
