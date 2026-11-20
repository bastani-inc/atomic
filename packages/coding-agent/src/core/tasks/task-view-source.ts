import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { isProxy } from "node:util/types";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { CompactionReason } from "../agent-session.js";
import { sessionEntryToContextMessages } from "../session-manager-history.ts";
import type { SessionHeader } from "../session-manager-types.ts";
import type { PublishedChatActivity } from "../session-retry-status.js";
import type { SkillCatalogCommand } from "../skill-catalog.ts";
import {
	type ChatPosition,
	type ChatRecordOwner,
	chatPosition,
	type SessionChatRecords,
} from "../storage/session/chat-records.js";
import { chunkedToolResult, chunkedToolResultEntry } from "../storage/session/chunked-tool-result.js";
import { historyPageGeneration, transcriptCursorWithin } from "../storage/session/history-pages.js";
import { activeToolExecutionStarts, type ToolExecutionStart } from "../tool-execution-timing.ts";
import { readTaskOutputTail } from "./command-output.js";
import type { OperationId, TaskId, TaskRecord } from "./contracts.js";
import { bindTaskClockSource } from "./live-elapsed.js";
import { TaskMessageError, TaskMessageTimeoutError } from "./message-error.js";
import { isTaskTurnInterrupted, type OwnerTaskStore, type TaskActivity } from "./owner-store.js";
import { scopedBackgroundTasks } from "./session-scope.js";
import {
	loadTaskOwnTranscriptEntries,
	type QueuedTaskMessages,
	type TaskMessageDelivery,
	type TaskMessageLane,
	type TaskTranscriptSource,
	taskExtensionStatuses,
	taskOwnTranscriptEntries,
	taskTranscriptSource,
	watchTaskExtensionStatuses,
} from "./supervisor.js";
import { loadArchiveSnapshot } from "./task-archive-snapshot.ts";
import {
	bindTaskChatPage,
	type CaptureTaskChatFile,
	captureTaskChatFile,
	chatPageRequest,
	taskChatPage,
} from "./task-chat-records.js";
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
	captureFile?: CaptureTaskChatFile,
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
 * the tasks of a session that runs in another process. It
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
	 * Gives `text`, as typed into an agent task's chat, to the task's own session, as the main chat gives typed text
	 * to its session. While the task's turn runs the message waits in the session's queue on `lane` (default
	 * `"steer"`), delivered at the same boundaries as in the main chat; a task whose turn was interrupted, or a
	 * finished subagent that can be resumed, takes it as its next message. The model receives the raw text. Resolves
	 * once the session accepted the message; rejects with a {@link TaskMessageError}, whose text the chat gives back to
	 * its editor. Absent where tasks cannot be messaged.
	 */
	sendTaskMessage?(id: TaskId, text: string, lane?: TaskMessageLane): Promise<void>;
	/**
	 * Takes back every message waiting in an agent task's queue, in order, so its chat can restore them to the editor
	 * (Alt+Up, Esc). Nothing taken back is delivered. Absent where a view cannot reach a task's queue.
	 */
	clearTaskQueue?(id: TaskId): Promise<TaskViewResult<QueuedTaskMessages>>;
	/**
	 * Interrupts an agent task's current turn, as Esc does in its chat. The task keeps running and waits for its next
	 * message. Absent where a view cannot interrupt a task's turn.
	 */
	interruptTask?(id: TaskId): Promise<TaskViewResult<undefined>>;
	/**
	 * Pauses an agent task, as Esc does in its chat: the messages typed into the chat that are still queued come back,
	 * in order, for its editor, then its turn ends as {@link interruptTask} ends it. The task stays running, paused,
	 * and its next message continues it. Absent where a view cannot pause a task.
	 */
	pauseTask?(id: TaskId): Promise<TaskViewResult<QueuedTaskMessages>>;
	/**
	 * Continues an agent task {@link pauseTask} paused, as the user's send does in its chat: its queue is released, so
	 * the message sent next starts its turn. A no-op on a task that is not paused.
	 */
	resumeTask?(id: TaskId): Promise<TaskViewResult<undefined>>;
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
/** A page a chat shows: the native projection also says where its displayed records came from. The source's own
 * transcript API keeps its synchronous/rejection behavior and its data. */
export function readTaskPageForChat(
	view: object,
	source: TaskViewSource,
	id: TaskId,
	cursor: string | undefined,
	signal: AbortSignal,
) {
	return chatPageRequest.run({ view: new WeakRef(view) }, () => readTaskPageForView(source, id, cursor, signal));
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
	const clearTaskQueue = root.clearTaskQueue;
	const taskCommands = root.taskCommands;
	const interruptTask = root.interruptTask;
	const pauseTask = root.pauseTask;
	const resumeTask = root.resumeTask;
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
			: {
					sendTaskMessage: (id: TaskId, text: string, lane?: TaskMessageLane) =>
						lane === undefined
							? sendTaskMessage.call(root, id, text)
							: sendTaskMessage.call(root, id, text, lane),
				}),
		...(clearTaskQueue === undefined ? {} : { clearTaskQueue: (id: TaskId) => clearTaskQueue.call(root, id) }),
		...(taskCommands === undefined ? {} : { taskCommands: (id: TaskId) => taskCommands.call(root, id) }),
		...(interruptTask === undefined ? {} : { interruptTask: (id: TaskId) => interruptTask.call(root, id) }),
		...(pauseTask === undefined ? {} : { pauseTask: (id: TaskId) => pauseTask.call(root, id) }),
		...(resumeTask === undefined ? {} : { resumeTask: (id: TaskId) => resumeTask.call(root, id) }),
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
				return import("./task-file-history.js").then(({ taskFilePages, taskFileUnavailable }) =>
					savedTranscriptView(
						session,
						taskId,
						(opts) =>
							taskFilePages(file.path, file.sessionId, {
								...(opts ?? {}),
								...(chatPageRequest.getStore() ? { identify: true } : {}),
							}),
						cursor,
						file,
						signal,
					).catch(async (error): Promise<TaskViewResult<TaskTranscriptView>> => {
						// As a whole read of the file says: a history that is gone is a result, not a failed read.
						if (signal?.aborted) throw error;
						return { ok: false, error: { message: await taskFileUnavailable(file.path, error) } };
					}),
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
		async pauseTask(id) {
			const task = lease(id);
			if (!task.ok) return { ok: false, error: { message: task.error.message } };
			const bound = taskTranscriptSource(task.value);
			if (!bound.ok) return { ok: false, error: { message: "This task cannot be paused from here." } };
			const session = bound.value.session;
			// A session that cannot take its queue back is paused as an interrupt ends its turn; its queue stays.
			const pause =
				session.pauseTurn?.bind(session) ??
				(session.interruptTurn === undefined
					? undefined
					: async () => {
							await session.interruptTurn?.();
							return { steering: [], followUp: [] };
						});
			if (pause === undefined) return { ok: false, error: { message: "This task cannot be paused from here." } };
			try {
				const taken = await pause();
				if (session.isRunning?.() !== true) {
					store.setTurnInterrupted(id, true);
					// It is paused until its next turn starts, whether or not its chat is open to see that turn.
					const unsubscribe = session.subscribe?.((event) => {
						if (event.type !== "agent_start") return;
						unsubscribe?.();
						store.setTurnInterrupted(id, false);
					});
				}
				return { ok: true, value: taken };
			} catch (error) {
				return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
			}
		},
		async resumeTask(id) {
			const task = lease(id);
			if (!task.ok) return { ok: false, error: { message: task.error.message } };
			const bound = taskTranscriptSource(task.value);
			try {
				if (bound.ok) await bound.value.session.resumeTurn?.();
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
		async sendTaskMessage(id, text, lane = "steer") {
			// The message goes to the subagent's own session: queued on its lane while the subagent runs, and the first
			// message of its next turn once it has finished and resumes, as `subagent resume` continues it. The two can
			// trade places while the message is on its way: a running subagent can end before it takes the message, and
			// a wake can resume a finished one first. The message then goes the other way, once.
			for (let attempt = 0; ; attempt++) {
				const mayRetry = attempt === 0;
				const record = store.tasks.find((candidate) => candidate.ref.taskId === id);
				const resumer = taskResumer(store.supervisor);
				if (record?.kind === "agent" && record.execution.kind === "settled" && resumer !== undefined) {
					const reason = resumer.readOnlyReason(id);
					if (reason !== undefined) throw new TaskMessageError("delivery-refused", { taskId: id, detail: reason });
					const resumed = await resumer.resume(id, text);
					if (resumed.ok) return;
					// Resumed meanwhile: it runs again, and the message joins it.
					store.drain();
					if (mayRetry && agentTaskRunning(store, id)) continue;
					throw new TaskMessageError("delivery-refused", { taskId: id, detail: resumed.reason });
				}
				const task = lease(id);
				if (!task.ok) throw new TaskMessageError("task-unavailable", { taskId: id });
				const bound = taskTranscriptSource(task.value);
				const session = bound.ok ? bound.value.session : undefined;
				// Never an Intercom message: its model would receive the text wrapped as another agent's.
				if (session?.queueMessage === undefined) throw new TaskMessageError("messages-unsupported", { taskId: id });
				const target = session.completionSource?.intercomTarget;
				const named = { taskId: id, ...(target === undefined ? {} : { target }) };
				let delivery: TaskMessageDelivery;
				try {
					delivery = await session.queueMessage(text, lane);
				} catch (cause) {
					throw new TaskMessageError("delivery-unconfirmed", named, { cause });
				}
				// A paused subagent shows as running again when its next turn starts, not when it took a message: one it
				// takes without the reader continuing it waits until they do.
				if (delivery.delivered) return;
				if (delivery.reason === "ended" && mayRetry && resumer !== undefined && (await agentTaskSettles(store, id)))
					continue;
				if (delivery.reason === "unconfirmed")
					throw new TaskMessageTimeoutError({
						...named,
						target: target ?? id,
						timeoutMs: delivery.timeoutMs,
						elapsedMs: delivery.elapsedMs,
					});
				throw new TaskMessageError(delivery.reason === "lost" ? "delivery-unconfirmed" : "delivery-refused", {
					...named,
					...(delivery.detail === undefined ? {} : { detail: delivery.detail }),
				});
			}
		},
		async clearTaskQueue(id) {
			const task = lease(id);
			if (!task.ok) return { ok: false, error: { message: task.error.message } };
			const bound = taskTranscriptSource(task.value);
			const clear = bound.ok ? bound.value.session.clearQueue : undefined;
			// A session that keeps no queue, as a finished task's, has nothing queued.
			if (!bound.ok || clear === undefined) return { ok: true, value: { steering: [], followUp: [] } };
			try {
				return { ok: true, value: await clear.call(bound.value.session) };
			} catch (error) {
				return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
			}
		},
	};
	cancellablePages.add(source.readTaskTranscript);
	cancellableDetails.add(source.taskDetailText);
	sources.set(store, source);
	bindTaskClockSource(source, store);
	return source;
}

/** How long a message that a subagent refused as its execution ended waits for its task to finish, to resume it. */
const ENDED_TASK_SETTLE_WAIT_MS = 10_000;

function agentTaskRunning(store: OwnerTaskStore, id: TaskId): boolean {
	const record = store.tasks.find((candidate) => candidate.ref.taskId === id);
	return record?.kind === "agent" && record.execution.kind === "running";
}

/** Whether the agent task finishes within {@link ENDED_TASK_SETTLE_WAIT_MS}, once its execution has ended. */
function agentTaskSettles(store: OwnerTaskStore, id: TaskId): Promise<boolean> {
	const settled = () => {
		const record = store.tasks.find((candidate) => candidate.ref.taskId === id);
		return record?.kind === "agent" && record.execution.kind === "settled";
	};
	store.drain();
	if (settled()) return Promise.resolve(true);
	return new Promise((resolve) => {
		const finish = (value: boolean) => {
			clearTimeout(timer);
			unsubscribe();
			resolve(value);
		};
		const unsubscribe = store.subscribe(() => {
			if (settled()) finish(true);
		});
		const timer = setTimeout(() => finish(false), ENDED_TASK_SETTLE_WAIT_MS);
		timer.unref?.();
	});
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

const BOUNDARY_MARKS = /!([c1])$/;

/**
 * The cursor that reads only the one saved entry next to a shown page, toward `cursor`'s page: a view that finishes a
 * tool card cut at a page's edge reads that entry, not the page. With `calls`, a reply keeps only its tool calls and
 * a result only its call's identity. A reader that cannot read one entry reads the page, as `cursor` does.
 */
export function savedBoundaryCursor(cursor: string, calls: boolean): string {
	return `${cursor}!${calls ? "c" : "1"}`;
}

/** What a boundary read keeps of a saved message: a reply's calls and outcome, a result, and only the role of the rest. */
function boundaryMessage(message: AgentMessage, calls: boolean): AgentMessage | undefined {
	switch (message.role) {
		case "assistant":
			return { ...message, content: calls ? message.content.filter((block) => block.type === "toolCall") : [] };
		case "toolResult":
			return calls ? { ...message, content: [] } : message;
		case "user":
			return { ...message, content: [] };
		default:
			return undefined;
	}
}

/** Where to read the original bytes of a saved row too large to show. */
function oversizedNote(item: { readonly seq: number; readonly bytes: number }, file: FileArchive | undefined): string {
	return `${file ? `Saved file entry at byte ${item.seq}` : `Saved entry ${item.seq}`} is ${item.bytes} bytes. Read the original bytes with the session history reader or export this session.`;
}

/**
 * The tool result a saved row too large to show holds, read field by field from its stored text: its call's card
 * then shows finished or failed, as a whole read shows it, and the note says where its body is. Undefined for any
 * other row, or when its bytes cannot be read here.
 */
async function oversizedToolResult(
	session: TaskTranscriptSource,
	item: import("../storage/session/types.js").OversizedSessionEntry | FileTaskPage["items"][number],
	file: FileArchive | undefined,
	current: string | undefined,
	signal: AbortSignal | undefined,
): Promise<Entries[number] | undefined> {
	if ("entry" in item) return undefined;
	let chunks: AsyncIterable<Uint8Array>;
	if (file) {
		if (current === undefined) return undefined;
		const { taskFileEntryChunks } = await import("./task-file-history.js");
		chunks = taskFileEntryChunks(file.path, file.sessionId, current, item.seq, item.bytes, signal);
	} else if ("kind" in item && session.readHistoryChunks)
		chunks = session.readHistoryChunks(item, signal ? { signal } : {});
	else return undefined;
	try {
		const result = await chunkedToolResult(chunks);
		return result && chunkedToolResultEntry(result, `oversized-${item.seq}`, oversizedNote(item, file));
	} catch {
		signal?.throwIfAborted();
		return undefined;
	}
}

async function savedBoundaryView(
	session: TaskTranscriptSource,
	read: (
		options: Parameters<NonNullable<TaskTranscriptSource["readHistory"]>>[0],
	) => AsyncIterable<import("../storage/session/types.js").SessionHistoryPage | FileTaskPage>,
	raw: string,
	scope: string,
	calls: boolean,
	file: FileArchive | undefined,
	signal: AbortSignal | undefined,
): Promise<TaskViewResult<TaskTranscriptView>> {
	for await (const page of read({ cursor: raw, adjacent: true, limit: 1, ...(signal ? { signal } : {}) })) {
		signal?.throwIfAborted();
		const messages: AgentMessage[] = [];
		const origins = new Map<AgentMessage, string>();
		for (const item of page.items) {
			const entry =
				"entry" in item
					? item.entry
					: await oversizedToolResult(session, item, file, page.adjacent?.current, signal);
			if (entry?.type !== "message") continue;
			const message = boundaryMessage(entry.message, calls);
			if (message === undefined) continue;
			messages.push(message);
			const record = file
				? createHash("sha256").update(JSON.stringify(entry)).digest("base64url")
				: page.adjacent?.current?.split(".", 1)[0];
			if (record) origins.set(message, `${scope}${record}:${item.seq}:0`);
		}
		bindSavedTaskOrigins(messages, origins);
		const older = page.adjacent?.older;
		const newer = page.adjacent?.newer;
		return {
			ok: true,
			value: {
				messages,
				savedWindow: true,
				...(older ? { nextCursor: `${scope}${older}~b` } : {}),
				...(newer ? { newerCursor: `${scope}${newer}~f` } : {}),
			},
		};
	}
	return { ok: true, value: { messages: [], savedWindow: true } };
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
	const marked = cursor?.slice(scope.length);
	const boundary = marked === undefined ? undefined : BOUNDARY_MARKS.exec(marked)?.[1];
	const encoded = boundary === undefined ? marked : marked!.slice(0, -2);
	// Also page within a single saved entry: a reply can contain hundreds of independently shown blocks.
	const slice = encoded === undefined ? undefined : /^(.*)~([fb])(\d*)$/.exec(encoded);
	const raw = slice ? slice[1] : encoded;
	const forward = Boolean(slice && slice[2] === "f");
	let offset = slice?.[3] ? Number(slice[3]) : undefined;
	if (offset !== undefined && !Number.isSafeInteger(offset))
		return { ok: false, error: { message: "Invalid transcript cursor" } };
	// A cut inside one saved reply continues in the same saved entry: that is read as a page, as before.
	if (boundary !== undefined && raw !== undefined && offset === undefined)
		return savedBoundaryView(session, read, raw, scope, boundary === "c", file, signal);
	const display = chatPageRequest.getStore();
	// A chat shows the saved lines of the generation it reads: the live session's, the store page's, or the file's.
	const liveScope = display && session.chatSession?.sessionManager?.chatRecordScope?.();
	const captureFile = display && !liveScope && file ? await captureTaskChatFile(file.path, file.sessionId) : undefined;
	for await (const page of read({
		...(raw === undefined ? { direction: "backward" as const } : { cursor: raw }),
		adjacent: true,
		...(signal ? { signal } : {}),
	})) {
		signal?.throwIfAborted();
		if (display) display.scope = liveScope ?? pageChatScope(page, captureFile);
		const settled = new Map<number, Entries[number]>();
		for (const item of page.items) {
			if ("entry" in item) continue;
			const result = await oversizedToolResult(session, item, file, page.adjacent?.current, signal);
			if (result) settled.set(item.seq, result);
		}
		const entries: Entries = page.items.map((item) =>
			"entry" in item
				? item.entry
				: (settled.get(item.seq) ?? {
						type: "message",
						id: `oversized-${item.seq}`,
						parentId: null,
						timestamp: "1970-01-01T00:00:00Z",
						message: {
							role: "custom",
							customType: "atomic.oversized-history-entry",
							display: true,
							timestamp: 0,
							content: oversizedNote(item, file),
						},
					}),
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
				startsHistory: !(page.adjacent ? page.adjacent.older : page.nextCursor),
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
			const chatPage = taskChatPage(result);
			if (chatPage) bindTaskChatPage(displayed, chatPage);
			return displayed;
		}
		offset = undefined;
	}
	const last = taskTranscriptUnsavedAnswer(session);
	if (cursor === undefined && last?.type === "message")
		return { ok: true, value: { messages: [last.message], savedWindow: true } };
	return { ok: false, error: { message: "Transcript unavailable" } };
}

type TaskChatScope = { store: SessionChatRecords; owner: ChatRecordOwner };
/** The reader-only records of the stored generation a saved page was read from, if its store keeps any. */
function pageChatScope(
	page: object,
	captureFile: ((header: SessionHeader, stats: BigIntStats) => void) | undefined,
): TaskChatScope | undefined {
	if ("file" in page) {
		const identity = (page as FileTaskPage).identity;
		const display = chatPageRequest.getStore();
		if (!identity || !captureFile || !display) return undefined;
		display.scope = undefined;
		captureFile(identity.header, identity.stats);
		return display.scope;
	}
	const generation = historyPageGeneration(page);
	if (!generation) return undefined;
	try {
		const store = generation.records();
		return store ? { store, owner: { id: generation.sessionId, epoch: generation.epoch } } : undefined;
	} catch {
		return undefined;
	}
}

/** A record's ordinal identifies it within a file generation, not across a replacement of that file. */
function readArchivedPage(
	session: TaskTranscriptSource,
	taskId: string,
	cursor: string | undefined,
	read: ArchiveReader,
): Promise<PageResult> {
	return read(
		(entries, storedRows, generation, identifyRow) => {
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
		},
		loadArchiveSnapshot,
		chatPageRequest.getStore() ? captureTaskChatFile : undefined,
	);
}

/** A raw item cursor names an occurrence in the window from which it was issued. A receipt-less custom source
 * retaining its live transcript for an unplaced widget must keep that original window available to the cursor:
 * looking it up in a later, compacted window would skip rows or repeat the new tail. Construct only on this legacy path. */
export function retainTaskWindowReader(session: TaskTranscriptSource, taskId: TaskId): (cursor: string) => PageResult {
	const entries = session.getEntries().slice(),
		id = session.getSessionId(),
		before = session.getEarlierCursor?.();
	const cut: TaskTranscriptSource = {
		getSessionId: () => id,
		getEntries: () => entries,
		getEarlierCursor: () => before,
		readHistory: session.readHistory,
	};
	return (cursor) => transcriptView(cut, taskId, entries, cursor);
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
		/** A saved page with no page before it: it shows the start of the conversation. */
		startsHistory?: boolean;
	},
	window?: Parameters<typeof taskTranscriptPageWithCuts>[5],
): TaskViewResult<TaskTranscriptView> {
	let fromEarlier: string | undefined;
	let intoLater: string | undefined;
	let slice: { readonly start: number; readonly end: number; readonly total: number } | undefined;
	const page = taskTranscriptPageWithCuts(
		taskId,
		session.getSessionId(),
		entries,
		cursor,
		(first, last) => {
			fromEarlier = first;
			intoLater = last;
		},
		window && {
			...window,
			located(start, end, total) {
				slice = { start, end, total };
				window.located(start, end, total);
			},
		},
	);
	if (!page.ok && !session.subscribe) return { ok: false, error: { message: "Transcript unavailable" } };
	const items = page.ok ? page.value.items : [];
	const entryIds = new Set(items.map((item) => item.source.entryId));
	const itemIds = new Set(items.map((item) => item.id));
	let notices: NoticePosition[] | undefined;
	let repeats: Map<string, number> | undefined;
	const displayRequest = chatPageRequest.getStore();
	const scope =
		displayRequest &&
		(displayRequest.scope ?? (!archive ? session.chatSession?.sessionManager?.chatRecordScope?.() : undefined));
	// Saved history before a live window is read in pages of its own: the window owns rows from its start, and only
	// the page that starts the conversation also owns what was shown before any entry.
	const earlier = !window && session.readHistory ? session.getEarlierCursor?.() : undefined;
	const first = window ? !slice || slice.start === 0 : page.ok && !page.value.nextCursor;
	const owned =
		scope && page.ok
			? ownedRows(
					taskId,
					session.getSessionId(),
					entries,
					entryIds,
					window ? slice !== undefined && slice.end < slice.total : cursor !== undefined,
					intoLater,
					first && (window ? archive?.startsHistory === true : earlier === undefined),
					first,
				)
			: undefined;
	const screen = scope &&
		owned && {
			scope,
			// The first page also owns the start of the conversation, which holds what was shown before any entry.
			positions: new Map<string, number>(owned.root ? [["", -1]] : []),
			entries: owned.prefix,
			prefix: owned.prefix.length,
		};
	let nextMessageIndex = 0;
	const messages = entries.flatMap<AgentMessage>((entry, row) => {
		const id = entry.id;
		const shown = entryIds.has(id);
		const context = shown && entry.type !== "message" ? sessionEntryToContextMessages(entry) : undefined;
		if (screen && owned.owns(entry, row) && (!archive || row < archive.storedRows) && id !== intoLater) {
			screen.entries.push(chatPosition(entry));
			// Its lines follow the last row it draws; a row the page never draws keeps the place before it.
			screen.positions.set(id, nextMessageIndex - 1 + (shown ? (context?.length ?? 1) : 0));
		}
		if (!shown) return [];
		// A live row keeps where its message was saved: the saved page that shows it again keeps its stateful renderer.
		const seq = archive ? undefined : session.getEntrySeq?.(id);
		const projected = projectEntry(entry, row, context);
		if (seq !== undefined) for (const message of projected) noteSavedSeq(message, seq);
		return projected;
	});
	function projectEntry(
		entry: (typeof entries)[number],
		row: number,
		context: AgentMessage[] | undefined,
	): AgentMessage[] {
		const id = entry.id;
		if (entry.type !== "message") {
			const projected = context ?? [];
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
	if (!nextCursor && earlier) nextCursor = savedTaskScope(taskId, session.getSessionId()) + earlier + "~b";
	const value: TaskTranscriptView = {
		messages,
		...(nextCursor !== undefined ? { nextCursor } : {}),
		...(compactionReason === undefined ? {} : { compactionReason }),
		...(compactionStartedAt === undefined ? {} : { compactionStartedAt }),
		...(activeToolStarts.length === 0 ? {} : { activeToolStarts }),
	};
	const result = { ok: true, value } as const;
	if (notices) bindTaskTranscriptFragments(result, { notices });
	if (screen) bindTaskChatPage(result, screen);
	return result;
}

/**
 * The source rows whose display-only records a task page draws: the rows it shows, except the start of a reply that
 * ends on the later page, and each row no page shows after one of them (on the first page of `entries`, also before
 * them all; `continues`: a later page of `entries` follows this one).
 * A notice run that leads onto the page from an earlier one is kept as row-less positions, so an order edge saved at
 * its first notice can be checked against the stored rows before that page is read.
 */
function ownedRows(
	taskId: string,
	sessionId: string,
	entries: Entries,
	entryIds: ReadonlySet<string>,
	continues: boolean,
	intoLater: string | undefined,
	root: boolean,
	fromStart = root,
): { root: boolean; prefix: ChatPosition[]; owns: (entry: Entries[number], row: number) => boolean } | undefined {
	const first = entries.findIndex((entry) => entryIds.has(entry.id));
	if (first < 0) return undefined;
	const drawn = (entry: Entries[number]) => taskTranscriptPageWithCuts(taskId, sessionId, [entry], undefined).ok;
	const from = fromStart ? 0 : first;
	let to = entries.length;
	if (intoLater !== undefined) {
		for (let row = first; row < entries.length; row++)
			if (entries[row]!.id === intoLater) {
				to = row;
				break;
			}
	} else if (continues) {
		let row = entries.length - 1;
		while (row > first && !entryIds.has(entries[row]!.id)) row--;
		for (row++; row < entries.length; row++)
			if (drawn(entries[row]!)) {
				to = row;
				break;
			}
	}
	const prefix: ChatPosition[] = [];
	const start = chatPosition(entries[from]!);
	if (!root && start.role !== "other") {
		let parentId = start.parentId;
		for (let row = from - 1; row >= 0; row--) {
			const position = chatPosition(entries[row]!);
			if (position.role !== "notice" || position.id !== parentId) break;
			prefix.push(position);
			parentId = position.parentId;
		}
		prefix.reverse();
	}
	return {
		root,
		prefix,
		owns: (entry, row) => row >= from && row < to && (entryIds.has(entry.id) || !drawn(entry)),
	};
}
