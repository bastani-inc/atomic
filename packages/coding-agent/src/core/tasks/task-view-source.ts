import { createHash, randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { CompactionReason } from "../agent-session.js";
import { sessionEntryToContextMessages } from "../session-manager-history.ts";
import type { PublishedChatActivity } from "../session-retry-status.js";
import { expandSkillCommand, type SkillCatalogCommand } from "../skill-catalog.ts";
import { transcriptCursorWithin } from "../storage/session/history-pages.js";
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
import { loadArchiveSnapshot } from "./task-archive-snapshot.ts";
import type { FileTaskPage } from "./task-file-history.js";
import { taskResumer } from "./task-resumer.ts";
import { taskTranscriptPageWithCuts } from "./transcript.js";
import { bindSavedTaskOrigins, noteSavedSeq } from "./transcript-origin.js";

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
	/** Cursor of the page after this one, within a saved transcript's pinned snapshot. */
	readonly newerCursor?: string;
	/** True when evicted pages can be reread in either direction. */
	readonly savedWindow?: true;
	/** On the latest page: why the task's session is compacting at the time of the read. */
	readonly compactionReason?: CompactionReason;
	readonly compactionStartedAt?: number;
	readonly activeToolStarts?: readonly ToolExecutionStart[];
}

/** @internal Only split assistants with a standalone provider error participate. No tool data or error text is sent. */
export interface TaskTranscriptFragments {
	readonly notices: readonly NoticePosition[];
}
type NoticePosition = { index: number; occurrence: string; cut: "before" | "after" | "both" };
type PageResult = TaskViewResult<TaskTranscriptView>;
type Entries = ReturnType<TaskTranscriptSource["getEntries"]>;
type ArchiveReader = (
	project: (
		entries: Entries,
		storedRows: number,
		generation: () => Promise<string | undefined>,
		identifyRow?: (generation: string, row: number) => string | undefined,
	) => PageResult | Promise<PageResult>,
	loadSnapshot: typeof loadArchiveSnapshot,
) => Promise<PageResult>;
export interface FileArchive {
	readonly path: string;
	readonly sessionId: string;
	readonly unsaved?: Entries[number];
}
const fileArchives = new WeakMap<TaskTranscriptSource, FileArchive>();
const unsavedAnswers = new WeakMap<TaskTranscriptSource, Entries[number]>();
const archives = new WeakMap<
	TaskTranscriptSource,
	{ load: TaskTranscriptSource["loadHistory"]; read: ArchiveReader }
>();

function archiveReader(source: TaskTranscriptSource): ArchiveReader | undefined {
	const archive = archives.get(source);
	return archive && !isProxy(source) && archive.load === Object.getOwnPropertyDescriptor(source, "loadHistory")?.value
		? archive.read
		: undefined;
}

/** @internal The session file a first-party archive reader bound to exactly this source reads, if any. */
export function taskTranscriptFile(source: TaskTranscriptSource): FileArchive | undefined {
	return archiveReader(source) ? fileArchives.get(source) : undefined;
}

/** @internal The final answer a first-party source shows after its saved history because its session could not save it. */
export function taskTranscriptUnsavedAnswer(source: TaskTranscriptSource): Entries[number] | undefined {
	return archiveReader(source) ? (unsavedAnswers.get(source) ?? fileArchives.get(source)?.unsaved) : undefined;
}

/** @internal A first-party archive reader supplies the identity of the records it returned. */
export function withTaskTranscriptArchive<T extends TaskTranscriptSource>(
	source: T,
	reader: ArchiveReader | TaskTranscriptSource,
	file?: FileArchive,
	unsaved?: Entries[number],
): T {
	const archive = typeof reader === "function" ? reader : archiveReader(reader);
	if (archive) {
		archives.set(source, { load: source.loadHistory, read: archive });
		const bound = file ?? (typeof reader === "function" ? undefined : fileArchives.get(reader));
		if (bound) fileArchives.set(source, bound);
		const answer = unsaved ?? (typeof reader === "function" ? undefined : unsavedAnswers.get(reader));
		if (answer) unsavedAnswers.set(source, answer);
	}
	return source;
}

const liveRecords = new WeakMap<object, { reply: WeakRef<object>; token: string }>();
function replyOccurrence(entry: object, message: object): string {
	const previous = liveRecords.get(entry);
	if (previous?.reply.deref() === message) return previous.token;
	const token = randomUUID();
	liveRecords.set(entry, { reply: new WeakRef(message), token });
	return token;
}

/** An SDK can compute a block kind on demand. Don't consume it again just to elide a duplicate. */
export function plainNoticeBlock(block: object): boolean {
	if (!block || typeof block !== "object" || isProxy(block)) return false;
	const kind = Object.getOwnPropertyDescriptor(block, "type")?.value;
	return kind === "text" || kind === "thinking";
}

const fragmentsByResult = new WeakMap<TaskViewResult<TaskTranscriptView>, TaskTranscriptFragments>();

/** @internal Only the page producer and its worker transport know which durable entries the window cuts. */
export function bindTaskTranscriptFragments(
	result: TaskViewResult<TaskTranscriptView>,
	fragments: TaskTranscriptFragments,
): void {
	fragmentsByResult.set(result, fragments);
}

/** @internal Foreign SDK page objects keep their existing contract, without property probes. */
export function taskTranscriptFragments(
	result: TaskViewResult<TaskTranscriptView>,
): TaskTranscriptFragments | undefined {
	return fragmentsByResult.get(result);
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
	taskDetailText(id: TaskId, signal?: AbortSignal): TaskDetailText | Promise<TaskDetailText>;
	readTaskTranscript(
		id: TaskId,
		cursor?: string,
		signal?: AbortSignal,
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

const cancellablePages = new WeakSet<TaskViewSource["readTaskTranscript"]>();
export function readTaskPageForView(
	source: TaskViewSource,
	id: TaskId,
	cursor: string | undefined,
	signal: AbortSignal,
) {
	const read = source.readTaskTranscript;
	return cancellablePages.has(read)
		? read.call(source, id, cursor, signal)
		: cursor === undefined
			? read.call(source, id)
			: read.call(source, id, cursor);
}
const cancellableDetails = new WeakSet<TaskViewSource["taskDetailText"]>();
/** Pass cancellation only to a detail reader that accepts it. Old SDK readers see their original arguments. */
export function readTaskDetailForView(source: TaskViewSource, id: TaskId, signal?: AbortSignal) {
	const read = source.taskDetailText;
	return signal && cancellableDetails.has(read) ? read.call(source, id, signal) : read.call(source, id);
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
		taskDetailText: (id, signal) => readTaskDetailForView(root, id, signal),
		readTaskTranscript: (id, cursor, signal) =>
			signal ? readTaskPageForView(root, id, cursor, signal) : root.readTaskTranscript(id, cursor),
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
	cancellablePages.add(view.readTaskTranscript);
	cancellableDetails.add(view.taskDetailText);
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
		taskDetailText(id, signal) {
			const task = lease(id);
			if (!task.ok) return {};
			const source = taskTranscriptSource(task.value);
			if (source.ok) {
				const { session, inheritedThroughId } = source.value;
				const file = fileArchives.get(session);
				if (file && archiveReader(session))
					return import("./task-file-history.js")
						.then(({ taskFileDetail }) =>
							taskFileDetail(file.path, file.sessionId, inheritedThroughId, messageText, signal),
						)
						.then((value) =>
							file.unsaved?.type === "message" && file.unsaved.message.role === "assistant"
								? { ...value, output: messageText(file.unsaved.message) }
								: value,
						)
						.catch(() => detailText(session.getFallbackEntries?.()));
			}
			if (source.ok && source.value.session.readHistory && source.value.session.loadHistory) {
				const { session, inheritedThroughId } = source.value;
				return savedTaskDetailText(session, inheritedThroughId)
					.then((value) => {
						const answer = taskTranscriptUnsavedAnswer(session);
						return answer?.type === "message" && answer.message.role === "assistant"
							? { ...value, output: messageText(answer.message) }
							: value;
					})
					.catch(() => detailText(session.getFallbackEntries?.()));
			}
			// A finished task keeps its history in its session store, not in memory (#5186).
			if (taskTranscriptSourceLoads(task.value))
				return loadTaskOwnTranscriptEntries(task.value).then((entries) => detailText(entries));
			return detailText(taskOwnTranscriptEntries(task.value));
		},
		readTaskTranscript(id, cursor, signal) {
			const task = lease(id);
			if (!task.ok) return { ok: false, error: { message: task.error.message } };
			const bound = taskTranscriptSource(task.value);
			if (!bound.ok) return { ok: false, error: { message: "Transcript unavailable" } };
			const { session, taskId } = bound.value;
			const file = fileArchives.get(session);
			if (file && archiveReader(session) && !session.subscribe)
				return import("./task-file-history.js").then(({ taskFilePages }) =>
					savedTranscriptView(
						session,
						taskId,
						(opts) => taskFilePages(file.path, file.sessionId, opts ?? {}),
						cursor,
						file,
						signal,
					),
				);
			if (session.readHistory && ((session.loadHistory && !session.subscribe) || cursor?.includes(":")))
				return savedTranscriptView(session, taskId, session.readHistory.bind(session), cursor, undefined, signal);
			// A finished task keeps its history in its session store, not in memory (#5186).
			if (session.loadHistory) {
				const archive = archiveReader(session);
				if (archive) return readArchivedPage(session, taskId, cursor, archive);
				return session
					.loadHistory()
					.then((history) =>
						history.unavailable === undefined
							? transcriptView(session, taskId, history.entries, cursor)
							: { ok: false, error: { message: history.unavailable } },
					);
			}
			// Managers expose mutable in-window messages. As on a saved read, observe a historical page after
			// the initiating event; the initial snapshot and its live subscription stay in the same turn.
			if (cursor !== undefined && session.readHistory && !session.subscribe)
				return Promise.resolve().then(() => transcriptView(session, taskId, session.getEntries(), cursor));
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
	cancellablePages.add(source.readTaskTranscript);
	cancellableDetails.add(source.taskDetailText);
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

async function savedTaskDetailText(
	session: TaskTranscriptSource,
	throughId: string | undefined,
): Promise<TaskDetailText> {
	let own = throughId === undefined,
		prompt: string | undefined,
		output: string | undefined;
	for await (const { items } of session.readHistory!()) {
		for (const item of items) {
			if ("entry" in item) {
				const { entry } = item;
				if (!own) {
					if (entry.id === throughId) own = true;
					continue;
				}
				if (entry.type !== "message") continue;
				if (prompt === undefined && entry.message.role === "user") prompt = messageText(entry.message);
				if (entry.message.role === "assistant") output = messageText(entry.message);
			} else {
				if (!session.readHistoryChunks)
					throw new TypeError("The task history source must implement readHistoryChunks for oversized entries");
				const { chunkedTaskDetailFields } = await import("../storage/session/chunked-resume-projection.js");
				const info = await chunkedTaskDetailFields(
					() => session.readHistoryChunks!(item),
					own ? undefined : throughId,
				);
				if (!own) {
					if (info.inheritedEnd) own = true;
					continue;
				}
				const ref = `Saved entry ${item.seq} is ${item.bytes} bytes. Open its session history or export the session for the original bytes.`;
				if (prompt === undefined && info.role === "user") prompt = ref;
				if (info.role === "assistant") output = ref;
			}
		}
	}
	return { ...(prompt !== undefined ? { prompt } : {}), ...(output !== undefined ? { output } : {}) };
}

function savedTaskScope(taskId: string, sessionId: string): string {
	return `${createHash("sha256")
		.update(JSON.stringify([taskId, sessionId]))
		.digest("base64url")}:`;
}

/**
 * The saved-row origin of a live task message stored at `seq`: what the saved page that shows it again calls it.
 * Known once the session has saved history before its live context, which is when a row can leave the window.
 */
export function liveTaskRowOrigin(session: TaskTranscriptSource, taskId: string, seq: number): string | undefined {
	const generation = session.getEarlierCursor?.()?.split(".", 1)[0];
	return generation ? `${savedTaskScope(taskId, session.getSessionId())}${generation}:${seq}` : undefined;
}

/**
 * Cursors of a live task's saved prefix before and after the saved sequences `first` to `last`, which a page the
 * reader keeps on screen shows. Reading on from either continues through the whole prefix.
 */
export function taskCursorsAround(
	session: TaskTranscriptSource,
	taskId: string,
	first: number,
	last: number,
): { readonly older?: string; readonly newer?: string } {
	const earlier = session.getEarlierCursor?.();
	if (earlier === undefined) return {};
	const scope = savedTaskScope(taskId, session.getSessionId());
	const older = transcriptCursorWithin(earlier, 1, first - 1, true);
	const newer = transcriptCursorWithin(earlier, last + 1, Number.MAX_SAFE_INTEGER, false);
	return {
		...(older === undefined ? {} : { older: `${scope}${older}~b` }),
		...(newer === undefined ? {} : { newer: `${scope}${newer}~f` }),
	};
}

/** One saved page at a time; skipping a page of invisible bookkeeping doesn't keep that page alive. */
async function savedTranscriptView(
	session: TaskTranscriptSource,
	taskId: string,
	read: (
		options: Parameters<NonNullable<TaskTranscriptSource["readHistory"]>>[0],
	) => AsyncIterable<import("../storage/session/types.js").SessionHistoryPage | FileTaskPage>,
	cursor: string | undefined,
	file?: FileArchive,
	signal?: AbortSignal,
): Promise<TaskViewResult<TaskTranscriptView>> {
	const sessionId = file?.sessionId ?? session.getSessionId();
	const scope = savedTaskScope(taskId, sessionId);
	if (cursor !== undefined && !cursor.startsWith(scope))
		return { ok: false, error: { message: "Transcript cursor belongs to another task or session" } };
	const encoded = cursor?.slice(scope.length);
	// Also page within a single saved entry: a reply can contain hundreds of independently shown blocks.
	const slice = encoded === undefined ? undefined : /^(.*)~([fb])(\d*)$/.exec(encoded);
	const raw = slice ? slice[1] : encoded;
	const forward = Boolean(slice && slice[2] === "f");
	let offset = slice?.[3] ? Number(slice[3]) : undefined;
	if (offset !== undefined && !Number.isSafeInteger(offset))
		return { ok: false, error: { message: "Invalid transcript cursor" } };
	for await (const page of read({
		...(raw === undefined ? { direction: "backward" as const } : { cursor: raw }),
		adjacent: true,
		...(signal ? { signal } : {}),
	})) {
		signal?.throwIfAborted();
		const entries: Entries = page.items.map((item) =>
			"entry" in item
				? item.entry
				: {
						type: "message",
						id: `oversized-${item.seq}`,
						parentId: null,
						timestamp: "1970-01-01T00:00:00Z",
						message: {
							role: "custom",
							customType: "atomic.oversized-history-entry",
							display: true,
							timestamp: 0,
							content: `${file ? `Saved file entry at byte ${item.seq}` : `Saved entry ${item.seq}`} is ${item.bytes} bytes. Read the original bytes with the session history reader or export this session.`,
						},
					},
		);
		const unsaved = taskTranscriptUnsavedAnswer(session);
		if (!page.adjacent?.newer && unsaved?.type === "message") {
			const { taskAnswerMissing } = await import("./task-unsaved-answer.js");
			const records = async function* (span: typeof page) {
				for (let i = span.items.length - 1; i >= 0; i--) {
					const row = span.items[i]!;
					if ("entry" in row) yield row;
					else if (file) {
						const { taskFileEntryChunks } = await import("./task-file-history.js");
						yield {
							chunks: () =>
								taskFileEntryChunks(
									file.path,
									file.sessionId,
									span.adjacent!.current!,
									row.seq,
									row.bytes,
									signal,
								),
						};
					} else if ("epoch" in row && session.readHistoryChunks)
						yield { chunks: () => session.readHistoryChunks!(row, { signal }) };
				}
			};
			const missing = await taskAnswerMissing(
				unsaved,
				(async function* () {
					yield* records(page);
					const prior = page.adjacent?.older;
					if (prior)
						for await (const older of read({ cursor: prior, adjacent: true, signal })) yield* records(older);
				})(),
			);
			if (missing) entries.push(unsaved);
		}
		const origins = new Map<AgentMessage, string>();
		let from = 0,
			end = 0,
			count = 0;
		const result = transcriptView(
			session,
			taskId,
			entries,
			undefined,
			{
				storedRows: entries.length,
				origin(row, message, fragment) {
					const seq = page.items[row]?.seq;
					if (!file && seq !== undefined) noteSavedSeq(message, seq);
					const record = file
						? createHash("sha256").update(JSON.stringify(entries[row])).digest("base64url")
						: page.adjacent?.current?.split(".", 1)[0];
					if (record) origins.set(message, `${scope}${record}:${page.items[row]?.seq ?? "unsaved"}:${fragment}`);
				},
				collect(row, notice) {
					// The cursor's source fingerprint identifies this generation. The sequence identifies its saved reply.
					if (file) {
						// Main identifies a file's split failed reply by its captured record bytes, even after a rename.
						notice.occurrence = `${createHash("sha256").update(JSON.stringify(entries[row])).digest("base64url")}:${page.items[row]?.seq ?? "unsaved"}`;
						return;
					}
					const generation = page.adjacent?.current?.split(".", 1)[0];
					notice.occurrence = generation ? `${generation}:${page.items[row]!.seq}` : randomUUID();
				},
			},
			{
				offset: offset ?? (forward ? 0 : undefined),
				forward,
				located(a, b, total) {
					from = a;
					end = b;
					count = total;
				},
			},
		);
		if (result.ok) {
			bindSavedTaskOrigins(result.value.messages, origins);
			const self = page.adjacent?.current;
			const previousPage = page.adjacent ? page.adjacent.older : page.nextCursor;
			const older = from > 0 && self ? `${self}~b${from}` : previousPage && `${previousPage}~b`;
			const newer = end < count && self ? `${self}~f${end}` : page.adjacent?.newer && `${page.adjacent.newer}~f`;
			const displayed = {
				ok: true as const,
				value: {
					messages: result.value.messages,
					...(page.adjacent ? { savedWindow: true as const } : {}),
					...(older ? { nextCursor: scope + older } : {}),
					...(newer ? { newerCursor: scope + newer } : {}),
				},
			};
			const fragments = taskTranscriptFragments(result);
			if (fragments) bindTaskTranscriptFragments(displayed, fragments);
			return displayed;
		}
		offset = undefined;
	}
	const last = taskTranscriptUnsavedAnswer(session);
	if (cursor === undefined && last?.type === "message")
		return { ok: true, value: { messages: [last.message], savedWindow: true } };
	return { ok: false, error: { message: "Transcript unavailable" } };
}

/** A record's ordinal identifies it within a file generation, not across a replacement of that file. */
function readArchivedPage(
	session: TaskTranscriptSource,
	taskId: string,
	cursor: string | undefined,
	read: ArchiveReader,
): Promise<PageResult> {
	return read((entries, storedRows, generation, identifyRow) => {
		const records: { row: number; notice: NoticePosition }[] = [];
		const page = transcriptView(session, taskId, entries, cursor, {
			storedRows,
			collect: (row, notice) => records.push({ row, notice }),
		});
		if (!records.length) return page;
		return generation().then((key) => {
			let missing = key === undefined;
			if (key !== undefined) {
				for (const { row, notice } of records) {
					const record = identifyRow ? identifyRow(key, row) : key;
					if (record === undefined) missing = true;
					else notice.occurrence = `${record}:${row}`;
				}
			}
			if (missing) {
				// Without a record identity keep both failures. An unsaved final answer still has its live identity.
				const notices = fragmentsByResult.get(page)!.notices.filter((notice) => notice.occurrence !== "");
				if (notices.length) bindTaskTranscriptFragments(page, { notices });
				else fragmentsByResult.delete(page);
			}
			return page;
		});
	}, loadArchiveSnapshot);
}

/** The page of a task's transcript ending before `cursor`, read from `entries`, its session's history. */
function transcriptView(
	session: TaskTranscriptSource,
	taskId: string,
	entries: ReturnType<TaskTranscriptSource["getEntries"]>,
	cursor: string | undefined,
	archive?: {
		storedRows: number;
		collect: (row: number, notice: NoticePosition) => void;
		origin?: (row: number, msg: AgentMessage, fragment: number) => void;
	},
	window?: Parameters<typeof taskTranscriptPageWithCuts>[5],
): TaskViewResult<TaskTranscriptView> {
	let fromEarlier: string | undefined;
	let intoLater: string | undefined;
	const page = taskTranscriptPageWithCuts(
		taskId,
		session.getSessionId(),
		entries,
		cursor,
		(first, last) => {
			fromEarlier = first;
			intoLater = last;
		},
		window,
	);
	if (!page.ok && !session.subscribe) return { ok: false, error: { message: "Transcript unavailable" } };
	const items = page.ok ? page.value.items : [];
	const entryIds = new Set(items.map((item) => item.source.entryId));
	const itemIds = new Set(items.map((item) => item.id));
	let notices: NoticePosition[] | undefined;
	let repeats: Map<string, number> | undefined;
	let nextMessageIndex = 0;
	const messages = entries.flatMap<AgentMessage>((entry, row) => {
		const id = entry.id;
		if (!entryIds.has(id)) return [];
		// A live row keeps where its message was saved: the saved page that shows it again keeps its stateful renderer.
		const seq = archive ? undefined : session.getEntrySeq?.(id);
		const shown = projectEntry(entry, row);
		if (seq !== undefined) for (const message of shown) noteSavedSeq(message, seq);
		return shown;
	});
	function projectEntry(entry: (typeof entries)[number], row: number): AgentMessage[] {
		const id = entry.id;
		if (entry.type !== "message") {
			const projected = sessionEntryToContextMessages(entry);
			nextMessageIndex += projected.length;
			if (archive?.origin) for (const m of projected) archive.origin(row, m, 0);
			return projected;
		}
		const index = nextMessageIndex++;
		const message = entry.message;
		if (message.role !== "assistant") {
			archive?.origin?.(row, message, 0);
			return [message];
		}
		const projected = { ...message };
		let fragment: number | undefined;
		let standalone = (fromEarlier === id || intoLater === id) && projected.stopReason === "error";
		projected.content = message.content.filter((block, blockIndex) => {
			if (!itemIds.has(`${id}:${blockIndex}`)) return false;
			fragment ??= blockIndex;
			if (standalone && !plainNoticeBlock(block)) standalone = false;
			return true;
		});
		if (standalone) {
			const notice: NoticePosition = {
				index,
				occurrence: "",
				cut: fromEarlier === id ? (intoLater === id ? "both" : "before") : "after",
			};
			if (archive && row < archive.storedRows) archive.collect(row, notice);
			else {
				const token = replyOccurrence(entry, message);
				const count = repeats?.get(token) ?? 0;
				repeats ??= new Map();
				repeats.set(token, count + 1);
				notice.occurrence = `${token}:${count}`;
			}
			notices ??= [];
			notices.push(notice);
		}
		archive?.origin?.(row, projected, fragment ?? 0);
		return [projected];
	}
	const compactionReason = cursor === undefined ? session.getCompactionReason?.() : undefined;
	const compactionStartedAt = compactionReason === undefined ? undefined : session.chatSession?.compactionStartedAt;
	const activeToolStarts =
		cursor === undefined && session.chatSession !== undefined ? activeToolExecutionStarts(session.chatSession) : [];
	let nextCursor = page.ok ? page.value.nextCursor : undefined;
	if (!nextCursor && !window && session.readHistory) {
		const before = session.getEarlierCursor?.();
		if (before) nextCursor = savedTaskScope(taskId, session.getSessionId()) + before + "~b";
	}
	const value: TaskTranscriptView = {
		messages,
		...(nextCursor !== undefined ? { nextCursor } : {}),
		...(compactionReason === undefined ? {} : { compactionReason }),
		...(compactionStartedAt === undefined ? {} : { compactionStartedAt }),
		...(activeToolStarts.length === 0 ? {} : { activeToolStarts }),
	};
	const result = { ok: true, value } as const;
	if (notices) bindTaskTranscriptFragments(result, { notices });
	return result;
}
