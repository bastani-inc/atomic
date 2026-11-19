import { noticeSubject, type TaskCompletionNotice } from "./completion.js";
import type { TaskId } from "./contracts.js";
import type { OwnerTaskStore } from "./owner-store.js";
import {
	loadTaskOwnTranscriptHistory,
	type TaskLease,
	type TaskTranscriptHistory,
	taskTranscriptSource,
} from "./supervisor.js";

/** The task a view asks about: its id, and what the view knows of it to tell it from another task with that id. */
export interface TaskTranscriptQuery {
	readonly taskId: string;
	/**
	 * The operation that launched it, such as a subagent's child id. A later process numbers its tasks from the start
	 * again, so a task id alone can name another task than the one the view is about.
	 */
	readonly launchId?: string;
	/** For a notice saved before notices named the launch: the agent that ran the task and its title as quoted. */
	readonly agentName?: string;
	readonly subject?: string;
}

/** What a finished task's notice knows of its task. */
export function noticeTranscriptQuery(taskId: string, notice: TaskCompletionNotice | undefined): TaskTranscriptQuery {
	return {
		taskId,
		...(notice?.launchId === undefined ? {} : { launchId: notice.launchId }),
		...(notice?.agentName === undefined ? {} : { agentName: notice.agentName }),
		...(notice?.line?.subject === undefined ? {} : { subject: notice.line.subject }),
	};
}

/**
 * What was saved of the transcripts of tasks this process no longer runs, as after a restart: a subagent's own session.
 * The extension that launched those tasks provides it, so a finished task's notice still shows the task's prompt and
 * tool calls once the task itself is gone.
 */
export interface SavedTaskTranscripts {
	/** Whether a transcript of the task was saved, answered from what is in memory, without reading it. */
	has(task: TaskTranscriptQuery): boolean;
	/** The task's saved transcript, read when a view shows it; undefined when none was saved. */
	load(task: TaskTranscriptQuery): Promise<TaskTranscriptHistory | undefined>;
	/** Whether more than one task this source knows of ran under `taskId`, in this process or an earlier one. */
	ranAsSeveral?(taskId: string): boolean;
}

// One registry per process, whichever loader loaded this module: the extension that registers and the views that read
// may each have their own copy of it.
const SOURCES = Symbol.for("@bastani/atomic/tasks/saved-transcripts");

function sources(): Set<SavedTaskTranscripts> {
	const scope = globalThis as { [SOURCES]?: Set<SavedTaskTranscripts> };
	scope[SOURCES] ??= new Set();
	return scope[SOURCES];
}

/** Lets views read saved transcripts from `source`; returns the function that stops it. */
export function registerSavedTaskTranscripts(source: SavedTaskTranscripts): () => void {
	sources().add(source);
	return () => {
		sources().delete(source);
	};
}

/** The task this process runs as `task`, unless that is another task under the same id. */
function runningTask(store: OwnerTaskStore | undefined, task: TaskTranscriptQuery): TaskLease | undefined {
	const lease = store?.resolveTask(task.taskId as TaskId);
	if (!lease?.ok) return undefined;
	const record = store?.getTask(task.taskId as TaskId);
	if (task.launchId !== undefined) return record?.launchOperationId === task.launchId ? lease.value : undefined;
	// An older notice names no launch: a running task of another agent or title is not the one it is about, and when
	// several tasks ran under its id, the running one cannot be told from the others.
	for (const source of sources()) if (source.ranAsSeveral?.(task.taskId)) return undefined;
	if (record === undefined) return lease.value;
	if (task.agentName !== undefined && record.agentName !== task.agentName) return undefined;
	if (task.subject !== undefined && noticeSubject(record.title) !== task.subject) return undefined;
	return lease.value;
}

/**
 * Whether a task's transcript can be shown: from the task while this process runs it, otherwise from what was saved of
 * it.
 */
export function hasTaskTranscript(store: OwnerTaskStore | undefined, task: TaskTranscriptQuery): boolean {
	const lease = runningTask(store, task);
	if (lease !== undefined) return taskTranscriptSource(lease).ok;
	for (const source of sources()) if (source.has(task)) return true;
	return false;
}

/**
 * A task's transcript: the task's own while this process runs it, otherwise what was saved of it, such as a finished
 * subagent's session after a restart. A saved session is read from its recent history, as the launch card reads it.
 */
export async function loadTaskTranscript(
	store: OwnerTaskStore | undefined,
	task: TaskTranscriptQuery,
): Promise<TaskTranscriptHistory | undefined> {
	const lease = runningTask(store, task);
	if (lease !== undefined) return loadTaskOwnTranscriptHistory(lease);
	for (const source of sources()) {
		if (!source.has(task)) continue;
		const saved = await source.load(task);
		if (saved !== undefined) return saved;
	}
	return undefined;
}
