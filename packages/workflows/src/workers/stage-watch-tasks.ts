import {
	findTaskMessageError,
	getOwnerTaskStore,
	type OwnerTaskStore,
	ownerTaskViewSource,
	type TaskId,
	TaskMessageError,
	type TaskViewSource,
	watchOwnerTaskStoreBinding,
} from "@bastani/atomic";
import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import type { PooledStageTasks, PooledTaskAction, PooledTaskReply } from "./stage-watch-types.js";

/** A watched stage's task changes reach its watcher at most this often, as one snapshot. */
export const STAGE_TASKS_INTERVAL_MS = 200;

/** A task source's state as plain data, for a watcher in another process. */
export function snapshotStageTasks(source: TaskViewSource): PooledStageTasks {
	const tasks = [...source.tasks];
	const background = source.backgroundTasks.map((task) => task.ref.taskId);
	return {
		tasks,
		background,
		settlement: [...source.settlementOrder].map(([id, sequence]) => [id, sequence.toString()] as const),
		activity: background.flatMap((id) => {
			const entries = source.recentActivity(id);
			const omitted = source.activityOmitted(id);
			return entries.length === 0 && !omitted ? [] : [{ id, entries, omitted }];
		}),
		stdin: tasks.flatMap((task) =>
			task.execution.kind !== "settled" && source.stdinAvailable(task.ref.taskId) ? [task.ref.taskId] : [],
		),
		statuses: tasks.flatMap((task) => {
			if (task.kind !== "agent") return [];
			const entries = [...source.extensionStatuses(task.ref.taskId)];
			return entries.length === 0 ? [] : [{ id: task.ref.taskId, entries }];
		}),
	};
}

/** Runs one action from a stage chat in another process on a task of `source`. */
export async function runStageTaskAction(
	source: TaskViewSource,
	taskId: TaskId,
	action: PooledTaskAction,
): Promise<PooledTaskReply> {
	switch (action.kind) {
		case "foreground":
			return { kind: "foreground", result: await source.foregroundTask(taskId) };
		case "cancel":
			return { kind: "cancel", result: await source.cancelTask(taskId) };
		case "input":
			return { kind: "input", result: await source.writeTaskInput(taskId, action.text) };
		case "output":
			return {
				kind: "output",
				result: await source.readTaskOutput(taskId, { start: action.start, maximumBytes: action.maximumBytes }),
			};
		case "detail":
			return { kind: "detail", detail: await source.taskDetailText(taskId) };
		case "message":
			return sendStageTaskMessage(source, taskId, action.text);
		case "transcript": {
			const result = await source.readTaskTranscript(taskId, action.cursor);
			// A viewer in another process cannot follow the task's session live; the latest page carries the
			// reply still streaming, as a live view shows it.
			const streaming =
				result.ok && action.cursor === undefined
					? source.followTaskTranscript(taskId)?.session?.getStreamingMessage?.()
					: undefined;
			if (!result.ok || streaming === undefined || streaming.role !== "assistant")
				return { kind: "transcript", result };
			return {
				kind: "transcript",
				result: { ok: true, value: { ...result.value, messages: [...result.value.messages, streaming] } },
			};
		}
	}
}

/** Sends a message typed into a task's transcript in the root, replying with its typed failure as data. */
async function sendStageTaskMessage(source: TaskViewSource, taskId: TaskId, text: string): Promise<PooledTaskReply> {
	if (source.sendTaskMessage === undefined)
		return { kind: "message", error: new TaskMessageError("messages-unsupported", { taskId }).toJSON() };
	try {
		await source.sendTaskMessage(taskId, text);
		return { kind: "message" };
	} catch (error) {
		const failure =
			findTaskMessageError(error) ?? new TaskMessageError("delivery-refused", { taskId }, { cause: error });
		return { kind: "message", error: failure.toJSON() };
	}
}

/** The task source of a stage's live session on this worker, once the session has one. */
export function stageTaskSource(handle: StageControlHandle): TaskViewSource | undefined {
	const session = handle.agentSession;
	const store = session === undefined ? undefined : getOwnerTaskStore(session);
	return store === undefined ? undefined : ownerTaskViewSource(store);
}

/**
 * Follows the background tasks of one watched stage's session and sends their state to the watcher
 * when they change, at most every {@link STAGE_TASKS_INTERVAL_MS}: task records, activity, which
 * accept input, and agent tasks' extension statuses (#3996). Nothing is followed until the session
 * has a task store, so a stage that launches no tasks sends nothing.
 */
export class WatchedStageTasks {
	private session?: object;
	private store?: OwnerTaskStore;
	private unbind?: () => void;
	private unsubscribe?: () => void;
	private readonly statusWatches = new Map<TaskId, () => void>();
	/** Agent tasks' sessions, followed so a viewer re-reads a transcript while its reply streams. */
	private readonly transcriptWatches = new Map<TaskId, () => void>();
	private timer?: NodeJS.Timeout;
	private disposed = false;

	constructor(
		private readonly handle: StageControlHandle,
		private readonly send: (tasks: PooledStageTasks) => void,
		private readonly intervalMs = STAGE_TASKS_INTERVAL_MS,
	) {}

	/** Binds to the stage's current session; call whenever the session may have started or been replaced. */
	sync(): void {
		if (this.disposed) return;
		const session = this.handle.agentSession;
		if (session === undefined || session === this.session) return;
		this.release();
		this.session = session;
		this.unbind = watchOwnerTaskStoreBinding(session, () => this.bindStore());
		this.bindStore();
	}

	/** Sends a change still waiting for its timer now, before the watch ends. */
	flushPending(): void {
		if (this.timer === undefined) return;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.flush();
	}

	dispose(): void {
		this.disposed = true;
		this.release();
	}

	private bindStore(): void {
		const session = this.session;
		const store = session === undefined ? undefined : getOwnerTaskStore(session);
		if (this.disposed || store === undefined || store === this.store) return;
		this.unsubscribe?.();
		this.store = store;
		this.unsubscribe = store.subscribe(() => this.schedule());
		this.schedule();
	}

	private schedule(): void {
		if (this.disposed || this.timer !== undefined) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, this.intervalMs);
		this.timer.unref?.();
	}

	private flush(): void {
		const store = this.store;
		if (this.disposed || store === undefined) return;
		const source = ownerTaskViewSource(store);
		const agents = new Set(source.tasks.filter((task) => task.kind === "agent").map((task) => task.ref.taskId));
		for (const watches of [this.statusWatches, this.transcriptWatches])
			for (const [id, release] of watches)
				if (!agents.has(id)) {
					release();
					watches.delete(id);
				}
		for (const id of agents) {
			if (!this.statusWatches.has(id))
				this.statusWatches.set(
					id,
					source.watchExtensionStatuses(id, () => this.schedule()),
				);
			if (!this.transcriptWatches.has(id)) {
				const session = source.followTaskTranscript(id)?.session;
				if (session?.subscribe !== undefined)
					this.transcriptWatches.set(
						id,
						session.subscribe(() => this.schedule()),
					);
			}
		}
		this.send(snapshotStageTasks(source));
	}

	private release(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.unbind?.();
		this.unbind = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		for (const release of [...this.statusWatches.values(), ...this.transcriptWatches.values()]) release();
		this.statusWatches.clear();
		this.transcriptWatches.clear();
		this.store = undefined;
		this.session = undefined;
	}
}
