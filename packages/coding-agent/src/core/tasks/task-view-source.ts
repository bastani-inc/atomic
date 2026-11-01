import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { taskOutputText } from "./command-output.js";
import type { OperationId, TaskId, TaskRecord } from "./contracts.js";
import type { OwnerTaskStore, TaskActivity } from "./owner-store.js";
import {
	type TaskTranscriptSource,
	taskExtensionStatuses,
	taskOwnTranscriptEntries,
	taskTranscriptSource,
	watchTaskExtensionStatuses,
} from "./supervisor.js";
import { readTaskTranscriptSnapshot } from "./transcript.js";

export type TaskViewResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: { readonly message: string } };

/** A retained slice of a shell task's output, as text. */
export interface TaskOutputView {
	readonly text: string;
	/** Some of the requested bytes are no longer retained. */
	readonly omitted: boolean;
}

/** One page of an agent task's transcript, oldest first. */
export interface TaskTranscriptView {
	readonly messages: readonly AgentMessage[];
	/** Cursor of the page before this one, when earlier messages are retained. */
	readonly nextCursor?: string;
}

/** How an open transcript of a task follows it: through its live session, or by reading it again. */
export interface TaskTranscriptFollow {
	/** The task's session in this process, when it publishes live updates. */
	readonly session?: TaskTranscriptSource;
	/** The transcript has no live tail; a view reads it again when the task changes. */
	readonly historyOnly: boolean;
}

/** The prompt and latest reply of an agent task, for its detail page. */
export interface TaskDetailText {
	readonly prompt?: string;
	readonly output?: string;
}

/**
 * What the task inspector and a chat's task footer read and do: a session's own task store, or
 * the tasks of a session that runs in another process (a workflow stage on a local worker). It
 * names tasks by id, so a view never holds a task lease.
 */
export interface TaskViewSource {
	readonly tasks: readonly TaskRecord[];
	readonly backgroundTasks: readonly TaskRecord[];
	readonly settlementOrder: ReadonlyMap<TaskId, bigint>;
	recentActivity(id: TaskId): TaskActivity[];
	activityOmitted(id: TaskId): boolean;
	subscribe(listener: () => void): () => void;
	foregroundTask(id: TaskId): Promise<TaskViewResult<{ readonly kind: string }>>;
	cancelTask(id: TaskId): Promise<void>;
	stdinAvailable(id: TaskId): boolean;
	writeTaskInput(id: TaskId, text: string): Promise<TaskViewResult<{ readonly acceptedBytes: number }>>;
	readTaskOutput(
		id: TaskId,
		range: { readonly start: string; readonly maximumBytes: number },
	): Promise<TaskViewResult<TaskOutputView>>;
	/** Synchronous where the task's session is in this process, so a view reads it in the same turn. */
	taskDetailText(id: TaskId): TaskDetailText | Promise<TaskDetailText>;
	readTaskTranscript(
		id: TaskId,
		cursor?: string,
	): TaskViewResult<TaskTranscriptView> | Promise<TaskViewResult<TaskTranscriptView>>;
	followTaskTranscript(id: TaskId): TaskTranscriptFollow | undefined;
	extensionStatuses(id: TaskId): ReadonlyMap<string, string>;
	watchExtensionStatuses(id: TaskId, listener: () => void): () => void;
}

const NO_STATUSES: ReadonlyMap<string, string> = new Map();
const sources = new WeakMap<OwnerTaskStore, TaskViewSource>();

function messageText(message: AgentMessage): string | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** The task view of a session's own task store; one per store. */
export function ownerTaskViewSource(store: OwnerTaskStore): TaskViewSource {
	const existing = sources.get(store);
	if (existing !== undefined) return existing;
	const lease = (id: TaskId) => store.resolveTask(id);
	const source: TaskViewSource = {
		get tasks() {
			return store.tasks;
		},
		get backgroundTasks() {
			return store.backgroundTasks;
		},
		get settlementOrder() {
			return store.settlementOrder;
		},
		recentActivity: (id) => store.recentActivity(id),
		activityOmitted: (id) => store.activityOmitted(id),
		subscribe: (listener) => store.subscribe(listener),
		async foregroundTask(id) {
			const task = lease(id);
			if (!task.ok) return { ok: false, error: { message: task.error.message } };
			const result = await store.supervisor.foregroundTask(task.value);
			return result.ok
				? { ok: true, value: { kind: result.value.kind } }
				: { ok: false, error: { message: result.error.message } };
		},
		async cancelTask(id) {
			const task = lease(id);
			if (task.ok) await store.supervisor.cancelTask(task.value, "user");
		},
		stdinAvailable(id) {
			const task = lease(id);
			return task.ok && store.supervisor.taskStdin(task.value).ok;
		},
		async writeTaskInput(id, text) {
			const task = lease(id);
			if (!task.ok) return { ok: false, error: { message: task.error.message } };
			const stdin = store.supervisor.taskStdin(task.value);
			if (!stdin.ok) return { ok: false, error: { message: stdin.error.message } };
			const result = await store.supervisor.writeTaskInput(stdin.value, randomUUID() as OperationId, {
				kind: "bytes",
				bytes: Buffer.from(`${text}\n`),
			});
			return result.ok
				? { ok: true, value: { acceptedBytes: result.value.acceptedBytes } }
				: { ok: false, error: { message: result.error.message } };
		},
		async readTaskOutput(id, range) {
			const task = lease(id);
			if (!task.ok) return { ok: false, error: { message: task.error.message } };
			const page = await store.supervisor.readTaskOutput(task.value, {
				start: range.start,
				maximumBytes: range.maximumBytes,
			});
			return page.ok
				? { ok: true, value: { text: taskOutputText(page.value), omitted: page.value.omittedRanges.length > 0 } }
				: { ok: false, error: { message: page.error.message } };
		},
		taskDetailText(id) {
			const task = lease(id);
			if (!task.ok) return {};
			const entries = taskOwnTranscriptEntries(task.value);
			if (entries === undefined) return {};
			const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
			const prompt = messages.find((message) => message.role === "user");
			const response = messages
				.slice()
				.reverse()
				.find((message) => message.role === "assistant");
			const promptText = prompt === undefined ? undefined : messageText(prompt);
			const outputText = response === undefined ? undefined : messageText(response);
			return {
				...(promptText === undefined ? {} : { prompt: promptText }),
				...(outputText === undefined ? {} : { output: outputText }),
			};
		},
		readTaskTranscript(id, cursor) {
			const task = lease(id);
			if (!task.ok) return { ok: false, error: { message: task.error.message } };
			const page = readTaskTranscriptSnapshot(task.value, cursor);
			const bound = taskTranscriptSource(task.value);
			if (!bound.ok || (!page.ok && !bound.value.session.subscribe))
				return { ok: false, error: { message: "Transcript unavailable" } };
			const ids = new Set(page.ok ? page.value.items.map((item) => item.source.entryId) : []);
			const messages = bound.value.session.getEntries().flatMap<AgentMessage>((entry) => {
				if (entry.type !== "message" || !ids.has(entry.id)) return [];
				const message = entry.message;
				if (message.role === "assistant")
					return [
						{
							...message,
							content: message.content.filter(
								(block, index) =>
									block.type !== "thinking" &&
									page.ok &&
									page.value.items.some(
										(item) => item.source.entryId === entry.id && item.source.contentIndex === index,
									),
							),
						},
					];
				return message.role === "user" || message.role === "toolResult" ? [message] : [];
			});
			return {
				ok: true,
				value: {
					messages,
					...(page.ok && page.value.nextCursor !== undefined ? { nextCursor: page.value.nextCursor } : {}),
				},
			};
		},
		followTaskTranscript(id) {
			const task = lease(id);
			const bound = task.ok ? taskTranscriptSource(task.value) : undefined;
			if (!bound?.ok) return undefined;
			return { session: bound.value.session, historyOnly: bound.value.session.subscribe === undefined };
		},
		extensionStatuses(id) {
			const task = lease(id);
			return task.ok ? taskExtensionStatuses(task.value) : NO_STATUSES;
		},
		watchExtensionStatuses(id, listener) {
			const task = lease(id);
			return task.ok ? watchTaskExtensionStatuses(task.value, listener) : () => {};
		},
	};
	sources.set(store, source);
	return source;
}
