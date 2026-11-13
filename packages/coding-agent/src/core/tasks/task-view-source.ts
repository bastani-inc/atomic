import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionReason } from "../agent-session.js";
import { sessionEntryToContextMessages } from "../session-manager-history.ts";
import { expandSkillCommand, type SkillCatalogCommand } from "../skill-catalog.ts";
import { taskOutputText } from "./command-output.js";
import type { OperationId, TaskId, TaskRecord } from "./contracts.js";
import { TaskMessageError, TaskMessageTimeoutError } from "./message-error.js";
import type { OwnerTaskStore, TaskActivity } from "./owner-store.js";
import {
	type TaskMessageDelivery,
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
	/** On the latest page: why the task's session is compacting at the time of the read. */
	readonly compactionReason?: CompactionReason;
}

/** How an open transcript of a task follows it: through its live session, or by reading it again. */
export interface TaskTranscriptFollow {
	/** The task's session in this process, when it publishes live updates. */
	readonly session?: TaskTranscriptSource;
	/** The transcript has no live tail; a view reads it again when the task changes. */
	readonly historyOnly: boolean;
}

/** What a chat of an agent task completes, as plain data: its session's cwd and the skill commands it offers. */
export interface TaskCommandCatalog {
	/** The working directory `@` and path completions resolve against. */
	readonly cwd: string;
	/** The session's `/skill:` commands; empty when its settings do not offer skills as commands. */
	readonly skillCommands: readonly Pick<SkillCatalogCommand, "name" | "description" | "sourceInfo">[];
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
	/** Asks the task to stop; a failed request says why. */
	cancelTask(id: TaskId): Promise<TaskViewResult<undefined>>;
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
	/**
	 * Sends `text` to an agent task through its Intercom target, as a message typed into its transcript. Resolves
	 * once the channel confirmed delivery; rejects with a {@link TaskMessageError}. Absent where tasks cannot be
	 * messaged.
	 */
	sendTaskMessage?(id: TaskId, text: string): Promise<void>;
	/** What a chat of an agent task completes: its session's cwd and skill commands. Absent where unknown. */
	taskCommands?(id: TaskId): TaskCommandCatalog | undefined | Promise<TaskCommandCatalog | undefined>;
}

const NO_STATUSES: ReadonlyMap<string, string> = new Map();
const sources = new WeakMap<OwnerTaskStore, TaskViewSource>();
/** Each launched-task view by the task that launched them, under the view of every task. */
const launchedViews = new WeakMap<TaskViewSource, Map<TaskId, TaskViewSource>>();
/** The view of every task a launched-task view reads from. */
const launchedViewRoots = new WeakMap<TaskViewSource, TaskViewSource>();

/**
 * The tasks `launcher` launched, from `source`: a subagent's own shells and the subagents it launched, as a
 * subagent's chat lists them. Every task action goes to `source`. A view of a nested subagent reads the same tasks as
 * its parent's view, and each task has one view, so a chat that compares its view keeps its open task list.
 */
export function launchedTaskViewSource(source: TaskViewSource, launcher: TaskId): TaskViewSource {
	const root = launchedViewRoots.get(source) ?? source;
	const views = launchedViews.get(root) ?? new Map<TaskId, TaskViewSource>();
	launchedViews.set(root, views);
	const existing = views.get(launcher);
	if (existing !== undefined) return existing;
	const launched = (tasks: readonly TaskRecord[]) => tasks.filter((task) => task.parentTaskId === launcher);
	const sendTaskMessage = root.sendTaskMessage;
	const taskCommands = root.taskCommands;
	const view: TaskViewSource = {
		get tasks() {
			return launched(root.tasks);
		},
		get backgroundTasks() {
			return launched(root.backgroundTasks);
		},
		get settlementOrder() {
			return root.settlementOrder;
		},
		recentActivity: (id) => root.recentActivity(id),
		activityOmitted: (id) => root.activityOmitted(id),
		subscribe: (listener) => root.subscribe(listener),
		foregroundTask: (id) => root.foregroundTask(id),
		cancelTask: (id) => root.cancelTask(id),
		stdinAvailable: (id) => root.stdinAvailable(id),
		writeTaskInput: (id, text) => root.writeTaskInput(id, text),
		readTaskOutput: (id, range) => root.readTaskOutput(id, range),
		taskDetailText: (id) => root.taskDetailText(id),
		readTaskTranscript: (id, cursor) => root.readTaskTranscript(id, cursor),
		followTaskTranscript: (id) => root.followTaskTranscript(id),
		extensionStatuses: (id) => root.extensionStatuses(id),
		watchExtensionStatuses: (id, listener) => root.watchExtensionStatuses(id, listener),
		...(sendTaskMessage === undefined
			? {}
			: { sendTaskMessage: (id: TaskId, text: string) => sendTaskMessage.call(root, id, text) }),
		...(taskCommands === undefined ? {} : { taskCommands: (id: TaskId) => taskCommands.call(root, id) }),
	};
	views.set(launcher, view);
	launchedViewRoots.set(view, root);
	return view;
}

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
			if (!task.ok) return { ok: false, error: { message: task.error.message } };
			const result = await store.supervisor.cancelTask(task.value, "user");
			return result.ok ? { ok: true, value: undefined } : { ok: false, error: { message: result.error.message } };
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
			const items = page.ok ? page.value.items : [];
			const entryIds = new Set(items.map((item) => item.source.entryId));
			const itemIds = new Set(items.map((item) => item.id));
			const messages = bound.value.session.getEntries().flatMap<AgentMessage>((entry) => {
				if (!entryIds.has(entry.id)) return [];
				if (entry.type !== "message") return sessionEntryToContextMessages(entry);
				const message = entry.message;
				if (message.role === "assistant")
					return [
						{
							...message,
							content: message.content.filter((_, index) => itemIds.has(`${entry.id}:${index}`)),
						},
					];
				return message.role === "user" || message.role === "toolResult" ? [message] : [];
			});
			const compactionReason = cursor === undefined ? bound.value.session.getCompactionReason?.() : undefined;
			return {
				ok: true,
				value: {
					messages,
					...(page.ok && page.value.nextCursor !== undefined ? { nextCursor: page.value.nextCursor } : {}),
					...(compactionReason === undefined ? {} : { compactionReason }),
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
		taskCommands(id) {
			const task = lease(id);
			const bound = task.ok ? taskTranscriptSource(task.value) : undefined;
			const commands = bound?.ok ? bound.value.session.commands?.() : undefined;
			if (commands === undefined) return undefined;
			return {
				cwd: commands.cwd,
				skillCommands: commands.skillCommandsEnabled
					? commands.skills.commands.map(({ name, description, sourceInfo }) => ({
							name,
							description,
							sourceInfo,
						}))
					: [],
			};
		},
		watchExtensionStatuses(id, listener) {
			const task = lease(id);
			return task.ok ? watchTaskExtensionStatuses(task.value, listener) : () => {};
		},
		async sendTaskMessage(id, text) {
			const task = lease(id);
			if (!task.ok) throw new TaskMessageError("task-unavailable", { taskId: id });
			const bound = taskTranscriptSource(task.value);
			const session = bound.ok ? bound.value.session : undefined;
			const target = session?.completionSource?.intercomTarget;
			if (session?.sendMessage === undefined || target === undefined)
				throw new TaskMessageError("messages-unsupported", { taskId: id });
			// The message reaches the task as Intercom text, which its session does not expand, so a skill command is
			// expanded here from the task's own skills, as its session would expand it. A selector naming none is sent as typed.
			const skills = session.commands?.().skills;
			let delivery: TaskMessageDelivery;
			try {
				delivery = await session.sendMessage(skills === undefined ? text : expandSkillCommand(skills, text));
			} catch (cause) {
				throw new TaskMessageError("delivery-unconfirmed", { taskId: id, target }, { cause });
			}
			if (delivery.delivered) return;
			if (delivery.reason === "unconfirmed")
				throw new TaskMessageTimeoutError({
					taskId: id,
					target,
					timeoutMs: delivery.timeoutMs,
					elapsedMs: delivery.elapsedMs,
				});
			throw new TaskMessageError(delivery.reason === "lost" ? "delivery-unconfirmed" : "delivery-refused", {
				taskId: id,
				target,
				...(delivery.detail === undefined ? {} : { detail: delivery.detail }),
			});
		},
	};
	sources.set(store, source);
	return source;
}
