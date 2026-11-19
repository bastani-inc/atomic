import type { AgentTaskHost, ExtensionContext, TaskId } from "@bastani/atomic";
import {
	isSubagentChildSession,
	isWorkflowStageOrchestrationContext,
	type ResumeInFlight,
	type SubagentRunControlAction,
	type SubagentRunControlChild,
	type SubagentRunControlDetails,
	type SubagentToolResult,
} from "../../shared/types.js";
import { subagentChildIdOfPath } from "../inprocess/control-registry.js";
import { inheritedIntercomGroup } from "../shared/intercom-group.js";
import {
	isLiveOwnerlessChild,
	isQueuedOwnerlessChild,
	liveOwnerlessAdmissions,
	stopOwnerlessChild,
} from "./ownerless-children.js";
import { ReleasedChildError } from "./released-child-errors.js";
import { releasedChildReservation, reserveReleasedChildren } from "./released-child-reservations.js";
import {
	type AdmittedSubagentChild,
	admittedSubagentChild,
	awaitResumeCheck,
	beginReleasedChildStop,
	isReleasedChildWakeActive,
	ReleasedChildResumeInterruptedError,
	ReleasedChildResumeRunningError,
	releasedChildWakeDecided,
	resumeReleasedChild,
} from "./released-child-resume.js";
import { subagentWakeKey } from "./released-children.js";
import { parkRunWorktree, unparkRunWorktree } from "./run-worktrees.js";
import {
	holdSubagentChildRecord,
	indexSubagentChildOwner,
	observedSubagentRunIds,
	type SubagentChildRecordHold,
	type SubagentChildStanding,
} from "./subagent-child-card-state.js";
import { childHoldKey, holdChildTargets, parkPausedChildHold, releasePausedChildHold } from "./subagent-child-hold.js";
import { subagentChildOwnerOperations } from "./subagent-child-owner.js";
import {
	currentWakeFailure,
	findSubagentChildRecord,
	isSubagentChildRecord,
	readSubagentChildRecords,
	recordSubagentChildStatus,
	recordSubagentChildStop,
	requestSubagentChildStop,
	SUBAGENT_CHILD_GONE_STATUS,
	SUBAGENT_CHILD_RELEASED_STATUS,
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildOwner,
	type SubagentChildRecord,
	type SubagentChildStopStatus,
	subagentChildOwner,
	subagentChildRecordsAppended,
	takeChildRecordFailure,
	takeSubagentChildStop,
} from "./subagent-child-records.js";
import {
	restoreSubagentChild,
	type SubagentChildRestoreDeps,
	type SubagentChildRestoreOutcome,
	subagentChildRestoring,
} from "./subagent-child-restore.js";
import { isQueuedSubagentChild, stopQueuedSubagentChild } from "./task-execution.js";

/** The prompt a resumed child runs when `resume` carries no message, as a resumed workflow stage receives. */
export const SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT =
	"Continue where you left off. If a pause interrupted a command or step you were running, redo or continue that step as needed. If you believe you are finished with your original task (or a redefined task if the user told you), stop.";

/** Settled children that can never be resumed: cancelled for good, ended with their workflow stage, or reported gone (#3760). */
const NON_RESUMABLE_STATUSES: ReadonlyMap<string, string> = new Map([
	["killed", "it was cancelled for good (an owner or batch cancellation, or the removed kill action)"],
	[
		SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
		"its workflow stage ended (the stage finished, or its run ended or was cancelled)",
	],
	[SUBAGENT_CHILD_GONE_STATUS, "it did not survive a restart and was reported gone"],
]);

/** Children stopped part-way through a turn: resume continues that turn, after any steer message. */
const INTERRUPTED_STATUSES: ReadonlySet<string> = new Set([
	"paused",
	"quit",
	"interrupted",
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
]);

export interface SubagentRunControlRequest {
	readonly action: SubagentRunControlAction;
	readonly id?: string;
	readonly message?: string;
	readonly all?: boolean;
}

function controlResult(
	text: string,
	runControl: SubagentRunControlDetails | undefined,
	isError = false,
): SubagentToolResult {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [], ...(runControl ? { runControl } : {}) },
	};
}

function errorResult(action: SubagentRunControlAction, text: string): SubagentToolResult {
	return controlResult(text, { action, children: [] }, true);
}

type ChildLabel = Pick<SubagentChildRecord, "agent" | "childId" | "intercomTarget">;

function label(record: ChildLabel): string {
	return `${record.agent} (${record.childId}${record.intercomTarget ? `, ${record.intercomTarget}` : ""})`;
}

function childDetails(
	record: SubagentChildStanding,
	state: SubagentRunControlChild["state"],
	taskId = record.taskId,
): SubagentRunControlChild {
	return {
		childId: record.childId,
		runId: record.runId,
		index: record.index,
		agent: record.agent,
		state,
		...(taskId ? { taskId } : {}),
		...(record.intercomTarget ? { intercomTarget: record.intercomTarget } : {}),
		...(record.childSessionId ? { childSessionId: record.childSessionId } : {}),
		...(record.childSessionFile ? { childSessionFile: record.childSessionFile } : {}),
	};
}

function liveTaskIds(host: AgentTaskHost | undefined): Set<string> {
	const watched = host?.watchOwnerTasks();
	if (!watched?.ok) return new Set();
	try {
		return new Set(
			watched.value.snapshot.tasks
				.filter((task) => task.execution.kind !== "settled")
				.map((task) => String(task.ref.taskId)),
		);
	} finally {
		watched.value.dispose();
	}
}

/**
 * A child of this session whose records left its context window, as the session's catalog names it: where it stands,
 * without its task, held messages or results. Such a child settled and holds nothing for a later run; an action on it
 * reads its full record first (see {@link holdFullRecordOf}).
 */
interface ArchivedChild extends SubagentChildStanding {
	readonly owner: SubagentChildOwner;
	readonly archivedEntryId: string;
	/** Every task id it ran as. */
	readonly taskIds: readonly string[];
	/** Newer records of it the window still holds, which do not name everything its record has (#4395). */
	readonly overlay?: SubagentChildRecord;
}

/** A child this session launched: its full record, or where it stands when its records left the session's window. */
type OwnedChild = SubagentChildRecord | ArchivedChild;

function isArchivedChild(child: OwnedChild): child is ArchivedChild {
	return Object.hasOwn(child, "archivedEntryId");
}

/** The session state `ownedRecords` read its records from; any append, branch change or history load replaces it. */
interface OwnedRecordsRead {
	readonly sessionId: string;
	readonly owner: string;
	readonly lastSeq: number;
	readonly leafId: string | null;
	readonly fullHistory: boolean;
	readonly records: ReadonlyMap<string, OwnedChild>;
}

const ownedRecordReads = new WeakMap<object, OwnedRecordsRead>();

/**
 * The children this session launched, read once per session state. A subagent's chat asks on every frame whether its
 * child is stopped or read-only, and folding a long session's every entry for each frame cost a stage of work per
 * paint.
 */
function ownedRecords(ctx: ExtensionContext): ReadonlyMap<string, OwnedChild> {
	const manager = ctx.sessionManager;
	const owner = subagentChildOwner(ctx).sessionId;
	if (
		typeof manager.getLastSeq !== "function" ||
		typeof manager.getLeafId !== "function" ||
		typeof manager.hasFullHistory !== "function"
	)
		return ownedChildren(manager, owner);
	const state = {
		sessionId: manager.getSessionId(),
		owner,
		lastSeq: manager.getLastSeq(),
		leafId: manager.getLeafId(),
		fullHistory: manager.hasFullHistory(),
	};
	const read = ownedRecordReads.get(manager);
	if (
		read !== undefined &&
		read.sessionId === state.sessionId &&
		read.owner === state.owner &&
		read.lastSeq === state.lastSeq &&
		read.leafId === state.leafId &&
		read.fullHistory === state.fullHistory
	)
		return read.records;
	const records = ownedChildren(manager, owner);
	ownedRecordReads.set(manager, { ...state, records });
	return records;
}

/** The children `owner` launched, as its entries and its catalog of children whose records left its window name them. */
function ownedChildren(manager: ExtensionContext["sessionManager"], owner: string): ReadonlyMap<string, OwnedChild> {
	const resident = readSubagentChildRecords(manager.getEntries(), owner);
	const catalog =
		typeof manager.getArchivedChildCatalog === "function"
			? manager.getArchivedChildCatalog().filter((child) => child.ownerSessionId === owner)
			: [];
	if (catalog.length === 0) return resident;
	const archived = new Map<string, readonly [number, ArchivedChild]>();
	for (const child of catalog) {
		const overlay = resident.get(child.childId);
		const { entryId, firstSeq, ownerSessionId, taskIds, releasedTaskIds: _released, ...standing } = child;
		archived.set(child.childId, [
			firstSeq,
			{
				...standing,
				...(overlay === undefined ? {} : standingOfRecord(overlay)),
				owner: { kind: "session", sessionId: ownerSessionId },
				archivedEntryId: entryId,
				taskIds,
				...(overlay === undefined ? {} : { overlay }),
			},
		]);
	}
	// In launch order, as a fold of the session's every record lists them: by where each child's first record is.
	const firstSeqs = new Map<string, number | undefined>();
	if (typeof manager.getEntrySeq === "function")
		for (const entry of manager.getEntries()) {
			if (!isSubagentChildRecord(entry)) continue;
			const childId = (entry.data as SubagentChildRecord).childId;
			if (!firstSeqs.has(childId)) firstSeqs.set(childId, manager.getEntrySeq(entry.id));
		}
	const ordered: (readonly [number, OwnedChild])[] = [...archived.values()];
	let positioned = typeof manager.getEntrySeq === "function";
	for (const record of resident.values()) {
		if (archived.has(record.childId)) continue;
		const seq = firstSeqs.get(record.childId);
		if (seq === undefined) positioned = false;
		ordered.push([seq ?? Number.POSITIVE_INFINITY, record]);
	}
	// A session interface that does not say where its entries are lists its own records first, as it always did.
	if (positioned) ordered.sort((left, right) => left[0] - right[0]);
	else ordered.sort((left, right) => Number(isArchivedChild(left[1])) - Number(isArchivedChild(right[1])));
	return new Map(ordered.map(([, child]) => [child.childId, child]));
}

function standingOfRecord(record: SubagentChildRecord): Partial<SubagentChildStanding> {
	const keys = [
		"runId",
		"index",
		"agent",
		"cwd",
		"state",
		"terminalStatus",
		"taskId",
		"childSessionId",
		"childSessionFile",
		"intercomTarget",
		"intercomGroup",
		"releasedIntercomId",
		"elapsedMs",
		"elapsedSpan",
	] as const;
	return Object.fromEntries(keys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]));
}

/** A record no index entry keeps for the action that read it: there is nothing to let go. */
function notHeld(record: SubagentChildRecord): SubagentChildRecordHold {
	return { record, release: () => {} };
}

/**
 * The full record of a child whose records left the session's window, which an action on it reads first: through the
 * child index, which holds it until the action lets it go or the child is recorded again, or else from the session,
 * merged with any newer records the window holds.
 */
async function holdFullRecordOf(ctx: ExtensionContext, child: ArchivedChild): Promise<SubagentChildRecordHold> {
	const held = await holdSubagentChildRecord(child.owner.sessionId, child.childId).catch(() => undefined);
	if (held !== undefined) return held;
	const saved = await ctx.sessionManager.readArchivedChildRecord?.(child.archivedEntryId);
	const data = saved !== undefined && isSubagentChildRecord(saved) ? saved.data : undefined;
	if (data === undefined || data.childId !== child.childId)
		throw new ReleasedChildError("child-record-unreadable", {
			childId: child.childId,
			ownerSessionId: child.owner.sessionId,
			entryId: child.archivedEntryId,
		});
	return notHeld(child.overlay === undefined ? data : { ...data, ...child.overlay });
}

/**
 * The child an earlier record of this session gave task `taskId`: a resumed child runs as a new task, and its record
 * keeps only the latest task id, while the earlier task's chat still continues it.
 */
function childIdOfEarlierTask(ctx: ExtensionContext, taskId: string): string | undefined {
	const owner = subagentChildOwner(ctx).sessionId;
	for (const child of ownedRecords(ctx).values())
		if (isArchivedChild(child) && child.taskIds.includes(taskId)) return child.childId;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (!isSubagentChildRecord(entry)) continue;
		const data = entry.data as SubagentChildRecord;
		if (data.owner?.sessionId === owner && data.taskId === taskId) return data.childId;
	}
	return undefined;
}

/**
 * The child this session launched as task `taskId`, or resumed from it, and why it cannot be resumed, if it cannot:
 * its chat uses this to send a message that resumes it, or to turn read-only.
 */
export function subagentChildOfTask(
	ctx: ExtensionContext,
	taskId: string,
): { readonly childId: string; readonly readOnlyReason?: string } | undefined {
	const records = [...ownedRecords(ctx).values()];
	const current = records.find((candidate) => candidate.taskId === taskId);
	const earlier = current === undefined ? childIdOfEarlierTask(ctx, taskId) : undefined;
	const record = current ?? records.find((candidate) => candidate.childId === earlier);
	if (record === undefined) return undefined;
	const terminal = record.state === "terminal" ? NON_RESUMABLE_STATUSES.get(record.terminalStatus ?? "") : undefined;
	return terminal === undefined
		? { childId: record.childId }
		: { childId: record.childId, readOnlyReason: `${label(record)} cannot take messages: ${terminal}.` };
}

/** Run ids of the children this session launched: the only runs its `status` shows and its run control reaches. */
export async function subagentRunsLaunchedBy(ctx: ExtensionContext): Promise<Set<string>> {
	const owner = subagentChildOwner(ctx).sessionId;
	await subagentChildRecordsAppended(owner);
	const runIds = observedSubagentRunIds(owner);
	for (const record of ownedRecords(ctx).values()) runIds.add(record.runId);
	return runIds;
}

/**
 * A child by its child id, launch task id, Intercom name, the run id of a run that launched only that child, or the
 * path `status` lists it under.
 */
function resolveRecord<T extends Pick<SubagentChildRecord, "childId" | "runId" | "taskId" | "intercomTarget">>(
	records: ReadonlyMap<string, T>,
	id: string,
	live?: ReadonlyMap<string, T>,
): T | string | undefined {
	const target = id.trim();
	const direct =
		live?.get(target) ??
		records.get(target) ??
		(live && findSubagentChildRecord(live, target)) ??
		findSubagentChildRecord(records, target);
	// An earlier saved task ID still identifies the same child now running under its admitted ID.
	if (direct) return live?.get(direct.childId) ?? direct;
	const listedAs = subagentChildIdOfPath(target);
	const byPath = listedAs === undefined ? undefined : (live?.get(listedAs) ?? records.get(listedAs));
	if (byPath) return byPath;
	const inRun: T[] = [];
	for (const record of records.values()) if (record.runId === target && !live?.has(record.childId)) inRun.push(record);
	if (live) for (const child of live.values()) if (child.runId === target) inRun.push(child);
	if (inRun.length === 1) return inRun[0];
	if (inRun.length > 1)
		return `Run ${id} launched ${inRun.length} children; target one by its child id: ${inRun.map((record) => record.childId).join(", ")}.`;
	return undefined;
}

/** A child released while it waits on detached tool calls (#4326): not running, and woken by what it waits on. */
function isReleased(record: Pick<SubagentChildRecord, "state" | "terminalStatus">): boolean {
	return record.state === "terminal" && record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS;
}

/** How a settled child already stands for pause and quit: a child its workflow stage's pause stopped counts as paused. */
function stoppedAs(record: Pick<SubagentChildRecord, "state" | "terminalStatus">): SubagentChildStopStatus | undefined {
	if (record.state !== "terminal") return undefined;
	if (record.terminalStatus === "paused" || record.terminalStatus === SUBAGENT_CHILD_STAGE_PAUSED_STATUS)
		return "paused";
	return record.terminalStatus === "quit" ? "quit" : undefined;
}

async function waitForSettlement(host: AgentTaskHost, taskId: TaskId): Promise<void> {
	for (;;) {
		const observed = await host.waitForTask(taskId);
		if (!observed.ok || observed.value.kind === "settled") return;
	}
}

async function stopHostChild(
	deps: SubagentChildRestoreDeps,
	host: AgentTaskHost,
	record: SubagentChildRecord,
	status: SubagentChildStopStatus,
): Promise<string | undefined> {
	const taskId = record.taskId as TaskId;
	requestSubagentChildStop(taskId, status);
	// It stays resumable: its worktree is kept if it has unsaved work when its run's worktrees are removed.
	parkRunWorktree(record.runId, record.index);
	// A typed resumable stop: its parent is told it is paused and awaiting resume, never that it ended.
	const cancelled = await host.cancelTask(taskId, status === "quit" ? "quit" : "pause");
	if (!cancelled.ok) {
		takeSubagentChildStop(taskId);
		unparkRunWorktree(record.runId, record.index);
		return cancelled.error.message;
	}
	// It settled on its own before the stop reached it: nothing takes the stop, and its worktree is not stopped (#5172).
	if (cancelled.value.decision === "already-settled") {
		takeSubagentChildStop(taskId);
		unparkRunWorktree(record.runId, record.index);
		return undefined;
	}
	// A child cancelled while still queued never starts, so nothing else records how it stopped.
	const queued = stopQueuedSubagentChild(taskId);
	await waitForSettlement(host, taskId);
	if (queued) {
		takeSubagentChildStop(taskId);
		await recordSubagentChildStatus(deps.pi, record, status);
	}
	return undefined;
}

type LiveChildStop =
	| { readonly kind: "stopped" }
	/** The child settled on its own before the stop took effect, with this terminal status. */
	| { readonly kind: "settled"; readonly status: string }
	| { readonly kind: "failed"; readonly reason: string };

/**
 * Stop a live child resumably: through its task host, or directly when no task host launched it (an SDK session).
 * A child that completes before the stop takes effect keeps its own outcome, which its latest record then names.
 */
async function stopLiveChild(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	host: AgentTaskHost | undefined,
	record: SubagentChildRecord,
	status: SubagentChildStopStatus,
): Promise<LiveChildStop> {
	if (record.taskId !== undefined && isLiveOwnerlessChild(record.taskId))
		await stopOwnerlessChild(record.taskId, status);
	else if (host) {
		const failure = await stopHostChild(deps, host, record, status);
		if (failure) return { kind: "failed", reason: failure };
	} else return { kind: "failed", reason: "it is not running in this process" };
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	const key = childHoldKey(ownerSessionId, record.childId);
	await subagentChildRecordsAppended(ownerSessionId);
	const settled = ownedRecords(ctx).get(record.childId);
	if (settled?.state === "terminal" && settled.taskId === record.taskId && settled.terminalStatus !== status) {
		// It is not paused, so nothing sent to it waits for a resume.
		releasePausedChildHold(key);
		return { kind: "settled", status: settled.terminalStatus ?? "settled" };
	}
	if (status === "paused") {
		const hold = await holdChildTargets(
			deps.pi.events,
			record,
			record.intercomGroup ?? inheritedIntercomGroup(ctx),
		).catch(() => undefined);
		if (hold) parkPausedChildHold(key, hold);
	}
	return { kind: "stopped" };
}

/**
 * Pause or quit a released child, or quit a paused one (#4845). No wake relaunches it while this runs, and one already
 * waking it is waited for until it relaunched it or decided not to. The stop is then recorded in the owner's order over
 * the child's latest record, never over the copy `record` was read as; returns that latest record, which tells whether
 * the stop took or the child runs again.
 */
async function stopIdleChild(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	record: SubagentChildRecord,
	status: SubagentChildStopStatus,
): Promise<SubagentChildRecord> {
	const stop = beginReleasedChildStop(subagentWakeKey(subagentChildOwner(ctx).sessionId, record.childId));
	try {
		await stop.decided;
		indexSubagentChildOwner(ctx);
		return await recordSubagentChildStop(deps.pi, record, status);
	} finally {
		stop.end();
	}
}

async function stopChildren(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	request: SubagentRunControlRequest & { action: "pause" | "quit" },
): Promise<SubagentToolResult> {
	const { action } = request;
	const status: SubagentChildStopStatus = action === "pause" ? "paused" : "quit";
	const host = ctx.getAgentTaskHost?.();
	const live = liveTaskIds(host);
	const records = ownedRecords(ctx);
	const isLive = (record: OwnedChild) =>
		record.taskId !== undefined && (live.has(record.taskId) || isLiveOwnerlessChild(record.taskId));
	const isQueued = (record: OwnedChild) =>
		record.taskId !== undefined && (isQueuedSubagentChild(record.taskId) || isQueuedOwnerlessChild(record.taskId));
	let targets: OwnedChild[];
	if (request.all) {
		// Queued children are stopped first, so stopping a running sibling cannot free a slot that starts them.
		targets = [...records.values()]
			.filter(
				(record) => isLive(record) || isReleased(record) || (action === "quit" && stoppedAs(record) === "paused"),
			)
			.sort((a, b) => Number(isQueued(b)) - Number(isQueued(a)));
		if (targets.length === 0)
			return controlResult(`No running subagent children to ${action}.`, { action, children: [] });
	} else {
		const resolved = resolveRecord(records, request.id ?? "");
		if (typeof resolved === "string") return errorResult(action, resolved);
		if (!resolved)
			return errorResult(action, `Unknown subagent '${request.id}': this session launched no such child.`);
		targets = [resolved];
	}
	const children: SubagentRunControlChild[] = [];
	const lines: string[] = [];
	const failures: string[] = [];
	const reportLive = (record: SubagentChildRecord, stop: LiveChildStop) => {
		if (stop.kind === "failed") {
			failures.push(`Could not ${action} ${label(record)}: ${stop.reason}`);
			return;
		}
		if (stop.kind === "settled") {
			failures.push(
				`${label(record)} ${stop.status === "ok" ? "completed" : stop.status === "error" ? "failed" : "ended"} (${stop.status}) before it could be ${status}; there is nothing to ${action}.`,
			);
			return;
		}
		children.push(childDetails(record, status));
		lines.push(
			action === "pause"
				? `Paused ${label(record)} · awaiting resume. Its queued messages are held until resume; resume it with { action: "resume", id: "${record.childId}", message? }.`
				: `Quit ${label(record)}: paused · awaiting resume, as a quit workflow run is. It stays resumable with { action: "resume", id: "${record.childId}", message? }.`,
		);
	};
	const notRunning = (
		record: Pick<SubagentChildRecord, "agent" | "childId" | "intercomTarget" | "state" | "terminalStatus">,
	) =>
		failures.push(
			`${label(record)} is not running (${record.state === "terminal" ? (record.terminalStatus ?? "settled") : "not live in this process"}); there is nothing to ${action}.`,
		);
	for (const target of targets) {
		// One whose records left the session's window is read in full first, as this action needs all of it, and let go
		// once the action is done with it.
		const held = isArchivedChild(target) ? await holdFullRecordOf(ctx, target) : notHeld(target);
		try {
			const record = held.record;
			const key = childHoldKey(subagentChildOwner(ctx).sessionId, record.childId);
			if (isLive(record)) {
				reportLive(record, await stopLiveChild(deps, ctx, host, record, status));
				continue;
			}
			const stopped = stoppedAs(record);
			if (stopped && !(action === "quit" && stopped === "paused")) {
				children.push(childDetails(record, stopped));
				lines.push(`${label(record)} is already ${stopped}.`);
				continue;
			}
			if (!isReleased(record) && !stopped) {
				notRunning(record);
				continue;
			}
			// Nothing of it runs: stopping it only stops what would wake it. Results that arrive are kept for resume.
			const latest = await stopIdleChild(deps, ctx, record, status);
			if (latest.state !== "terminal" || latest.terminalStatus !== status) {
				// A wake or resume ran it again, or it ended first; a run of it live here is stopped like any running child.
				const running =
					latest.taskId !== undefined &&
					(liveTaskIds(host).has(latest.taskId) || isLiveOwnerlessChild(latest.taskId));
				if (running) reportLive(latest, await stopLiveChild(deps, ctx, host, latest, status));
				else notRunning(latest);
				continue;
			}
			children.push(childDetails(latest, status));
			if (stopped) {
				releasePausedChildHold(key);
				lines.push(
					`Quit paused ${label(latest)}: paused · awaiting resume. It stays resumable with { action: "resume", id: "${latest.childId}", message? }.`,
				);
				continue;
			}
			const parked = releasedChildReservation(latest);
			if (parked !== undefined) await reserveReleasedChildren(deps.pi.events, [parked]);
			lines.push(
				`${action === "pause" ? "Paused" : "Quit"} released ${label(latest)}: it is not woken any more, and results of the calls it waited on are kept for its resume. Resume it with { action: "resume", id: "${latest.childId}", message? }.`,
			);
		} finally {
			held.release();
		}
	}
	const text = [...lines, ...failures].join("\n");
	return controlResult(text, { action, children }, failures.length > 0 && children.length === 0);
}

/** What {@link unlessInterrupted} gives when the turn that asked for the work was interrupted first. */
const INTERRUPTED = Symbol("interrupted");

/**
 * `work`'s outcome, or {@link INTERRUPTED} once `signal` aborts first: an interrupted turn does not wait for run control
 * (#5485). The work itself goes on, and the child's records say how it went; a failure it ends with after the
 * interruption is not left unhandled.
 */
function unlessInterrupted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof INTERRUPTED> {
	if (signal === undefined) return work;
	const interrupted = Promise.withResolvers<typeof INTERRUPTED>();
	const interrupt = () => {
		work.catch(() => {});
		interrupted.resolve(INTERRUPTED);
	};
	if (signal.aborted) interrupt();
	else signal.addEventListener("abort", interrupt, { once: true });
	return Promise.race([work, interrupted.promise]).finally(() => signal.removeEventListener("abort", interrupt));
}

/** The answer of a resume its caller's turn interrupted: whether the resume was withdrawn, or had begun and goes on. */
function interruptedResume(record: SubagentChildRecord, withdrawn: boolean, message: string | undefined) {
	return errorResult(
		"resume",
		withdrawn
			? `Interrupted before ${label(record)} took the resume: it was withdrawn, and the child does not run it${message ? " or get your message" : ""}. Resume it again when you are ready.`
			: `Interrupted while ${label(record)} was being resumed: the resume had begun and goes on${message ? " with your message" : ""}.${record.worktree && !record.worktree.named ? " Any worktree cleanup continues in the background." : ""} subagent({ action: "status", id: "${record.childId}" }) shows how it went.`,
	);
}

function alreadyRunning(record: ChildLabel, taskId: string): SubagentToolResult {
	return errorResult("resume", `${label(record)} is already running as task ${taskId}; pause or quit it first.`);
}

function liveResumeAdmissions(ctx: ExtensionContext, owner: string): Map<string, AdmittedSubagentChild> {
	const live = new Map<string, AdmittedSubagentChild>();
	for (const child of liveOwnerlessAdmissions(owner)) live.set(child.childId, child);
	const host = ctx.getAgentTaskHost?.();
	if (!host) return live;
	const watched = host.watchOwnerTasks();
	if (!watched.ok) return live;
	try {
		for (const task of watched.value.snapshot.tasks) {
			if (task.kind !== "agent" || task.execution.kind === "settled") continue;
			const lease = host.resolveTask(task.ref.taskId);
			const child = lease.ok ? admittedSubagentChild(lease.value, owner) : undefined;
			if (child) live.set(child.childId, child);
		}
	} finally {
		watched.value.dispose();
	}
	return live;
}

async function resumeChild(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	request: SubagentRunControlRequest,
	signal?: AbortSignal,
): Promise<SubagentToolResult> {
	const action = "resume";
	if (request.all)
		return errorResult(action, "resume targets one child by id; all: true is only valid with pause or quit.");
	if (!request.id?.trim()) return errorResult(action, "resume needs the id of the child to resume.");
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	// Live handles can refuse a resume without their first saved record. Only a durable record can start a restore.
	const resolved = resolveRecord<OwnedChild | AdmittedSubagentChild>(
		ownedRecords(ctx),
		request.id,
		liveResumeAdmissions(ctx, ownerSessionId),
	);
	if (typeof resolved === "string") return errorResult(action, resolved);
	if (!resolved) return errorResult(action, `Unknown subagent '${request.id}': this session launched no such child.`);
	if ("ownerSessionId" in resolved) return alreadyRunning(resolved, resolved.taskId);
	const wakeKey = subagentWakeKey(ownerSessionId, resolved.childId);
	let child: OwnedChild = resolved;
	// A wake or another resume may be reopening the child right now. Wait only until it has, or has given up, never for
	// the run it starts: a reopened child is running, and resume refuses it as it refuses any running child (#5485).
	const reopenings = [
		() => (isReleasedChildWakeActive(wakeKey) ? releasedChildWakeDecided(wakeKey) : undefined),
		() => subagentChildRestoring(ownerSessionId, resolved.childId),
	];
	for (const reopening of reopenings) {
		const settled = reopening();
		if (settled === undefined) continue;
		// A sibling's save can still be pending after the relaunch. Esc ends only our wait, not that save.
		const readable = settled.then(() => subagentChildRecordsAppended(ownerSessionId));
		const check = await awaitResumeCheck(wakeKey, readable, signal);
		if (check === "interrupted")
			return errorResult(
				action,
				`Interrupted while ${label(resolved)} was being reopened, before it could be resumed: nothing was sent to it.`,
			);
		if (check !== "readable") return alreadyRunning(child, check.taskId);
		const admitted = liveResumeAdmissions(ctx, ownerSessionId).get(resolved.childId);
		if (admitted) return alreadyRunning(admitted, admitted.taskId);
		child = ownedRecords(ctx).get(resolved.childId) ?? resolved;
	}
	const terminalReason =
		child.state === "terminal" ? NON_RESUMABLE_STATUSES.get(child.terminalStatus ?? "") : undefined;
	if (terminalReason)
		return errorResult(
			action,
			`${label(child)} is terminal and cannot be resumed: ${terminalReason}. Launch a fresh subagent if its work is still needed.`,
		);
	let read: SubagentChildRecordHold;
	if (isArchivedChild(child)) {
		// One whose records left the session's window is read in full first, as resuming it needs all of it, and let go
		// once this resume is done with it.
		read = await holdFullRecordOf(ctx, child);
		// A wake or another resume may have begun reopening it meanwhile: this resume decides again, as it would then.
		if (
			isReleasedChildWakeActive(wakeKey) ||
			subagentChildRestoring(ownerSessionId, read.record.childId) !== undefined ||
			liveResumeAdmissions(ctx, ownerSessionId).has(read.record.childId)
		) {
			read.release();
			return resumeChild(deps, ctx, request, signal);
		}
	} else read = notHeld(child);
	const record = read.record;
	// A wake that did not reopen the child may still be finishing: the resume is queued behind it, not dropped.
	const waking = isReleasedChildWakeActive(wakeKey);
	const message = request.message?.trim() ? request.message : undefined;
	if (signal?.aborted) {
		read.release();
		return interruptedResume(record, true, message);
	}
	const interrupted = record.state === "running" || INTERRUPTED_STATUSES.has(record.terminalStatus ?? "");
	const resumeRequest =
		message && interrupted
			? { prompt: message, continuation: SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, message }
			: { prompt: message ?? SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, ...(message ? { message } : {}) };
	const queued =
		waking || isReleased(record) || ((record.waitingOn?.length ?? 0) > 0 && stoppedAs(record))
			? resumeReleasedChild(ownerSessionId, record.childId, resumeRequest, signal)
			: undefined;
	const resuming = queued ?? restoreSubagentChild(deps, ctx, record.childId, resumeRequest);
	// The resume is done with the child once it settles, also when an interrupted turn answered first and left it going
	// on: a child it ran again was recorded over the record read for it by then. A queued resume's wake keeps the record
	// it reads itself.
	void resuming.then(read.release, read.release);
	let outcome: SubagentChildRestoreOutcome | typeof INTERRUPTED;
	try {
		// A queued resume answers an interruption itself; a direct one cannot be withdrawn, and goes on.
		outcome = await (queued ?? unlessInterrupted(resuming, signal));
	} catch (error) {
		if (error instanceof ReleasedChildResumeInterruptedError)
			return interruptedResume(record, error.withdrawn, message);
		// A wake relaunched the child before it took this resume: it runs, so resume refuses it.
		if (error instanceof ReleasedChildResumeRunningError) return alreadyRunning(record, error.taskId);
		throw error;
	}
	if (outcome === INTERRUPTED) return interruptedResume(record, false, message);
	if (outcome.kind === "terminal") return errorResult(action, `${label(record)} is terminal and cannot be resumed.`);
	if (outcome.kind === "unrestorable")
		return errorResult(action, `${label(record)} could not be resumed: ${outcome.reason}.`);
	const intercom =
		outcome.intercomLive === true
			? " It is live on Intercom under the same name."
			: outcome.intercomLive === false
				? " It is still starting and has not registered on Intercom yet: messages sent to it wait for it and reach it before its first turn. Its result arrives as a task completion."
				: "";
	const heldMessages =
		record.heldMessages && record.heldMessages.taskId === record.taskId ? record.heldMessages.messages : [];
	if (outcome.fresh) {
		// It never started, so there is no session to resume: it starts on its launch, its task first (#4029).
		const sent = heldMessages[0] === record.launch?.task ? heldMessages.slice(1) : heldMessages;
		return controlResult(
			`Started ${label(record)} fresh with its task as task ${outcome.taskId}, since it stopped before it began${message ? ", with your message added to its task" : ""}.${sent.length > 0 ? " The messages it was sent and had not yet read are delivered after its task, once." : ""}${intercom}`,
			{
				action,
				children: [childDetails(record, "running", outcome.taskId)],
				...(message ? { message } : {}),
			},
		);
	}
	const held =
		heldMessages.length > 0
			? " The messages it had queued and not yet read when it stopped are delivered first, once."
			: "";
	return controlResult(
		`Resumed ${label(record)} from its own session as task ${outcome.taskId}${message ? (interrupted ? ", with your message delivered before it continues its interrupted turn" : ", with your message as its new prompt") : ""}.${held}${intercom}`,
		{
			action,
			children: [childDetails(record, "running", outcome.taskId)],
			...(message ? { message } : {}),
		},
	);
}
/** What `status` reads of a child; a child whose records left the session's window has no more, and holds nothing. */
type StatusFacts = Pick<
	SubagentChildRecord,
	"agent" | "childId" | "intercomTarget" | "state" | "terminalStatus" | "taskId" | "waitingOn" | "wakeFailure"
>;

function wakeFailureText(record: StatusFacts): string {
	const failure = currentWakeFailure(record);
	return failure === undefined ? "" : ` Its last wake failed: ${failure.reason} (${failure.code}). ${failure.hint}`;
}

/** How `status` shows a released child: what it waits on, and what wakes it. */
function releasedLine(record: StatusFacts): string {
	const calls = (record.waitingOn ?? []).map((call) => `${call.toolName} (${call.toolCallId})`).join(", ");
	return `${label(record)} released · waiting${calls ? ` on ${calls}` : ""}; it holds nothing and is not paused: it wakes by itself when that finishes or a message reaches it, and needs no resume. To wake it sooner, resume it with { action: "resume", id: "${record.childId}", message? }.${wakeFailureText(record)}`;
}

/** How `status` shows a child pause or quit stopped: paused and awaiting resume, as a quit workflow run shows. */
function awaitingResumeLine(record: StatusFacts): string {
	const how =
		record.terminalStatus === "quit"
			? "quit · paused · awaiting resume"
			: record.terminalStatus === SUBAGENT_CHILD_STAGE_PAUSED_STATUS
				? "paused with its workflow stage · awaiting resume"
				: "paused · awaiting resume";
	return `${label(record)} ${how}. Resume it with { action: "resume", id: "${record.childId}", message? }.${wakeFailureText(record)}`;
}

function wakeFailedLine(record: StatusFacts): string {
	return `${label(record)} keeps results its wake could not deliver. Resume it with { action: "resume", id: "${record.childId}", message? }.${wakeFailureText(record)}`;
}

function statusLines(record: StatusFacts): string[] {
	if (isReleased(record)) return [releasedLine(record)];
	if (stoppedAs(record)) return [awaitingResumeLine(record)];
	return currentWakeFailure(record) ? [wakeFailedLine(record)] : [];
}

/**
 * Whether the child `id` names was stopped so that it waits for a resume: paused, quit, or its last wake failed. A
 * released child is not: it wakes by itself.
 */
export function subagentChildStoppedForResume(ctx: ExtensionContext, id: string): boolean {
	const resolved = resolveRecord(ownedRecords(ctx), id);
	if (typeof resolved !== "object" || isReleased(resolved)) return false;
	return stoppedAs(resolved) !== undefined || currentWakeFailure(resolved) !== undefined;
}

/**
 * `status` lines for the paused or quit children this session launched: the one `id` names, or every one without an
 * id. Read from the session's child records, so they survive a restart.
 */
export function subagentChildrenAwaitingResume(ctx: ExtensionContext, id?: string): string[] {
	const records = ownedRecords(ctx);
	const failure = takeChildRecordFailure(subagentChildOwner(ctx).sessionId, id?.trim() ? id : undefined);
	// The message already names the code and the hint, and names the subagent when the failure has no child id (#5551).
	const failureLine =
		failure === undefined
			? undefined
			: failure.childId === undefined
				? failure.message
				: `Subagent ${failure.childId}: ${failure.message}`;
	if (id?.trim()) {
		const resolved = resolveRecord(records, id);
		return [...(typeof resolved === "object" ? statusLines(resolved) : []), ...(failureLine ? [failureLine] : [])];
	}
	return [...[...records.values()].flatMap(statusLines), ...(failureLine ? [failureLine] : [])];
}

/**
 * `subagent({ action: "pause" | "resume" | "quit" })` for the children this session launched. `signal` is the calling
 * turn's: when it is interrupted, the call answers at once instead of waiting for the children (#5485).
 */
export function controlSubagentChildren(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	request: SubagentRunControlRequest,
	signal?: AbortSignal,
): Promise<SubagentToolResult> {
	if (request.all && request.id)
		return Promise.resolve(errorResult(request.action, "Pass either id or all: true, not both."));
	if (!request.all && !request.id?.trim() && request.action !== "resume")
		return Promise.resolve(errorResult(request.action, `${request.action} needs the id of a child, or all: true.`));
	const owner = subagentChildOwnerOperations(deps.pi, ctx);
	deps = { ...deps, pi: owner.pi };
	ctx = owner.ctx;
	if (request.action === "resume") return resumeChild(deps, ctx, request, signal);
	const action = request.action;
	// A child that does not stop yet keeps its stop waiting: the interrupted turn ends, and the stop goes on.
	return unlessInterrupted(stopChildren(deps, ctx, { ...request, action }), signal).then((result) =>
		result === INTERRUPTED
			? errorResult(
					action,
					`Interrupted before ${action} finished: the stop was requested and goes on. subagent({ action: "status"${request.id ? `, id: "${request.id}"` : ""} }) shows where ${request.id ? "the child stands" : "each child stands"}.`,
				)
			: result,
	);
}

/**
 * Recovery, when a session is opened at startup or by resume, of the paused and quit children it launched, as
 * `resumeInFlight` selects: `ask` confirms once and lists them, `auto` resumes them, and each resumes through the
 * `resume` action. Workflow-stage children are never touched.
 * It never throws: a failure is reported as a warning, and `isCurrent` ends it once the session it began in is gone.
 */
export async function resumeAwaitingSubagentChildren(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	mode: ResumeInFlight,
	isCurrent: () => boolean,
): Promise<void> {
	if (mode === "never" || ctx.isPresentationOnly === true) return;
	if (isSubagentChildSession(ctx) || isWorkflowStageOrchestrationContext(ctx)) return;
	if (mode === "ask" && (ctx.hasUI === false || typeof ctx.ui?.confirm !== "function")) return;
	const notify = (message: string, type: "info" | "warning"): void => {
		try {
			ctx.ui?.notify?.(message, type);
		} catch {
			return;
		}
	};
	try {
		const awaiting = [...ownedRecords(ctx).values()].filter(
			(record) => record.owner.kind === "session" && stoppedAs(record),
		);
		if (awaiting.length === 0) return;
		if (
			mode === "ask" &&
			!(await ctx.ui.confirm(
				"Resume interrupted subagents?",
				`${awaiting.length} interrupted subagent(s) can resume from their own sessions:\n${awaiting.map((record) => `- ${label(record)}`).join("\n")}\nResume now? Choose No to leave them awaiting resume; resume one later with subagent({ action: "resume", id }).`,
			))
		)
			return;
		for (const record of awaiting) {
			if (!isCurrent()) return;
			const result = await controlSubagentChildren(deps, ctx, { action: "resume", id: record.childId });
			notify(
				result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
				result.isError ? "warning" : "info",
			);
		}
	} catch (error) {
		if (!isCurrent()) return;
		notify(
			`Subagent startup resume failed: ${String(error)}. Use subagent({ action: "resume", id }) to retry.`,
			"warning",
		);
	}
}
