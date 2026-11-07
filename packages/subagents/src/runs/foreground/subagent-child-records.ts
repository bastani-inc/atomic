import {
	currentWorktreeRootMappings,
	type DetachedToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	SessionManager,
	type SessionStore,
	type WorktreeRootMapping,
} from "@bastani/atomic";
import type { AgentSource } from "../../agents/agent-types.js";
import type { ModelConstraints } from "../../shared/model-constraints.js";
import type { MaxOutputConfig, OutputMode, RunSyncOptions } from "../../shared/types.js";
import { launchRequestedModel } from "../shared/model-fallback.js";
import { isReleasedChildError, ReleasedChildError, type ReleasedChildErrorCode } from "./released-child-errors.js";
import { type SubagentChildWorktree, unparkRunWorktree } from "./run-worktrees.js";
import {
	findAppendedSubagentChildRecord,
	isSubagentChildRecord,
	isUnsavedSubagentChildRecord,
	observeSubagentChildRecord,
	registerSubagentChildRecordReader,
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_RELEASED_STATUS,
	settleSubagentChildRecord,
	subagentChildIdsOf,
	subagentChildRecordOf,
	unsavedSubagentChildRecordsOf,
} from "./subagent-child-card-state.js";

export { isSubagentChildRecord, SUBAGENT_CHILD_RECORD_TYPE, SUBAGENT_CHILD_RELEASED_STATUS };

export type SubagentChildOwner =
	| { readonly kind: "session"; readonly sessionId: string }
	| {
			readonly kind: "workflow-stage";
			readonly sessionId: string;
			readonly workflowRunId: string;
			readonly workflowStageId: string;
			readonly workflowStageName: string;
	  };

/**
 * One durable observation of a launched child. The latest record for a child id
 * is authoritative: `running` means the child had not settled when it was written,
 * `terminal` means it settled: completed, failed, was interrupted, paused or quit, or was stopped
 * for good. Session recovery restores `running` children and those its workflow stage's pause stopped
 * (`stage-paused`); an explicit `resume` also reopens a settled child unless its `terminalStatus` is
 * non-resumable (`killed`, `stage-closed`, `gone`).
 */
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
	readonly intercomTarget?: string;
	readonly intercomGroup?: string;
	readonly orchestratorTarget?: string;
	/** The `worktree: true` worktree the child runs in, so resume can recreate it from the run's base. */
	readonly worktree?: SubagentChildWorktree;
	readonly terminalStatus?: string;
	/**
	 * Steering and follow-up messages the child had queued but not read when pause, quit or its stage's pause stopped
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
	/** The launch's own `modelConstraints`, which every model its child falls back to must satisfy (#4188). */
	readonly modelConstraints?: ModelConstraints;
	/**
	 * The detached tool calls a released child is waiting on (#4326): its run ended with them still running, and their
	 * results wake it. Empty once nothing is outstanding.
	 */
	readonly waitingOn?: readonly SubagentChildWaitingCall[];
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

export function currentWakeFailure(record: SubagentChildRecord): SubagentChildWakeFailure | undefined {
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
): Pick<SubagentChildRecord, "namedModel" | "requestedModel" | "modelConstraints"> {
	const named = options.requestedModel ?? options.modelOverride ?? agent?.model;
	const namedModel = options.modelRoute || options.runsNamedModel === false || named === "auto" ? undefined : named;
	const requestedModel = launchRequestedModel(agent, options);
	return {
		...(namedModel ? { namedModel } : {}),
		...(requestedModel ? { requestedModel } : {}),
		...(options.modelConstraints ? { modelConstraints: options.modelConstraints } : {}),
	};
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
	/** Whether the owner is a workflow stage whose generation is closing for good, not merely interrupted. */
	ownerEndedForGood?(): boolean;
	/** Settles once every record this sink was given has been appended. */
	flushed?(): Promise<void>;
	clearHeldToolResults?(childId: string, toolCallIds: readonly string[]): Promise<void>;
	/** Keep messages for a released or stopped child, for its next wake or resume; see {@link holdSubagentChildMessages}. */
	holdMessages?(childId: string, messages: readonly string[]): Promise<HeldMessagesOutcome>;
}

/** `terminalStatus` of a child whose workflow stage finished, or whose run ended or was cancelled; never resumable. */
export const SUBAGENT_CHILD_STAGE_CLOSED_STATUS = "stage-closed";

/**
 * `terminalStatus` of a child stopped because its workflow stage paused: the run was paused or quit, Atomic exited,
 * or the session was switched. It stays resumable, and is restored when its stage resumes from its session (#3760).
 */
export const SUBAGENT_CHILD_STAGE_PAUSED_STATUS = "stage-paused";

/** Whether session recovery restores this child: it had not settled, or its stage's pause stopped it (#3760). */
export function isRestorableSubagentChild(record: SubagentChildRecord): boolean {
	return (
		record.state === "running" ||
		(record.state === "terminal" && record.terminalStatus === SUBAGENT_CHILD_STAGE_PAUSED_STATUS)
	);
}

/**
 * Workflow-stage extension state the workflows extension sets before it closes a stage generation for good. Without
 * it a closing stage was interrupted (Atomic exited, or the run was paused), and its children stay restorable (#3760).
 */
export const WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE = "atomic:workflow-stage-closed-for-good";

/**
 * Workflow-stage extension state this extension sets to a {@link WorkflowStageChildrenEnd}: a stage generation that
 * closed resumably and later ended for good (its blocked run was then killed or ended) ends its children through it.
 */
export const WORKFLOW_STAGE_END_CHILDREN_STATE = "atomic:workflow-stage-end-children";

export interface WorkflowStageChildrenEnd {
	/** End every settled child the stage owns, once the stage closed for good. */
	readonly endChildren: () => void;
}

/** `terminalStatus` of a child that could not be restored after a restart and was reported gone to its owner. */
export const SUBAGENT_CHILD_GONE_STATUS = "gone";

const ENDED_STATUSES: ReadonlySet<string> = new Set([
	"killed",
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_GONE_STATUS,
]);

/**
 * Whether a workflow stage closing for good ends this settled child: every one does, completed, failed, interrupted,
 * paused or quit. Running children end when their task settles.
 */
function endsWithStage(record: SubagentChildRecord): boolean {
	return record.state === "terminal" && !ENDED_STATUSES.has(record.terminalStatus ?? "");
}

/** Whether a workflow run ending for good ends this child: every one does that has not ended already, running or not. */
function endsWithRun(record: SubagentChildRecord): boolean {
	return record.state === "running" || endsWithStage(record);
}

export function subagentChildId(runId: string, index: number): string {
	return `${runId}:${index}`;
}

export function subagentChildOwner(
	ctx: Pick<ExtensionContext, "sessionManager" | "orchestrationContext">,
): SubagentChildOwner {
	const sessionId = ctx.sessionManager.getSessionId();
	const orchestration = ctx.orchestrationContext;
	return orchestration?.kind === "workflow-stage"
		? {
				kind: "workflow-stage",
				sessionId,
				workflowRunId: orchestration.workflowRunId,
				workflowStageId: orchestration.workflowStageId,
				workflowStageName: orchestration.workflowStageName,
			}
		: { kind: "session", sessionId };
}

const appendChains = new Map<string, Promise<void>>();

/** Failed appends of child records, counted so a record that could not be saved is not lost silently. */
export const subagentChildRecordFailures: { count: number; last?: ReleasedChildError } = { count: 0 };

interface ChildRecordFailureNotice {
	readonly childId?: string;
	readonly code: string;
	readonly message: string;
	readonly hint: string;
}
const pendingRecordFailures = new Map<string, ChildRecordFailureNotice>();

/** Record one owner-scoped notice without retaining the error or its cause. */
export function observeChildRecordFailure(ownerSessionId: string, error: ReleasedChildError): void {
	subagentChildRecordFailures.count += 1;
	subagentChildRecordFailures.last = error;
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
	try {
		await pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, record);
	} catch (error) {
		throw recordAppendFailure(record, error as Error);
	}
	settleSubagentChildRecord(record);
}

/**
 * Append records of one owner in order, across every sink of that owner. Each is the child's complete record: what
 * it records merged over its latest one, so the index points at one entry (#4395). A failed append is counted, not
 * lost.
 */
function appendInOrder(pi: Pick<ExtensionAPI, "appendEntry">, record: SubagentChildRecord): Promise<void> {
	const full = observeSubagentChildRecord(record);
	return inOrder(full.owner.sessionId, () => appendObserved(pi, full)).catch((error: Error) => {
		observeChildRecordFailure(full.owner.sessionId, asRecordFailure(full, error));
	});
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
	for (const record of unsavedSubagentChildRecordsOf(ownerSessionId))
		void inOrder(ownerSessionId, async () => {
			if (isUnsavedSubagentChildRecord(record)) await appendObserved(pi, record);
		}).catch((error: Error) => {
			observeChildRecordFailure(ownerSessionId, asRecordFailure(record, error));
		});
	await subagentChildRecordsAppended(ownerSessionId);
}

/** Settles once every record of this owner handed to a sink so far has been appended. */
export function subagentChildRecordsAppended(ownerSessionId: string): Promise<void> {
	return appendChains.get(ownerSessionId) ?? Promise.resolve();
}

interface StageChildren {
	readonly closeSignal: AbortSignal;
	readonly endedForGood: () => boolean;
	readonly end: (childId: string) => void;
}

const stageChildren = new WeakMap<AbortSignal, StageChildren>();
/** Workflow stage sessions with a generation in this process, whose own session records how their children end. */
const stageSessionsInProcess = new Set<string>();

/**
 * Watch the children a workflow stage owns, so that when the stage generation closes for good every settled child,
 * quit ones included, is recorded `stage-closed`: resume then names why it cannot continue (#3760).
 */
export function watchWorkflowStageSubagentChildren(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: Pick<ExtensionContext, "sessionManager" | "orchestrationContext">,
): StageChildren | undefined {
	const orchestration = ctx.orchestrationContext;
	const admission = orchestration?.kind === "workflow-stage" ? orchestration.messageAdmission : undefined;
	const closeSignal = admission?.boundary.closeSignal;
	if (!admission || !closeSignal) return undefined;
	const existing = stageChildren.get(closeSignal);
	if (existing) return existing;
	const owner = subagentChildOwner(ctx);
	const sessionManager = ctx.sessionManager;
	const endedForGood = () => admission.extensionState.has(WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE);
	const end = (childId: string, persisted?: SubagentChildRecord) => {
		const latest = subagentChildRecordOf(owner.sessionId, childId) ?? persisted;
		if (!endedForGood() || latest?.owner?.sessionId !== owner.sessionId || !endsWithStage(latest)) return;
		void appendInOrder(pi, { ...latest, terminalStatus: SUBAGENT_CHILD_STAGE_CLOSED_STATUS });
		// It can no longer resume, so its worktree is no longer kept for it.
		unparkRunWorktree(latest.runId, latest.index);
	};
	const watched: StageChildren = { closeSignal, endedForGood, end };
	stageChildren.set(closeSignal, watched);
	stageSessionsInProcess.add(owner.sessionId);
	const endAll = () => {
		if (!endedForGood()) return;
		const persisted = readSubagentChildRecords(sessionManager.getEntries(), owner.sessionId);
		for (const childId of new Set([...persisted.keys(), ...subagentChildIdsOf(owner.sessionId)]))
			end(childId, persisted.get(childId));
	};
	if (closeSignal.aborted) endAll();
	else closeSignal.addEventListener("abort", endAll, { once: true });
	// A generation that closed resumably can still end for good later, after its close.
	const later: WorkflowStageChildrenEnd = { endChildren: endAll };
	admission.extensionState.set(WORKFLOW_STAGE_END_CHILDREN_STATE, later);
	return watched;
}

/**
 * Workflows → subagents: a workflow run ended for good (killed, cancelled, or failed for good). Every subagent its
 * stages launched ends with it, also when no generation of a stage is live in this process, as after a restart.
 */
export const WORKFLOW_RUN_ENDED_STAGE_SUBAGENTS_EVENT = "atomic:workflow-run-ended-stage-subagents";

export interface WorkflowRunEndedStageSubagentsRequest {
	readonly runId: string;
	/** Sessions of the run's stages; their `subagent-child` records name the children. */
	readonly stageSessionIds: readonly string[];
	/** The launching session, whose store holds the stage sessions; defaults to the one the extension last saw start. */
	readonly context?: Pick<ExtensionContext, "sessionManager">;
	completion?: Promise<void>;
}

/**
 * Record every child of the ended run's stages `stage-closed` (#3784). A stage with a generation in this process ends
 * its children through that generation's close and its own session. A stage with none, such as a dormant run's stage
 * after a restart, has the records appended to its saved session in the store, running children included, since no
 * task of theirs is left to settle. A stage session that cannot be opened is skipped.
 */
export async function endWorkflowRunStageSubagentChildren(
	ctx: Pick<ExtensionContext, "sessionManager">,
	stageSessionIds: readonly string[],
): Promise<void> {
	let store: SessionStore;
	try {
		store = ctx.sessionManager.getSessionStore();
	} catch {
		return;
	}
	for (const stageSessionId of new Set(stageSessionIds)) {
		if (stageSessionsInProcess.has(stageSessionId)) continue;
		try {
			const stageSession = await SessionManager.open(store, stageSessionId);
			for (const record of readSubagentChildRecords(stageSession.getEntries(), stageSessionId).values()) {
				if (!endsWithRun(record)) continue;
				const ended: SubagentChildRecord = {
					...record,
					state: "terminal",
					terminalStatus: SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
				};
				const entryId = await stageSession.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, ended);
				observeSubagentChildRecord(ended, false, { entryId, sessionId: stageSessionId });
			}
		} catch {
			// Its session is gone or unreadable: nothing restores its children either.
		}
	}
}

/**
 * Append child records to the owning session in launch order. When the owner's workflow stage generation closes for
 * good, its children end with it (see {@link watchWorkflowStageSubagentChildren}).
 */
export function createSubagentChildRecordSink(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: Pick<ExtensionContext, "sessionManager" | "orchestrationContext">,
): SubagentChildRecordSink {
	const owner = subagentChildOwner(ctx);
	registerSubagentChildRecordReader(ctx.sessionManager);
	const stage = watchWorkflowStageSubagentChildren(pi, ctx);
	const worktreeRootMappings = currentWorktreeRootMappings();
	let appended: Promise<void> = Promise.resolve();
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
			// A child that settles after its stage already closed for good ends with it at once.
			if (stage?.closeSignal.aborted) stage.end(record.childId);
		},
		ownerEndedForGood: () => stage?.endedForGood() === true,
		flushed: () => appended,
		clearHeldToolResults: (childId, toolCallIds) =>
			clearSubagentChildHeldToolResults(pi, owner.sessionId, childId, toolCallIds),
		holdMessages: (childId, messages) => holdSubagentChildMessages(pi, owner.sessionId, childId, messages),
	};
}

/** Whether held messages were kept, and for which kind of stopped child: a released one is woken for them. */
export type HeldMessagesOutcome = "released" | "stopped" | "not-held";

const STOPPED_STATUSES: ReadonlySet<string | undefined> = new Set([
	"paused",
	"quit",
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
]);

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

const stopRequests = new Map<string, SubagentChildStopStatus>();

/** Mark the task about to be cancelled so its settlement is recorded as paused or quit, not interrupted. */
export function requestSubagentChildStop(taskId: string, status: SubagentChildStopStatus): void {
	stopRequests.set(taskId, status);
}

export function takeSubagentChildStop(taskId: string): SubagentChildStopStatus | undefined {
	const status = stopRequests.get(taskId);
	stopRequests.delete(taskId);
	return status;
}

/** Append a new latest observation of a child that changes only its terminal status. */
export async function recordSubagentChildStatus(
	pi: Pick<ExtensionAPI, "appendEntry">,
	record: SubagentChildRecord,
	terminalStatus: string,
): Promise<void> {
	const next = observeSubagentChildRecord({ ...record, state: "terminal", terminalStatus });
	await pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, next);
	settleSubagentChildRecord(next);
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
	}).catch((error: ReleasedChildError) => {
		observeChildRecordFailure(ownerSessionId, error);
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
		const latest = subagentChildRecordOf(ownerSessionId, childId);
		const call = latest?.waitingOn?.find(
			(item) => item.toolCallId === result.toolCallId && item.replyWait?.questionId === questionId,
		);
		if (
			latest === undefined ||
			latest.terminalStatus === "killed" ||
			latest.terminalStatus === SUBAGENT_CHILD_GONE_STATUS ||
			latest.terminalStatus === SUBAGENT_CHILD_STAGE_CLOSED_STATUS ||
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
				reason: failure.fields.reason ?? failure.message,
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
	const gone = observeSubagentChildRecord({
		...record,
		state: "terminal",
		terminalStatus: SUBAGENT_CHILD_GONE_STATUS,
	});
	await pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, gone);
	settleSubagentChildRecord(gone);
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
		records.set(data.childId, previous ? { ...previous, ...data } : data);
	}
	return records;
}

/** Resolve a child by its child id (`<runId>:<index>`), launch task id, or original intercom name. */
export function findSubagentChildRecord(
	records: ReadonlyMap<string, SubagentChildRecord>,
	id: string,
): SubagentChildRecord | undefined {
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
