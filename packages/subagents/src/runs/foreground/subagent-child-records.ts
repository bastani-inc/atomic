import {
	currentWorktreeRootMappings,
	type DetachedToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	sliceHead,
	type TaskElapsedSpan,
	type WorktreeRootMapping,
} from "@bastani/atomic";
import type { AgentSource } from "../../agents/agent-types.js";
import type { MaxOutputConfig, OutputMode, RunSyncOptions } from "../../shared/types.js";
import { launchRequestedModel } from "../shared/model-fallback.js";
import {
	isReleasedChildError,
	ReleasedChildError,
	type ReleasedChildErrorCode,
	releasedChildErrorSubject,
} from "./released-child-errors.js";
import { type SubagentChildWorktree, visibleWorktreeRecord } from "./run-worktrees.js";
import {
	findAppendedSubagentChildRecord,
	isSubagentChildRecord,
	isUnsavedSubagentChildRecord,
	loadSubagentChildRecord,
	observeSubagentChildRecord,
	pendingSubagentChildWrites,
	registerSubagentChildRecordReader,
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_RELEASED_STATUS,
	settleSubagentChildRecord,
	subagentChildRecordNeedsRead,
	subagentChildRecordOf,
	subagentChildRecordsMerging,
	unsavedSubagentChildRecordsOf,
} from "./subagent-child-card-state.js";

import { subagentChildOwnerWriter } from "./subagent-child-owner.js";

export { isSubagentChildRecord, SUBAGENT_CHILD_RECORD_TYPE, SUBAGENT_CHILD_RELEASED_STATUS };

export interface SubagentChildOwner {
	readonly kind: "session";
	readonly sessionId: string;
}

/**
 * What a stopped child had queued and not read, as a record keeps it. Resume delivers each message as written, except
 * that a first message flagged `taskExpands` is the child's original task it never read, prompted as a fresh launch
 * prompts it (prompt templates expanded, commands run). Records written before Atomic recorded the flag have none;
 * their first held message keeps the handling it had then (see {@link heldTaskExpands}).
 */
export interface SubagentChildHeldMessages {
	readonly taskId: string;
	readonly messages: readonly string[];
	readonly taskExpands?: boolean;
}

/** The held messages a finished child attempt reports, in the form `recordChild` takes them. */
export interface SubagentChildPendingMessages {
	readonly messages: readonly string[];
	readonly taskExpands: boolean;
}

/**
 * Whether a record's first held message is the child's original task it never read. A record written before Atomic
 * recorded `taskExpands` keeps the handling resume gave its first held message then: prompted as a task.
 */
export function heldTaskExpands(held: SubagentChildHeldMessages): boolean {
	return held.taskExpands ?? true;
}

/** A child result's unread messages, if it has any. */
export function pendingMessagesOfResult(result: {
	readonly pendingMessages?: readonly string[];
	readonly pendingTaskExpands?: boolean;
}): SubagentChildPendingMessages | undefined {
	if (!result.pendingMessages?.length) return undefined;
	return { messages: result.pendingMessages, taskExpands: result.pendingTaskExpands === true };
}

/** A detached tool call a released child waits on. */
export interface SubagentChildWaitingCall {
	readonly toolCallId: string;
	readonly toolName: string;
	/** Broker-routed reply wait, recorded after the question was delivered. */
	readonly replyWait?: {
		readonly questionId: string;
		readonly deadline: number;
		readonly from: string;
		readonly retryCount?: number;
	};
}

/**
 * A detached call a wake answered "still running" (#5014): its result still comes from the owner process that answered
 * it, so a record from another generation means the call died with that process.
 */
export interface SubagentChildStillRunningCall {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly ownerGeneration: string;
}

/**
 * The latest record for a child id is authoritative. Session recovery restores `running` children;
 * explicit `resume` can also reopen a settled child unless its `terminalStatus` is `killed` or `gone`.
 */
export interface SubagentChildRecord {
	readonly version: 1;
	readonly childId: string;
	readonly runId: string;
	readonly index: number;
	readonly agent: string;
	/**
	 * Where the agent definition the launch resolved came from. The same name can be defined by more than one source,
	 * and its definition sets the child's system prompt, skills and inherited project context. Records written before
	 * Atomic recorded it have none, and restore looks the agent up in the default scope.
	 */
	readonly agentSource?: AgentSource;
	/** Whether the child was launched with `context: "fork"`, which shapes its Intercom bridge; absent means fresh. */
	readonly forked?: boolean;
	readonly state: "running" | "terminal";
	/** Time of this execution at the record, retained for launch cards after the task host is gone. */
	readonly elapsedMs?: number;
	/** The span of this launch; null while queued, superseding any earlier launch of the same child. */
	readonly elapsedSpan?: TaskElapsedSpan | null;
	readonly cwd: string;
	readonly owner: SubagentChildOwner;
	readonly taskId?: string;
	/** Id of the child's own session; with no `childSessionFile` it is reopened by id from the owner's session store. */
	readonly childSessionId?: string;
	/** Present only for file-backed (JSONL) child sessions; database-backed sessions have no session file. */
	readonly childSessionFile?: string;
	/** The model (`provider/id`) and thinking level the child actually started on, once its session was created. */
	readonly launchModel?: string;
	readonly launchThinkingLevel?: string;
	/**
	 * The leaf entry of the child's own session when its launch model and thinking level were recorded (`null`
	 * for an empty session). Model and thinking changes the child's session records after it are the child's own.
	 */
	readonly launchLeafId?: string | null;
	readonly launchLeafSeq?: number;
	/**
	 * What the launch asked the child to do, as one short line (see {@link summarizeSubagentTask}), so a child that
	 * cannot be restored is still told apart and can be relaunched (#4660). Absent for a resumed child, whose message
	 * is not its task, and in records written before Atomic recorded it.
	 */
	readonly task?: string;
	readonly intercomTarget?: string;
	readonly intercomGroup?: string;
	readonly orchestratorTarget?: string;
	/** The `worktree: true` worktree the child runs in, so resume can recreate it from the run's base. */
	readonly worktree?: SubagentChildWorktree;
	readonly terminalStatus?: string;
	/**
	 * The user paused the running child from its chat (Esc) and its next turn has not started: session recovery restores
	 * it paused, prompted with nothing, until the user continues it. Written `false` once it no longer is; absent in
	 * records of a child never paused and in records written before Atomic recorded it, which restore as before.
	 */
	readonly pausedByUser?: boolean;
	/**
	 * The leaf entry of the child's own session when the user paused it (`null` for an empty session). The pause holds
	 * only while no user message reached that session since: records merge field by field, so a version that does not
	 * record pauses leaves `pausedByUser` as it was when it continues the child. Absent in records without
	 * `pausedByUser`, and in records written before Atomic recorded the entry, whose pause holds as it did then.
	 */
	readonly pausedAtLeafId?: string | null;
	/**
	 * Steering and follow-up messages the child had queued but not read when pause or quit stopped
	 * task `taskId`, in order. Resume delivers them once, before its own message; a later task's record supersedes them.
	 */
	readonly heldMessages?: SubagentChildHeldMessages;
	/** How a child admitted while it waited for a slot in its run was launched, so it can start fresh after a restart. */
	readonly launch?: SubagentChildLaunch;
	/**
	 * What the child inherited from its owner when it was admitted. Restore and resume use it, never the reopened
	 * owner's current model and thinking level, and with it `intercomGroup` is exactly the launch's: absent means none.
	 * Records written before Atomic recorded it have none, and take those from the owner as it is now.
	 */
	readonly inherited?: SubagentChildInheritance;
	/**
	 * The model the launch named, in its call or its agent: the child runs only it and its agent's own fallbackModels.
	 * Absent for a launch on its parent's model or an auto-routed one, and in records written before Atomic recorded
	 * it, which restore with the parent's model and the settings chain as fallbacks (#4188).
	 */
	readonly namedModel?: string;
	/** The model the launch asked for, reported beside the one the child ran on; see `launchRequestedModel` (#4188). */
	readonly requestedModel?: string;
	/**
	 * The concurrency limit of the run that dispatched the child, as plain data: a woken or resumed child waits for a slot
	 * under it when no sibling in this process still holds the run's scheduler (#4856). Absent for a launch outside a run
	 * scheduler.
	 */
	readonly runConcurrency?: number;
	/**
	 * The task heartbeat cadence the launch chose, which every wake, resume and restore launches with again; `0` disables.
	 * Absent when the launch used the owner default (#4856).
	 */
	readonly heartbeatMs?: number;
	/**
	 * The detached tool calls a released child is waiting on (#4326): its run ended with them still running, and their
	 * results wake it. Empty once nothing is outstanding.
	 */
	readonly waitingOn?: readonly SubagentChildWaitingCall[];
	/**
	 * The calls its wakes answered "still running" whose results have not reached it yet (#5014). Kept across its later
	 * runs and releases until a wake delivers the result, or until another owner generation reports the call interrupted.
	 */
	readonly stillRunning?: readonly SubagentChildStillRunningCall[];
	/**
	 * The Intercom session id a released child was registered under. The broker reserves it with the child's name, so a
	 * reply or a send addressed to that id still reaches the hold that wakes the child (#4326).
	 */
	readonly releasedIntercomId?: string;
	/**
	 * Results of its detached calls that arrived while the child could not take them (paused, quit, or live in another
	 * attempt), in arrival order. The next wake or resume delivers them once; empty after that.
	 */
	readonly heldToolResults?: readonly DetachedToolResult[];
	readonly ownerGeneration?: string;
	readonly wakeFailure?: SubagentChildWakeFailure;
	/**
	 * The restores of the session or run the child was launched in, which the child follows for every path its tools
	 * resolve, also when it is woken outside that work. A wake adds those the owner recorded since, such as a worktree
	 * restored on another machine. Absent when the launch had none.
	 */
	readonly worktreeRootMappings?: readonly WorktreeRootMapping[];
}

export interface SubagentChildWakeFailure {
	readonly taskId?: string;
	readonly code: ReleasedChildErrorCode;
	readonly reason: string;
	readonly hint: string;
	readonly reported?: true;
}

export function currentWakeFailure(
	record: Pick<SubagentChildRecord, "taskId" | "wakeFailure">,
): SubagentChildWakeFailure | undefined {
	return record.wakeFailure?.taskId === record.taskId ? record.wakeFailure : undefined;
}

/**
 * The owner's model and thinking level when it admitted the child. A child whose agent and launch pin no model runs
 * on them, and every child falls back to that model.
 */
export interface SubagentChildInheritance {
	/** `provider/id`; absent when the owner had no model. */
	readonly model?: string;
	/** The provider bare model names resolve against. */
	readonly modelProvider?: string;
	readonly thinkingLevel?: string;
}

/**
 * The model a launch with these options named, the one it asked for and its own constraints, as a record keeps them
 * (#4188). A restored launch keeps those of its original launch, not the model it continues on.
 */
export function subagentChildModelChoice(
	options: RunSyncOptions,
	agent?: { readonly model?: string },
): Pick<SubagentChildRecord, "namedModel" | "requestedModel"> {
	const named = options.requestedModel ?? options.modelOverride ?? agent?.model;
	const namedModel = options.runsNamedModel === false || named === "auto" ? undefined : named;
	const requestedModel = launchRequestedModel(agent, options);
	return {
		...(namedModel ? { namedModel } : {}),
		...(requestedModel ? { requestedModel } : {}),
	};
}

export const TASK_SUMMARY_LIMIT = 300;

/** A task on one line, cut at {@link TASK_SUMMARY_LIMIT} characters. */
export function summarizeSubagentTask(task: string): string {
	const line = task.replace(/\s+/g, " ").trim();
	return line.length > TASK_SUMMARY_LIMIT ? `${sliceHead(line, TASK_SUMMARY_LIMIT - 1)}…` : line;
}

/** The task a record keeps for a launch with these options; a resumed child keeps none, since its message is not a task. */
export function subagentChildTask(task: string, options: RunSyncOptions): Pick<SubagentChildRecord, "task"> {
	return options.resumeSession === true || task.trim() === "" ? {} : { task: summarizeSubagentTask(task) };
}

/** What a launch with these options inherits from its owner; see {@link SubagentChildInheritance}. */
export function subagentChildInheritance(options: RunSyncOptions): SubagentChildInheritance {
	return {
		...(options.currentModel ? { model: options.currentModel } : {}),
		...(options.preferredModelProvider ? { modelProvider: options.preferredModelProvider } : {}),
		...(options.currentThinkingLevel ? { thinkingLevel: options.currentThinkingLevel } : {}),
	};
}

/**
 * What a child that has not started yet needs to start as a new launch after Atomic restarts, when nothing of its
 * launch is left in the process: only what its original launch already had, and never a credential or capability.
 * The agent, cwd, worktree, run identity, Intercom identity and held messages are the record's own fields.
 */
export interface SubagentChildLaunch {
	/** The prompt the child runs, with every instruction its launch added. */
	readonly task: string;
	/** The task as the caller gave it, which its task host shows. */
	readonly intentTask?: string;
	/**
	 * The session a `context: "fork"` launch branched from its owner's conversation before admission, which the child
	 * starts on: its id, in the owner's session store, and its file when that store keeps one.
	 */
	readonly forkSession?: { readonly id: string; readonly file?: string };
	readonly sessionDir?: string;
	readonly modelOverride?: string;
	readonly skills?: readonly string[];
	readonly outputPath?: string;
	readonly outputMode?: OutputMode;
	readonly maxOutput?: MaxOutputConfig;
	readonly share?: boolean;
}

/** The launch data of a child about to wait for a slot in its run; see {@link SubagentChildLaunch}. */
export function subagentChildLaunch(
	task: string,
	intentTask: string | undefined,
	options: RunSyncOptions,
): SubagentChildLaunch {
	const forkSession = options.resumeSession ? undefined : options.sessionManager;
	const forkSessionFile = forkSession?.getSessionFile();
	return {
		task,
		...(intentTask === undefined ? {} : { intentTask }),
		...(forkSession
			? {
					forkSession: {
						id: forkSession.getSessionId(),
						...(forkSessionFile ? { file: forkSessionFile } : {}),
					},
				}
			: {}),
		...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
		...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
		...(options.skills ? { skills: options.skills } : {}),
		...(options.outputPath ? { outputPath: options.outputPath } : {}),
		...(options.outputMode ? { outputMode: options.outputMode } : {}),
		...(options.maxOutput ? { maxOutput: options.maxOutput } : {}),
		...(options.share === undefined ? {} : { share: options.share }),
	};
}

export type SubagentChildRecordInput = Omit<SubagentChildRecord, "version" | "childId" | "owner">;

export interface SubagentChildRecordSink {
	/** The session that owns the children this sink records; their wake keys are under it (#4326). */
	readonly ownerSessionId?: string;
	record(input: SubagentChildRecordInput): void;
	/** Settles once every record this sink was given has been appended. */
	flushed?(): Promise<void>;
	/** Settles once the latest record this sink was given is appended: `false` when it could not be. */
	saved?(): Promise<boolean>;
	clearHeldToolResults?(childId: string, toolCallIds: readonly string[]): Promise<void>;
	/** Keep messages for a released or stopped child, for its next wake or resume; see {@link holdSubagentChildMessages}. */
	holdMessages?(childId: string, messages: readonly string[]): Promise<HeldMessagesOutcome>;
}

/** Session recovery restores children that had not settled. */
export function isRestorableSubagentChild(record: SubagentChildRecord): boolean {
	return record.state === "running";
}

/** `terminalStatus` of a child that could not be restored after a restart and was reported gone to its owner. */
export const SUBAGENT_CHILD_GONE_STATUS = "gone";

export function subagentChildId(runId: string, index: number): string {
	return `${runId}:${index}`;
}

export function subagentChildOwner(ctx: Pick<ExtensionContext, "sessionManager">): SubagentChildOwner {
	return { kind: "session", sessionId: ctx.sessionManager.getSessionId() };
}

// A replacement generation must neither overtake a pending save nor lose a stop requested by its predecessor.
function newRecordState() {
	return {
		appendChains: new Map<string, Promise<void>>(),
		stopRequests: new Map<string, SubagentChildStopStatus>(),
		pendingRecordFailures: new Map<string, ChildRecordFailureNotice>(),
	};
}
const RECORD_STATE = Symbol.for("@bastani/subagents/child-record-writes@1");
const processRecords = globalThis as { [RECORD_STATE]?: ReturnType<typeof newRecordState> };
processRecords[RECORD_STATE] ??= newRecordState();
const { appendChains, stopRequests, pendingRecordFailures } = processRecords[RECORD_STATE];

// An Error's stack or cause can reach the entire session that failed to append. Keep the facts, not those frames.
let lastFailure: (Pick<ReleasedChildError, "code" | "fields"> & ErrorOptions) | undefined;

/** Failed appends of child records, counted so a record that could not be saved is not lost silently. */
export const subagentChildRecordFailures = {
	count: 0,
	get last(): ReleasedChildError | undefined {
		if (!lastFailure) return undefined;
		const { code, fields, cause } = lastFailure;
		return new ReleasedChildError(code, fields, { cause: cause instanceof WeakRef ? cause.deref() : cause });
	},
};

interface ChildRecordFailureNotice {
	readonly childId?: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
}

/** Record one owner-scoped notice without retaining the error or its cause. */
export function observeChildRecordFailure(ownerSessionId: string, error: ReleasedChildError): void {
	subagentChildRecordFailures.count += 1;
	const { code, fields, cause } = error;
	lastFailure = {
		code,
		fields,
		cause: (typeof cause === "object" && cause !== null) || typeof cause === "function" ? new WeakRef(cause) : cause,
	};
	pendingRecordFailures.set(ownerSessionId, {
		...(error.fields.childId === undefined ? {} : { childId: error.fields.childId }),
		code: error.code,
		message: error.message,
		hint: error.hint,
	});
}

/** Take the owner's latest unreported failure once, leaving other owners' failures untouched. */
export function takeChildRecordFailure(ownerSessionId: string, childId?: string): ChildRecordFailureNotice | undefined {
	const failure = pendingRecordFailures.get(ownerSessionId);
	if (failure === undefined || (childId !== undefined && failure.childId !== childId)) return undefined;
	pendingRecordFailures.delete(ownerSessionId);
	return failure;
}

/**
 * Make a child's latest record readable in this step of its owner's order: one that left its session's window is read
 * from that session, and stays in memory until the child's next observation merges over it. Undefined when there is
 * nothing to read, so the step goes on at once. Read the record right after this, so no observation made while it was
 * read is written over.
 */
function recordReadable(ownerSessionId: string, childId: string): Promise<unknown> | undefined {
	if (!subagentChildRecordNeedsRead(ownerSessionId, childId)) return undefined;
	return loadSubagentChildRecord(ownerSessionId, childId, { keep: true });
}

/** Run `step` after every earlier step of this owner. The result rejects when `step` does; later steps still run. */
function inOrder(ownerSessionId: string, step: () => Promise<void>): Promise<void> {
	const run = (appendChains.get(ownerSessionId) ?? Promise.resolve()).then(step);
	const settled = run.catch(() => undefined);
	appendChains.set(ownerSessionId, settled);
	void settled.then(() => {
		if (appendChains.get(ownerSessionId) === settled) appendChains.delete(ownerSessionId);
	});
	return run;
}

function recordAppendFailure(record: SubagentChildRecord, error: Error): ReleasedChildError {
	return new ReleasedChildError(
		"record-append-failed",
		{
			ownerSessionId: record.owner.sessionId,
			childId: record.childId,
			state: record.state,
			...(record.terminalStatus === undefined ? {} : { terminalStatus: record.terminalStatus }),
		},
		{ cause: error },
	);
}

function asRecordFailure(record: SubagentChildRecord, error: Error): ReleasedChildError {
	return isReleasedChildError(error) ? error : recordAppendFailure(record, error);
}

/** Append `record`, already observed as its child's full latest record, and point the index at its entry. */
async function appendObserved(pi: Pick<ExtensionAPI, "appendEntry">, record: SubagentChildRecord): Promise<void> {
	pendingSubagentChildWrites.add(record);
	try {
		await pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, record);
	} catch (error) {
		throw recordAppendFailure(record, error as Error);
	} finally {
		pendingSubagentChildWrites.delete(record);
	}
	settleSubagentChildRecord(record);
}

/**
 * Append records of one owner in order, across every sink of that owner. Each is the child's complete record: what
 * it records merged over its latest one, so the index points at one entry (#4395). A failed append is counted, not
 * lost.
 */
/** Settles once `record` is appended: `true`, or `false` when appending it failed, which is reported as a failure. */
function appendInOrder(pi: Pick<ExtensionAPI, "appendEntry">, record: SubagentChildRecord): Promise<boolean> {
	const full = observeSubagentChildRecord(record);
	pendingSubagentChildWrites.add(full);
	return inOrder(full.owner.sessionId, () => appendObserved(pi, full)).then(
		() => true,
		(error: Error) => {
			observeChildRecordFailure(full.owner.sessionId, asRecordFailure(full, error));
			return false;
		},
	);
}

/**
 * Save one complete record of each child of `ownerSessionId` whose latest record is not saved as one entry, as when
 * its session holds only the partial records an older Atomic wrote (#4395). Queued in the owner's append order, which
 * a wake waits for. Settles once each is appended; a failed append is counted, not lost.
 */
export async function saveUnsavedSubagentChildRecords(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ownerSessionId: string,
): Promise<void> {
	// Newer records of a child whose earlier ones left the window are saved whole, merged over those.
	const merging = subagentChildRecordsMerging(ownerSessionId);
	if (merging !== undefined) await merging;
	for (const record of unsavedSubagentChildRecordsOf(ownerSessionId)) {
		if (pendingSubagentChildWrites.has(record)) continue;
		void inOrder(ownerSessionId, async () => {
			if (isUnsavedSubagentChildRecord(record)) await appendObserved(pi, record);
		}).catch((error: Error) => {
			observeChildRecordFailure(ownerSessionId, asRecordFailure(record, error));
		});
	}
	await subagentChildRecordsAppended(ownerSessionId);
}

/** Settles once every record of this owner handed to a sink so far has been appended. */
export function subagentChildRecordsAppended(ownerSessionId: string): Promise<void> {
	return appendChains.get(ownerSessionId) ?? Promise.resolve();
}

/** Append child records to the owning session in launch order. */
export function createSubagentChildRecordSink(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: Pick<ExtensionContext, "sessionManager">,
): SubagentChildRecordSink {
	const owner = subagentChildOwner(ctx);
	pi = subagentChildOwnerWriter(pi, ctx.sessionManager);
	registerSubagentChildRecordReader(ctx.sessionManager);
	const worktreeRootMappings = currentWorktreeRootMappings();
	let appended: Promise<boolean> = Promise.resolve(true);
	return {
		ownerSessionId: owner.sessionId,
		record(input) {
			const record: SubagentChildRecord = {
				version: 1,
				childId: subagentChildId(input.runId, input.index),
				owner,
				...(worktreeRootMappings.length > 0 ? { worktreeRootMappings } : {}),
				...input,
			};
			appended = appendInOrder(pi, record);
		},
		flushed: () => appended.then(() => undefined),
		saved: () => appended,
		clearHeldToolResults: (childId, toolCallIds) =>
			clearSubagentChildHeldToolResults(pi, owner.sessionId, childId, toolCallIds),
		holdMessages: (childId, messages) => holdSubagentChildMessages(pi, owner.sessionId, childId, messages),
	};
}

/** Whether held messages were kept, and for which kind of stopped child: a released one is woken for them. */
export type HeldMessagesOutcome = "released" | "stopped" | "not-held";

const STOPPED_STATUSES: ReadonlySet<string | undefined> = new Set(["paused", "quit"]);

/**
 * Add `messages` after the ones a released or stopped child already holds for its current task, in the owner's
 * append order, so its next wake or resume delivers them once. A child that runs again or has ended holds nothing:
 * the caller delivers the messages some other way.
 */
export async function holdSubagentChildMessages(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ownerSessionId: string,
	childId: string,
	messages: readonly string[],
): Promise<HeldMessagesOutcome> {
	let outcome: HeldMessagesOutcome = "not-held";
	await inOrder(ownerSessionId, async () => {
		const reading = recordReadable(ownerSessionId, childId);
		if (reading !== undefined) await reading;
		const latest = subagentChildRecordOf(ownerSessionId, childId);
		if (latest?.state !== "terminal") return;
		const kind =
			latest.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS
				? "released"
				: STOPPED_STATUSES.has(latest.terminalStatus)
					? "stopped"
					: undefined;
		if (kind === undefined || latest.taskId === undefined) return;
		const held = latest.heldMessages?.taskId === latest.taskId ? latest.heldMessages : undefined;
		await appendObserved(
			pi,
			observeSubagentChildRecord({
				...latest,
				heldMessages: {
					taskId: latest.taskId,
					messages: [...(held?.messages ?? []), ...messages],
					taskExpands: held?.taskExpands ?? false,
				},
			}),
		);
		outcome = kind;
	});
	return outcome;
}

/** `terminalStatus` of a child stopped by `pause` or `quit`; both stay resumable. */
export type SubagentChildStopStatus = "paused" | "quit";

/** Mark the task about to be cancelled so its settlement is recorded as paused or quit, not interrupted. */
export function requestSubagentChildStop(taskId: string, status: SubagentChildStopStatus): void {
	stopRequests.set(taskId, status);
}

export function takeSubagentChildStop(taskId: string): SubagentChildStopStatus | undefined {
	const status = stopRequests.get(taskId);
	stopRequests.delete(taskId);
	return status;
}

/**
 * Append a new latest observation of a child that changes only its state and terminal status. Written in the owner's
 * order over the child's latest record, never over `record`, the caller's earlier copy: that copy would write back
 * what it held then, such as results held or messages queued for the child since (#4845). `record` is used only for a
 * child the index has no record of.
 */
export async function recordSubagentChildStatus(
	pi: Pick<ExtensionAPI, "appendEntry">,
	record: SubagentChildRecord,
	terminalStatus: string,
): Promise<void> {
	await inOrder(record.owner.sessionId, async () => {
		const reading = recordReadable(record.owner.sessionId, record.childId);
		if (reading !== undefined) await reading;
		const latest = subagentChildRecordOf(record.owner.sessionId, record.childId) ?? record;
		await appendObserved(pi, observeSubagentChildRecord({ ...latest, state: "terminal", terminalStatus }));
	});
}

/**
 * Record a pause or quit of a child that is not running in this process, in the owner's order, against its latest
 * record (#4845): a released child, or for `quit` a paused one, takes `status`; any other record is left as it is.
 * Returns the child's latest record after it, which tells the caller what the child now is.
 */
export async function recordSubagentChildStop(
	pi: Pick<ExtensionAPI, "appendEntry">,
	record: SubagentChildRecord,
	status: SubagentChildStopStatus,
): Promise<SubagentChildRecord> {
	let result = record;
	await inOrder(record.owner.sessionId, async () => {
		const reading = recordReadable(record.owner.sessionId, record.childId);
		if (reading !== undefined) await reading;
		const latest = subagentChildRecordOf(record.owner.sessionId, record.childId) ?? record;
		result = latest;
		if (latest.state !== "terminal") return;
		const released = latest.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS;
		const paused = latest.terminalStatus === "paused";
		if (!released && !(status === "quit" && paused)) return;
		result = observeSubagentChildRecord({ ...latest, terminalStatus: status });
		await appendObserved(pi, result);
	});
	return result;
}

/**
 * Append a new latest observation of a child that adds tool results to the ones it holds for its next wake. The
 * record is taken from the index when this step's turn comes in the owner's order, never from an earlier snapshot:
 * one made before a later record was written would write that record's state over again. Failing loudly: a result
 * that is not saved must not be dropped.
 */
export async function recordSubagentChildHeldToolResults(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ownerSessionId: string,
	childId: string,
	heldToolResults: readonly DetachedToolResult[],
): Promise<SubagentChildRecord> {
	let next: SubagentChildRecord | undefined;
	await inOrder(ownerSessionId, async () => {
		const reading = recordReadable(ownerSessionId, childId);
		if (reading !== undefined) await reading;
		const latest = subagentChildRecordOf(ownerSessionId, childId);
		if (latest === undefined) throw new ReleasedChildError("child-record-missing", { ownerSessionId, childId });
		const record = observeSubagentChildRecord({
			...latest,
			heldToolResults: withHeldToolResults(latest.heldToolResults, heldToolResults),
		});
		await appendObserved(pi, record);
		next = record;
	});
	return next as SubagentChildRecord;
}

export async function clearSubagentChildHeldToolResults(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ownerSessionId: string,
	childId: string,
	toolCallIds: readonly string[],
): Promise<void> {
	await inOrder(ownerSessionId, async () => {
		const reading = recordReadable(ownerSessionId, childId);
		if (reading !== undefined) await reading;
		const latest = subagentChildRecordOf(ownerSessionId, childId);
		const held = latest?.heldToolResults ?? [];
		const kept = held.filter((result) => !toolCallIds.includes(result.toolCallId));
		if (latest === undefined) return;
		const waitingOn = latest.waitingOn?.filter(
			(call) => call.replyWait === undefined || !toolCallIds.includes(call.toolCallId),
		);
		if (kept.length === held.length && waitingOn?.length === latest.waitingOn?.length) return;
		await appendObserved(
			pi,
			observeSubagentChildRecord({
				...latest,
				heldToolResults: kept,
				...(waitingOn === undefined ? {} : { waitingOn }),
			}),
		);
	}).catch((error: Error) => {
		// Nothing awaits some of these: a failure that is not a ReleasedChildError, such as a store that fails a read, is
		// counted like any other, never thrown again from here.
		observeChildRecordFailure(
			ownerSessionId,
			isReleasedChildError(error)
				? error
				: new ReleasedChildError("record-append-failed", { ownerSessionId, childId }, { cause: error }),
		);
	});
}

/**
 * Hold `resultOf` for each call the child was told is still running in an owner generation other than `generation`,
 * in the owner's order, and stop tracking those calls (#5014): the call died with that process, so its result never
 * arrives, and the held result tells the child so once. Undefined when there was nothing to report.
 */
export async function holdInterruptedStillRunningCalls(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ownerSessionId: string,
	childId: string,
	generation: string,
	resultOf: (call: SubagentChildStillRunningCall) => DetachedToolResult,
): Promise<SubagentChildRecord | undefined> {
	return appendInTurn(pi, ownerSessionId, childId, (latest) => {
		const tracked = latest.stillRunning ?? [];
		const interrupted = tracked.filter((call) => call.ownerGeneration !== generation);
		if (interrupted.length === 0) return undefined;
		return {
			...latest,
			// A result that arrived for the call meanwhile is kept over its interrupted one.
			heldToolResults: withHeldToolResults(latest.heldToolResults, interrupted.map(resultOf)),
			stillRunning: tracked.filter((call) => call.ownerGeneration === generation),
		};
	});
}

function withHeldToolResults(
	held: readonly DetachedToolResult[] | undefined,
	added: readonly DetachedToolResult[],
): DetachedToolResult[] {
	const kept = [...(held ?? [])];
	for (const result of added)
		if (!kept.some((existing) => existing.toolCallId === result.toolCallId)) kept.push(result);
	return kept;
}

/** Record a reply before its broker acknowledges it; a duplicate or expired question is refused. */
export async function recordSubagentChildReply(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ownerSessionId: string,
	childId: string,
	questionId: string,
	result: DetachedToolResult,
	arrivedAt: number,
): Promise<boolean> {
	let accepted = false;
	await inOrder(ownerSessionId, async () => {
		const reading = recordReadable(ownerSessionId, childId);
		if (reading !== undefined) await reading;
		const latest = subagentChildRecordOf(ownerSessionId, childId);
		const call = latest?.waitingOn?.find(
			(item) => item.toolCallId === result.toolCallId && item.replyWait?.questionId === questionId,
		);
		if (
			latest === undefined ||
			latest.terminalStatus === "killed" ||
			latest.terminalStatus === SUBAGENT_CHILD_GONE_STATUS ||
			call?.replyWait === undefined ||
			arrivedAt >= call.replyWait.deadline ||
			latest.heldToolResults?.some((item) => item.toolCallId === result.toolCallId)
		)
			return;
		const record: SubagentChildRecord = {
			...latest,
			heldToolResults: withHeldToolResults(latest.heldToolResults, [result]),
		};
		try {
			await pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, record);
		} catch (error) {
			throw recordAppendFailure(record, error as Error);
		}
		observeSubagentChildRecord(record, false, findAppendedSubagentChildRecord(record));
		accepted = true;
	});
	return accepted;
}

async function appendInTurn(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ownerSessionId: string,
	childId: string,
	next: (latest: SubagentChildRecord) => SubagentChildRecord | undefined,
): Promise<SubagentChildRecord | undefined> {
	let written: SubagentChildRecord | undefined;
	await inOrder(ownerSessionId, async () => {
		const reading = recordReadable(ownerSessionId, childId);
		if (reading !== undefined) await reading;
		const latest = subagentChildRecordOf(ownerSessionId, childId);
		if (latest === undefined) throw new ReleasedChildError("child-record-missing", { ownerSessionId, childId });
		const update = next(latest);
		if (update === undefined) return;
		const record = observeSubagentChildRecord(update);
		await appendObserved(pi, record);
		written = record;
	});
	return written;
}

export async function recordSubagentChildWakeFailure(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ownerSessionId: string,
	childId: string,
	toolResults: readonly DetachedToolResult[],
	failure: ReleasedChildError,
): Promise<void> {
	await appendInTurn(pi, ownerSessionId, childId, (latest) => {
		const reported = currentWakeFailure(latest)?.reported;
		return {
			...latest,
			heldToolResults: withHeldToolResults(latest.heldToolResults, toolResults),
			wakeFailure: {
				...(latest.taskId === undefined ? {} : { taskId: latest.taskId }),
				code: failure.code,
				// Shown before the code and the hint, so not the message, which ends with them, also for a copy that
				// crossed a JSON boundary (#5551).
				reason: failure.fields?.reason ?? releasedChildErrorSubject(failure),
				hint: failure.hint,
				...(reported ? { reported } : {}),
			},
		};
	});
}

export function reportSubagentChildWakeFailure(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ownerSessionId: string,
	childId: string,
): Promise<SubagentChildRecord | undefined> {
	return appendInTurn(pi, ownerSessionId, childId, (latest) => {
		const failure = currentWakeFailure(latest);
		return failure === undefined || failure.reported
			? undefined
			: { ...latest, wakeFailure: { ...failure, reported: true } };
	});
}

/**
 * Append the terminal observation of a child that could not be restored and has been reported
 * gone to its owner, so no later resume retries it or repeats the report (#3760). Append-only,
 * like every other record: the child keeps its identity and only its latest state changes.
 */
export async function recordSubagentChildGone(
	pi: Pick<ExtensionAPI, "appendEntry">,
	record: SubagentChildRecord,
): Promise<void> {
	await recordSubagentChildStatus(pi, record, SUBAGENT_CHILD_GONE_STATUS);
}

/**
 * Fold a session's child records into the latest observation per child, in first-launch order.
 * With `ownerSessionId`, only children that session launched are read: `/fork`, `atomic --fork` and
 * branched sessions copy the original's records, but those children belong to the original session.
 */
export function readSubagentChildRecords(
	entries: readonly SessionEntry[],
	ownerSessionId?: string,
): Map<string, SubagentChildRecord> {
	const records = new Map<string, SubagentChildRecord>();
	for (const entry of entries) {
		if (!isSubagentChildRecord(entry)) continue;
		const data = entry.data as SubagentChildRecord;
		if (ownerSessionId !== undefined && data.owner?.sessionId !== ownerSessionId) continue;
		const previous = records.get(data.childId);
		records.set(data.childId, visibleWorktreeRecord(previous ? { ...previous, ...data } : data));
	}
	return records;
}

/** Resolve a child by its child id (`<runId>:<index>`), launch task id, or original intercom name. */
export function findSubagentChildRecord<T extends Pick<SubagentChildRecord, "taskId" | "intercomTarget">>(
	records: ReadonlyMap<string, T>,
	id: string,
): T | undefined {
	const target = id.trim();
	const direct = records.get(target);
	if (direct) return direct;
	for (const record of records.values()) {
		if (record.taskId === target || record.intercomTarget === target) return record;
	}
	return undefined;
}

/** Owners with appends in flight and stop requests not taken yet; both are empty when nothing is happening. */
export function subagentChildRecordRegistrySizes(): { readonly appendChains: number; readonly stopRequests: number } {
	return { appendChains: appendChains.size, stopRequests: stopRequests.size };
}
