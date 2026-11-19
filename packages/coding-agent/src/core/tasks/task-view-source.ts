import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { CompactionReason } from "../agent-session.js";
import { sessionEntryToContextMessages } from "../session-manager-history.ts";
import type { PublishedChatActivity } from "../session-retry-status.js";
import { expandSkillCommand, type SkillCatalogCommand } from "../skill-catalog.ts";
import { activeToolExecutionStarts, type ToolExecutionStart } from "../tool-execution-timing.ts";
import { readTaskOutputTail } from "./command-output.js";
import type { OperationId, TaskId, TaskRecord } from "./contracts.js";
import { bindTaskClockSource } from "./live-elapsed.js";
import { TaskMessageError, TaskMessageTimeoutError } from "./message-error.js";
import { isTaskTurnInterrupted, type OwnerTaskStore, type TaskActivity } from "./owner-store.js";
import { scopedBackgroundTasks } from "./session-scope.js";
import {
	loadTaskOwnTranscriptEntries,
	type TaskMessageDelivery,
	type TaskTranscriptSource,
	taskExtensionStatuses,
	taskOwnTranscriptEntries,
	taskTranscriptSource,
	watchTaskExtensionStatuses,
} from "./supervisor.js";
import { taskResumer } from "./task-resumer.ts";
import { taskTranscriptPage } from "./transcript.js";

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
	readonly compactionStartedAt?: number;
	readonly activeToolStarts?: readonly ToolExecutionStart[];
}

/** How an open transcript of a task follows it: through its live session, or by reading it again. */
export interface TaskTranscriptFollow {
	/** The task's session in this process, when it publishes live updates. */
	readonly session?: TaskTranscriptSource;
	/** The transcript has no live tail; a view reads it again when the task changes. */
	readonly historyOnly: boolean;
	/** Latest activity from a worker that publishes task state rather than live session events. */
	readonly publishedActivity?: PublishedChatActivity;
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
	/** The session's own tasks: its shells and the subagents it launched, never a subagent's shells. */
	readonly tasks: readonly TaskRecord[];
	readonly backgroundTasks: readonly TaskRecord[];
	/**
	 * Every task of the session's owner, including the shells its subagents launched there, which their views list.
	 * Absent where the source holds only the session's own.
	 */
	readonly ownerTasks?: readonly TaskRecord[];
	readonly ownerBackgroundTasks?: readonly TaskRecord[];
	readonly settlementOrder: ReadonlyMap<TaskId, bigint>;
	panelRevision?(): number | undefined;
	taskRecord?(id: TaskId): TaskRecord | undefined;
	recentActivity(id: TaskId): TaskActivity[];
	activityOmitted(id: TaskId): boolean;
	subscribe(listener: () => void): () => void;
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
	/**
	 * Interrupts an agent task's current turn, as Esc does in its chat. The task keeps running and waits for its next
	 * message. Absent where a view cannot interrupt a task's turn.
	 */
	interruptTask?(id: TaskId): Promise<TaskViewResult<undefined>>;
	/**
	 * Why a finished agent task's chat is read-only (it was stopped for good or is no longer kept), or `undefined` when
	 * a message resumes it. Absent where finished tasks cannot be resumed from a view.
	 */
	taskReadOnlyReason?(id: TaskId): string | undefined;
	/** Whether a subagent was stopped resumably and a message would resume it. */
	taskStopped?(id: TaskId): boolean;
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
	const interruptTask = root.interruptTask;
	const taskReadOnlyReason = root.taskReadOnlyReason;
	const taskStopped = root.taskStopped;
	const view: TaskViewSource = {
		// A subagent's shells are not its launcher's own tasks: they are read from the owner's.
		get tasks() {
			return launched(root.ownerTasks ?? root.tasks);
		},
		get backgroundTasks() {
			return scopedBackgroundTasks(view, launched(root.ownerBackgroundTasks ?? root.backgroundTasks));
		},
		get settlementOrder() {
			return root.settlementOrder;
		},
		panelRevision: () => root.panelRevision?.(),
		taskRecord(id) {
			const task = root.taskRecord
				? root.taskRecord(id)
				: root.tasks.find((candidate) => candidate.ref.taskId === id);
			return task?.parentTaskId === launcher ? task : undefined;
		},
		recentActivity: (id) => root.recentActivity(id),
		activityOmitted: (id) => root.activityOmitted(id),
		subscribe: (listener) => root.subscribe(listener),
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
		...(interruptTask === undefined ? {} : { interruptTask: (id: TaskId) => interruptTask.call(root, id) }),
		...(taskStopped === undefined ? {} : { taskStopped: (id: TaskId) => taskStopped.call(root, id) }),
		...(taskReadOnlyReason === undefined
			? {}
			: { taskReadOnlyReason: (id: TaskId) => taskReadOnlyReason.call(root, id) }),
	};
	views.set(launcher, view);
	launchedViewRoots.set(view, root);
	bindTaskClockSource(view, root);
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
		get ownerTasks() {
			return store.ownerTasks;
		},
		get ownerBackgroundTasks() {
			return store.ownerBackgroundTasks;
		},
		get settlementOrder() {
			return store.settlementOrder;
		},
		panelRevision: () => store.panelRevision,
		taskRecord: (id) => store.taskRecord(id),
		recentActivity: (id) => store.recentActivity(id),
		activityOmitted: (id) => store.activityOmitted(id),
		subscribe: (listener) => store.subscribe(listener),
		async cancelTask(id) {
			// A subagent stops resumably: its chat then says "Stopped · send to resume" (#5224).
			const resumable = taskResumer(store.supervisor)?.stop?.(id);
			if (resumable !== undefined) {
				const stopped = await resumable;
				return stopped.ok ? { ok: true, value: undefined } : { ok: false, error: { message: stopped.reason } };
			}
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
			const page = await readTaskOutputTail(store.supervisor, task.value, range);
			return page.ok ? page : { ok: false, error: { message: page.error.message } };
		},
		taskDetailText(id) {
			const task = lease(id);
			if (!task.ok) return {};
			// A finished task keeps its history in its session store, not in memory (#5186).
			if (taskTranscriptSourceLoads(task.value))
				return loadTaskOwnTranscriptEntries(task.value).then((entries) => detailText(entries));
			return detailText(taskOwnTranscriptEntries(task.value));
		},
		readTaskTranscript(id, cursor) {
			const task = lease(id);
			if (!task.ok) return { ok: false, error: { message: task.error.message } };
			const bound = taskTranscriptSource(task.value);
			if (!bound.ok) return { ok: false, error: { message: "Transcript unavailable" } };
			const { session, taskId } = bound.value;
			// A finished task keeps its history in its session store, not in memory (#5186).
			if (session.loadHistory)
				return session
					.loadHistory()
					.then((history) =>
						history.unavailable === undefined
							? transcriptView(session, taskId, history.entries, cursor)
							: { ok: false, error: { message: history.unavailable } },
					);
			if (session.loadFullHistory)
				return session.loadFullHistory().then(() => transcriptView(session, taskId, session.getEntries(), cursor));
			return transcriptView(session, taskId, session.getEntries(), cursor);
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
		async interruptTask(id) {
			const task = lease(id);
			if (!task.ok) return { ok: false, error: { message: task.error.message } };
			const bound = taskTranscriptSource(task.value);
			const interrupt = bound.ok ? bound.value.session.interruptTurn : undefined;
			if (!bound.ok || interrupt === undefined)
				return { ok: false, error: { message: "This task's turn cannot be interrupted from here." } };
			try {
				await interrupt.call(bound.value.session);
				if (bound.value.session.isRunning?.() !== true) {
					store.setTurnInterrupted(id, true);
				}
				return { ok: true, value: undefined };
			} catch (error) {
				return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
			}
		},
		taskStopped(id) {
			const record = store.getTask(id);
			return (
				(record !== undefined && isTaskTurnInterrupted(record)) ||
				taskResumer(store.supervisor)?.isStopped?.(id) === true
			);
		},
		taskReadOnlyReason(id) {
			const record = store.tasks.find((candidate) => candidate.ref.taskId === id);
			if (record === undefined) return "This task is no longer kept; its chat is read-only.";
			if (record.kind !== "agent" || record.execution.kind !== "settled") return undefined;
			const resumer = taskResumer(store.supervisor);
			if (resumer === undefined) return "This subagent has finished; its chat is read-only.";
			return resumer.readOnlyReason(id);
		},
		async sendTaskMessage(id, text) {
			const record = store.tasks.find((candidate) => candidate.ref.taskId === id);
			const resumer = taskResumer(store.supervisor);
			// A finished subagent continues in its own session with the message, as `subagent resume` continues it.
			if (record?.kind === "agent" && record.execution.kind === "settled" && resumer !== undefined) {
				const reason = resumer.readOnlyReason(id);
				if (reason !== undefined) throw new TaskMessageError("delivery-refused", { taskId: id, detail: reason });
				const resumed = await resumer.resume(id, text);
				if (!resumed.ok) throw new TaskMessageError("delivery-refused", { taskId: id, detail: resumed.reason });
				return;
			}
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
				delivery = await session.sendMessage(skills === undefined ? text : await expandSkillCommand(skills, text));
			} catch (cause) {
				throw new TaskMessageError("delivery-unconfirmed", { taskId: id, target }, { cause });
			}
			if (delivery.delivered) {
				store.setTurnInterrupted(id, false);
				return;
			}
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
	bindTaskClockSource(source, store);
	return source;
}

function taskTranscriptSourceLoads(task: Parameters<typeof taskTranscriptSource>[0]): boolean {
	const bound = taskTranscriptSource(task);
	return bound.ok && bound.value.session.loadHistory !== undefined;
}

/** The prompt and the last response in a task's own history. */
function detailText(entries: ReturnType<TaskTranscriptSource["getEntries"]> | undefined): TaskDetailText {
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
}

/** The page of a task's transcript ending before `cursor`, read from `entries`, its session's history. */
function transcriptView(
	session: TaskTranscriptSource,
	taskId: string,
	entries: ReturnType<TaskTranscriptSource["getEntries"]>,
	cursor: string | undefined,
): TaskViewResult<TaskTranscriptView> {
	const page = taskTranscriptPage(taskId, session.getSessionId(), entries, cursor);
	if (!page.ok && !session.subscribe) return { ok: false, error: { message: "Transcript unavailable" } };
	const items = page.ok ? page.value.items : [];
	const entryIds = new Set(items.map((item) => item.source.entryId));
	const itemIds = new Set(items.map((item) => item.id));
	const messages = entries.flatMap<AgentMessage>((entry) => {
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
		return [message];
	});
	const compactionReason = cursor === undefined ? session.getCompactionReason?.() : undefined;
	const compactionStartedAt = compactionReason === undefined ? undefined : session.chatSession?.compactionStartedAt;
	const activeToolStarts =
		cursor === undefined && session.chatSession !== undefined ? activeToolExecutionStarts(session.chatSession) : [];
	return {
		ok: true,
		value: {
			messages,
			...(page.ok && page.value.nextCursor !== undefined ? { nextCursor: page.value.nextCursor } : {}),
			...(compactionReason === undefined ? {} : { compactionReason }),
			...(compactionStartedAt === undefined ? {} : { compactionStartedAt }),
			...(activeToolStarts.length === 0 ? {} : { activeToolStarts }),
		},
	};
}
