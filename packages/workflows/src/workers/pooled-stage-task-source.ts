import {
	rehydrateTaskMessageError,
	type TaskActivity,
	type TaskDetailText,
	type TaskId,
	TaskMessageError,
	type TaskOutputView,
	type TaskRecord,
	type TaskTranscriptFollow,
	type TaskTranscriptView,
	type TaskViewResult,
	type TaskViewSource,
} from "@bastani/atomic";
import type { PooledStageTasks, PooledTaskAction, PooledTaskReply } from "./stage-watch-types.js";

const EMPTY: PooledStageTasks = { tasks: [], background: [], settlement: [], activity: [], stdin: [], statuses: [] };
const NO_STATUSES: ReadonlyMap<string, string> = new Map();

function failure<T>(error: Error | string): TaskViewResult<T> {
	return { ok: false, error: { message: typeof error === "string" ? error : error.message } };
}

/**
 * The background tasks of a stage on a local worker, for its chat's `/tasks` and task footer in the
 * root (#3996). It shows the state the worker last sent, and runs every action on the worker.
 */
export class PooledStageTaskSource implements TaskViewSource {
	private state = EMPTY;
	private records: TaskRecord[] = [];
	private backgroundRecords: TaskRecord[] = [];
	private settlements: ReadonlyMap<TaskId, bigint> = new Map();
	private activity = new Map<TaskId, { readonly entries: readonly TaskActivity[]; readonly omitted: boolean }>();
	private statuses = new Map<TaskId, ReadonlyMap<string, string>>();
	private stdin = new Set<TaskId>();
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly run: (taskId: TaskId, action: PooledTaskAction) => Promise<PooledTaskReply | undefined>,
		/** Whether a failure of `run` is the worker refusing the action before it ran. */
		private readonly refusedBeforeRunning: (error: unknown) => boolean = () => false,
	) {}

	/** Adopts the state the worker sent. */
	apply(state: PooledStageTasks): void {
		this.state = state;
		this.records = [...state.tasks];
		const background = new Set(state.background);
		this.backgroundRecords = this.records.filter((task) => background.has(task.ref.taskId));
		this.settlements = new Map(state.settlement.map(([id, sequence]) => [id, BigInt(sequence)]));
		this.activity = new Map(state.activity.map((entry) => [entry.id, entry]));
		this.statuses = new Map(state.statuses.map((entry) => [entry.id, new Map(entry.entries)]));
		this.stdin = new Set(state.stdin);
		for (const listener of [...this.listeners]) listener();
	}

	/** Whether the worker has sent any task yet. */
	get empty(): boolean {
		return this.state.tasks.length === 0;
	}

	get tasks(): readonly TaskRecord[] {
		return this.records;
	}
	get backgroundTasks(): readonly TaskRecord[] {
		return this.backgroundRecords;
	}
	get settlementOrder(): ReadonlyMap<TaskId, bigint> {
		return this.settlements;
	}
	recentActivity(id: TaskId): TaskActivity[] {
		return [...(this.activity.get(id)?.entries ?? [])];
	}
	activityOmitted(id: TaskId): boolean {
		return this.activity.get(id)?.omitted === true;
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	async foregroundTask(id: TaskId): Promise<TaskViewResult<{ readonly kind: string }>> {
		const reply = await this.request(id, { kind: "foreground" });
		return reply.ok ? (reply.value.kind === "foreground" ? reply.value.result : unexpected()) : reply;
	}
	async cancelTask(id: TaskId): Promise<TaskViewResult<undefined>> {
		const reply = await this.request(id, { kind: "cancel" });
		if (!reply.ok) return reply;
		return reply.value.kind === "cancel" ? (reply.value.result ?? { ok: true, value: undefined }) : unexpected();
	}
	stdinAvailable(id: TaskId): boolean {
		return this.stdin.has(id);
	}
	async writeTaskInput(id: TaskId, text: string): Promise<TaskViewResult<{ readonly acceptedBytes: number }>> {
		const reply = await this.request(id, { kind: "input", text });
		return reply.ok ? (reply.value.kind === "input" ? reply.value.result : unexpected()) : reply;
	}
	async readTaskOutput(
		id: TaskId,
		range: { readonly start: string; readonly maximumBytes: number },
	): Promise<TaskViewResult<TaskOutputView>> {
		const reply = await this.request(id, { kind: "output", start: range.start, maximumBytes: range.maximumBytes });
		return reply.ok ? (reply.value.kind === "output" ? reply.value.result : unexpected()) : reply;
	}
	async taskDetailText(id: TaskId): Promise<TaskDetailText> {
		const reply = await this.request(id, { kind: "detail" });
		return reply.ok && reply.value.kind === "detail" ? reply.value.detail : {};
	}
	async readTaskTranscript(id: TaskId, cursor?: string): Promise<TaskViewResult<TaskTranscriptView>> {
		const reply = await this.request(id, { kind: "transcript", ...(cursor === undefined ? {} : { cursor }) });
		return reply.ok ? (reply.value.kind === "transcript" ? reply.value.result : unexpected()) : reply;
	}
	/** An agent task's transcript is read again from the worker whenever its tasks change. */
	followTaskTranscript(id: TaskId): TaskTranscriptFollow | undefined {
		return this.records.some((task) => task.ref.taskId === id && task.kind === "agent")
			? { historyOnly: true }
			: undefined;
	}
	extensionStatuses(id: TaskId): ReadonlyMap<string, string> {
		return this.statuses.get(id) ?? NO_STATUSES;
	}
	watchExtensionStatuses(_id: TaskId, listener: () => void): () => void {
		return this.subscribe(listener);
	}
	/**
	 * Runs on the worker, whose session owns the task's Intercom relay; its typed failure comes back as data. Only
	 * a refusal before the worker ran the action is `delivery-refused`: after a lost or unreadable answer the message
	 * may have arrived, so it is `delivery-unconfirmed` and not retryable.
	 */
	async sendTaskMessage(id: TaskId, text: string): Promise<void> {
		let reply: PooledTaskReply | undefined;
		try {
			reply = await this.run(id, { kind: "message", text });
		} catch (cause) {
			if (this.refusedBeforeRunning(cause))
				throw new TaskMessageError("delivery-refused", { taskId: id }, { cause });
			throw new TaskMessageError(
				"delivery-unconfirmed",
				{ taskId: id, detail: "the local worker did not answer" },
				{ cause },
			);
		}
		if (reply === undefined) throw new TaskMessageError("task-unavailable", { taskId: id });
		if (reply.kind !== "message")
			throw new TaskMessageError("delivery-unconfirmed", {
				taskId: id,
				detail: "unexpected reply from the local worker",
			});
		if (reply.error === undefined) return;
		throw (
			rehydrateTaskMessageError(reply.error) ??
			new TaskMessageError("delivery-unconfirmed", { taskId: id, detail: "unreadable reply from the local worker" })
		);
	}

	private async request(id: TaskId, action: PooledTaskAction): Promise<TaskViewResult<PooledTaskReply>> {
		try {
			const reply = await this.run(id, action);
			return reply === undefined ? failure("Task unavailable") : { ok: true, value: reply };
		} catch (error) {
			return failure(error instanceof Error ? error : String(error));
		}
	}
}

function unexpected<T>(): TaskViewResult<T> {
	return failure("Unexpected reply from the local worker");
}
