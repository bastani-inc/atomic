import type { TaskCompletionNotice } from "./completion.js";
import type { TaskId } from "./contracts.js";
import type { OwnerTaskStore } from "./owner-store.js";
import {
	loadTaskOwnTranscriptHistory,
	type TaskLease,
	type TaskTranscriptHistory,
	taskTranscriptSource,
} from "./supervisor.js";

/** A finished task's saved launch identity. Task numbers alone can be reused after a restart. */
export interface TaskTranscriptQuery {
	readonly taskId: string;
	readonly launchId: string;
	readonly ownerSessionId?: string;
}

/** Older notices recorded only their result, not which child to read. */
export function noticeTranscriptQuery(
	taskId: string,
	notice: TaskCompletionNotice | undefined,
	ownerSessionId?: string,
): TaskTranscriptQuery | undefined {
	if (notice?.launchId === undefined) return undefined;
	return { taskId, launchId: notice.launchId, ownerSessionId };
}

/**
 * What was saved of the transcripts of tasks this process no longer runs, as after a restart: a subagent's own session.
 * The extension that launched those tasks provides it, so a finished task's notice still shows the task's prompt and
 * tool calls once the task itself is gone.
 */
export interface SavedTaskTranscripts {
	readonly ownerSessionId?: string;
	/** Whether a transcript of the task was saved, answered from what is in memory, without reading it. */
	has(task: TaskTranscriptQuery): boolean;
	/** The task's saved transcript, read when a view shows it; undefined when none was saved. */
	load(task: TaskTranscriptQuery): Promise<TaskTranscriptHistory | undefined>;
}

// One registry per process, whichever loader loaded this module: the extension that registers and the views that read
// may each have their own copy of it.
const SOURCES = Symbol.for("@bastani/atomic/tasks/saved-transcripts");

function sources(): Set<SavedTaskTranscripts> {
	const scope = globalThis as { [SOURCES]?: Set<SavedTaskTranscripts> };
	scope[SOURCES] ??= new Set();
	return scope[SOURCES];
}

function* sourcesFor(task: TaskTranscriptQuery): Iterable<SavedTaskTranscripts> {
	for (const source of sources()) {
		if (
			task.ownerSessionId === undefined ||
			source.ownerSessionId === undefined ||
			source.ownerSessionId === task.ownerSessionId
		)
			yield source;
	}
}

/** Lets views read saved transcripts from `source`; returns the function that stops it. */
export function registerSavedTaskTranscripts(source: SavedTaskTranscripts): () => void {
	sources().add(source);
	return () => {
		sources().delete(source);
	};
}

/** The live lease only if it belongs to the launch named in the notice. */
function runningTask(store: OwnerTaskStore | undefined, task: TaskTranscriptQuery): TaskLease | undefined {
	if (store?.getTask(task.taskId as TaskId)?.launchOperationId !== task.launchId) return undefined;
	const lease = store.resolveTask(task.taskId as TaskId);
	return lease.ok ? lease.value : undefined;
}

/** Whether the notice can show its task's live or saved transcript. */
export function hasTaskTranscript(store: OwnerTaskStore | undefined, task: TaskTranscriptQuery | undefined): boolean {
	if (!task) return false;
	const lease = runningTask(store, task);
	if (lease !== undefined) return taskTranscriptSource(lease).ok;
	for (const source of sourcesFor(task)) if (source.has(task)) return true;
	return false;
}

/** A task's own transcript while this process runs it, otherwise the saved transcript of that launch. */
export async function loadTaskTranscript(
	store: OwnerTaskStore | undefined,
	task: TaskTranscriptQuery | undefined,
): Promise<TaskTranscriptHistory | undefined> {
	if (!task) return undefined;
	const lease = runningTask(store, task);
	if (lease !== undefined) return loadTaskOwnTranscriptHistory(lease);
	for (const source of sourcesFor(task)) {
		if (!source.has(task)) continue;
		const saved = await source.load(task);
		if (saved !== undefined) return saved;
	}
	return undefined;
}
