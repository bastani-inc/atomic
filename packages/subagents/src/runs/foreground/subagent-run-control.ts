import type { AgentTaskHost, ExtensionContext, TaskId } from "@bastani/atomic";
import {
	isSubagentChildSession,
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
import {
	childWorktreeFinishing,
	currentChildWorktreeNote,
	finishingWorktreeStatus,
	observeChildWorktreeAtReply,
	parkRunWorktree,
	pendingChildWorktreeRelease,
	unparkRunWorktree,
	WORKTREE_REPLY_WAIT_MS,
	worktreePublicationRevision,
} from "./run-worktrees.js";
import { indexSubagentChildOwner, observedSubagentRunIds } from "./subagent-child-card-state.js";
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
import { isFinishingWorktreeTask, isQueuedSubagentChild, stopQueuedSubagentChild } from "./task-execution.js";

/** The prompt a resumed child runs when `resume` carries no message. */
export const SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT =
	"Continue where you left off. If a pause interrupted a command or step you were running, redo or continue that step as needed. If you believe you are finished with your original task (or a redefined task if the user told you), stop.";

/** Settled children that can never be resumed: cancelled for good or reported gone (#3760). */
const NON_RESUMABLE_STATUSES: ReadonlyMap<string, string> = new Map([
	["killed", "it was cancelled for good (an owner or batch cancellation, or the removed kill action)"],
	[SUBAGENT_CHILD_GONE_STATUS, "it did not survive a restart and was reported gone"],
]);

/** Children stopped part-way through a turn: resume continues that turn, after any steer message. */
const INTERRUPTED_STATUSES: ReadonlySet<string> = new Set(["paused", "quit", "interrupted"]);

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
	record: SubagentChildRecord,
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

/** The session state `ownedRecords` read its records from; any append, branch change or history load replaces it. */
interface OwnedRecordsRead {
	readonly sessionId: string;
	readonly owner: string;
	readonly lastSeq: number;
	readonly leafId: string | null;
	readonly fullHistory: boolean;
	readonly publicationRevision: number;
	readonly records: ReadonlyMap<string, SubagentChildRecord>;
}

const ownedRecordReads = new WeakMap<object, OwnedRecordsRead>();

/**
 * The children this session launched, read once per session state. A subagent's chat asks on every frame whether its
 * child is stopped or read-only, and folding a long session's every entry for each frame cost a stage of work per
 * paint.
 */
function ownedRecords(ctx: ExtensionContext): ReadonlyMap<string, SubagentChildRecord> {
	const manager = ctx.sessionManager;
	const owner = subagentChildOwner(ctx).sessionId;
	if (
		typeof manager.getLastSeq !== "function" ||
		typeof manager.getLeafId !== "function" ||
		typeof manager.hasFullHistory !== "function"
	)
		return readSubagentChildRecords(manager.getEntries(), owner);
	const state = {
		sessionId: manager.getSessionId(),
		owner,
		lastSeq: manager.getLastSeq(),
		leafId: manager.getLeafId(),
		fullHistory: manager.hasFullHistory(),
		publicationRevision: worktreePublicationRevision(),
	};
	const read = ownedRecordReads.get(manager);
	if (
		read !== undefined &&
		read.sessionId === state.sessionId &&
		read.owner === state.owner &&
		read.lastSeq === state.lastSeq &&
		read.leafId === state.leafId &&
		read.fullHistory === state.fullHistory &&
		read.publicationRevision === state.publicationRevision
	)
		return read.records;
	const records = readSubagentChildRecords(manager.getEntries(), owner);
	ownedRecordReads.set(manager, { ...state, records });
	return records;
}

/**
 * The child an earlier record of this session gave task `taskId`: a resumed child runs as a new task, and its record
 * keeps only the latest task id, while the earlier task's chat still continues it.
 */
function childIdOfEarlierTask(ctx: ExtensionContext, taskId: string): string | undefined {
	const owner = subagentChildOwner(ctx).sessionId;
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

/** A script can rediscover its session's children even after their original host tasks are gone. */
export async function subagentScriptChildren(ctx: ExtensionContext, id?: string) {
	const owner = subagentChildOwner(ctx).sessionId;
	await subagentChildRecordsAppended(owner);
	const records = ownedRecords(ctx);
	const live = liveResumeAdmissions(ctx, owner);
	const all = new Map<string, SubagentChildRecord | AdmittedSubagentChild>([...records, ...live]);
	const found = id === undefined ? undefined : resolveRecord(all, id);
	if (id !== undefined && typeof found !== "object")
		throw new Error(typeof found === "string" ? found : `No child found in this session for '${id}'.`);
	const children = typeof found === "object" ? [found] : [...all.values()];
	return children.map((record) => {
		const saved = records.get(record.childId);
		const tree = saved?.worktree && !saved.worktree.named && saved.taskId === record.taskId ? saved : undefined;
		let state: string;
		if (tree && finishingWorktreeStatus(tree)) state = "finishing";
		else if ("ownerSessionId" in record) state = isQueuedSubagentChild(record.taskId) ? "starting" : "running";
		else if (record.state === "running")
			state = subagentChildRestoring(owner, record.childId) ? "starting" : "awaiting-resume";
		else if (stoppedAs(record) || record.terminalStatus === "interrupted") state = "awaiting-resume";
		else if (isReleased(record)) state = "released";
		else if (record.terminalStatus === SUBAGENT_CHILD_GONE_STATUS) state = "gone";
		else if (record.terminalStatus === "ok") state = "completed";
		else if (record.terminalStatus === "error") state = "failed";
		else state = "cancelled";
		const worktreeNote =
			tree && (state === "finishing" || tree.state === "terminal")
				? currentChildWorktreeNote(tree.runId, tree.index)
				: undefined;
		const resumable =
			state !== "running" &&
			state !== "starting" &&
			state !== "finishing" &&
			"state" in record &&
			!NON_RESUMABLE_STATUSES.has(record.terminalStatus ?? "");
		return {
			childId: record.childId,
			agent: record.agent,
			state,
			resumable,
			...(worktreeNote ? { worktreeNote } : {}),
			...(record.taskId ? { taskId: record.taskId } : {}),
			...(record.intercomTarget ? { intercomTarget: record.intercomTarget } : {}),
			...(resumable ? { resumeCall: { action: "resume", id: record.childId } } : {}),
		};
	});
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
function isReleased(record: SubagentChildRecord): boolean {
	return record.state === "terminal" && record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS;
}

/** How a settled child already stands for pause and quit. */
function stoppedAs(record: SubagentChildRecord): SubagentChildStopStatus | undefined {
	if (record.state !== "terminal") return undefined;
	if (record.terminalStatus === "paused") return "paused";
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
	finishing?: Promise<string | undefined>,
): Promise<{ readonly failure?: string; readonly neverStarted?: boolean; readonly outcome?: string }> {
	const taskId = record.taskId as TaskId;
	if (isFinishingWorktreeTask(taskId)) {
		// The child chose its outcome before the stop reached it. It is not cancellable during Git.
		return { outcome: await (finishing ?? waitForSettlement(host, taskId).then(() => undefined)) };
	}
	requestSubagentChildStop(taskId, status);
	// It stays resumable: its worktree is kept if it has unsaved work when its run's worktrees are removed.
	parkRunWorktree(record.runId, record.index);
	// A typed resumable stop: its parent is told it is paused and awaiting resume, never that it ended.
	const cancelled = await host.cancelTask(taskId, status === "quit" ? "quit" : "pause");
	if (!cancelled.ok) {
		takeSubagentChildStop(taskId);
		void unparkRunWorktree(record.runId, record.index);
		return { failure: cancelled.error.message };
	}
	// It settled on its own before the stop reached it: nothing takes the stop, and its worktree is not stopped (#5172).
	if (cancelled.value.decision !== "cancellation-requested") {
		takeSubagentChildStop(taskId);
		void unparkRunWorktree(record.runId, record.index);
		return {};
	}
	// A child cancelled while still queued never starts, so nothing else records how it stopped.
	const queued = stopQueuedSubagentChild(taskId, status);
	const outcome = finishing ? await finishing : undefined;
	if (!outcome) await waitForSettlement(host, taskId);
	if (queued) {
		takeSubagentChildStop(taskId);
		if (!finishing) await recordSubagentChildStatus(deps.pi, record, status);
	}
	return { neverStarted: queued, outcome };
}

type LiveChildStop =
	| { readonly kind: "stopped"; readonly neverStarted: boolean }
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
	const finishing = childWorktreeFinishing(record);
	let outcome: string | undefined;
	let neverStarted = false;
	if (record.taskId !== undefined && isLiveOwnerlessChild(record.taskId)) {
		neverStarted = isQueuedOwnerlessChild(record.taskId);
		const settled = stopOwnerlessChild(record.taskId, status);
		if (finishing) outcome = await finishing;
		if (!outcome) await settled;
	} else if (host) {
		const stop = await stopHostChild(deps, host, record, status, finishing);
		outcome = stop.outcome;
		if (stop.failure) return { kind: "failed", reason: stop.failure };
		neverStarted = stop.neverStarted === true;
	} else return { kind: "failed", reason: "it is not running in this process" };
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	const key = childHoldKey(ownerSessionId, record.childId);
	await subagentChildRecordsAppended(ownerSessionId);
	const settled = ownedRecords(ctx).get(record.childId);
	if (
		(outcome && outcome !== status) ||
		(settled?.state === "terminal" && settled.taskId === record.taskId && settled.terminalStatus !== status)
	) {
		// It is not paused, so nothing sent to it waits for a resume.
		releasePausedChildHold(key);
		return { kind: "settled", status: outcome ?? settled?.terminalStatus ?? "settled" };
	}
	if (status === "paused") {
		const hold = await holdChildTargets(
			deps.pi.events,
			record,
			record.intercomGroup ?? inheritedIntercomGroup(ctx),
		).catch(() => undefined);
		if (hold) parkPausedChildHold(key, hold);
	}
	return { kind: "stopped", neverStarted };
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
	onWorktreeTarget: () => void,
): Promise<SubagentToolResult> {
	const { action } = request;
	const deadline = Date.now() + WORKTREE_REPLY_WAIT_MS;
	const status: SubagentChildStopStatus = action === "pause" ? "paused" : "quit";
	const host = ctx.getAgentTaskHost?.();
	const live = liveTaskIds(host);
	const records = ownedRecords(ctx);
	const isLive = (record: SubagentChildRecord) =>
		!finishingWorktreeStatus(record) &&
		record.taskId !== undefined &&
		(live.has(record.taskId) || isLiveOwnerlessChild(record.taskId));
	const isQueued = (record: SubagentChildRecord) =>
		record.taskId !== undefined && (isQueuedSubagentChild(record.taskId) || isQueuedOwnerlessChild(record.taskId));
	let targets: SubagentChildRecord[];
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
	const trees = targets.filter((record) => record.worktree && !record.worktree.named);
	if (trees.length) onWorktreeTarget();
	const rows = targets.map(() => ({
		children: [] as SubagentRunControlChild[],
		lines: [] as string[],
		failures: [] as string[],
		live: undefined as { record: SubagentChildRecord; outcome: LiveChildStop } | undefined,
	}));
	const reportLive = (
		{ children, lines, failures }: (typeof rows)[number],
		record: SubagentChildRecord,
		stop: LiveChildStop,
	) => {
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
		if (stop.neverStarted && record.worktree && !record.worktree.named)
			lines.push(`${label(record)} never started; no child process ran in its worktree.`);
		lines.push(
			action === "pause"
				? `Paused ${label(record)} · awaiting resume. Its queued messages are held until resume; resume it with { action: "resume", id: "${record.childId}", message? }.`
				: `Quit ${label(record)}: paused · awaiting resume. It stays resumable with { action: "resume", id: "${record.childId}", message? }.`,
		);
	};
	for (const [index, record] of targets.entries()) {
		const row = rows[index]!;
		const { children, lines, failures } = row;
		const notRunning = (child: SubagentChildRecord) =>
			failures.push(
				`${label(child)} is not running (${finishingWorktreeStatus(child) ?? (child.state === "terminal" ? (child.terminalStatus ?? "settled") : "not live in this process")}); there is nothing to ${action}.`,
			);
		const stopLive = async (child: SubagentChildRecord) => {
			// Stop confirmations, including the actual Intercom reservation, stay ordered.
			// For a managed child only its directory work can overlap the next stop.
			row.live = { record: child, outcome: await stopLiveChild(deps, ctx, host, child, status) };
		};
		if (isLive(record)) {
			await stopLive(record);
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
			if (running) await stopLive(latest);
			else notRunning(latest);
			continue;
		}
		children.push(childDetails(latest, status));
		if (stopped) {
			releasePausedChildHold(childHoldKey(subagentChildOwner(ctx).sessionId, record.childId));
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
	}
	// Broker acknowledgements and later targets can yield while a sibling starts the batch sweep.
	const notes = trees.length
		? await Promise.all(
				trees.map(async (record) => {
					const note = await observeChildWorktreeAtReply(record.runId, record.index, deadline);
					return note ? `${label(record)}: ${note}` : undefined;
				}),
			)
		: [];
	for (const row of rows) {
		if (!row.live) continue;
		const { record, outcome } = row.live;
		if (outcome.kind !== "failed" && childWorktreeFinishing(record)) {
			row.children.push(childDetails(record, "finishing"));
			row.lines.push(`${label(record)} is finishing; check status before removing its worktree.`);
		} else reportLive(row, record, outcome);
	}
	const children = rows.flatMap((row) => row.children);
	const lines = rows.flatMap((row) => row.lines);
	const failures = rows.flatMap((row) => row.failures);
	const worktreeNotes = notes.filter((note) => note !== undefined);
	const text = [...lines, ...failures, ...worktreeNotes].join("\n");
	return controlResult(
		text,
		{ action, children, ...(worktreeNotes.length ? { worktreeNotes } : {}) },
		failures.length > 0 && children.length === 0,
	);
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
	const resolved = resolveRecord<SubagentChildRecord | AdmittedSubagentChild>(
		ownedRecords(ctx),
		request.id,
		liveResumeAdmissions(ctx, ownerSessionId),
	);
	if (typeof resolved === "string") return errorResult(action, resolved);
	if (!resolved) return errorResult(action, `Unknown subagent '${request.id}': this session launched no such child.`);
	if ("ownerSessionId" in resolved) {
		const saved = ownedRecords(ctx).get(resolved.childId);
		const closing = saved && saved.taskId === resolved.taskId && pendingChildWorktreeRelease(saved);
		if (!saved || !closing) return alreadyRunning(resolved, resolved.taskId);
		// This execution already stopped. A resume is still accepted, but cannot reuse its checkout
		// until the old execution releases it. Recheck live admissions in case another resume won.
		const host = ctx.getAgentTaskHost?.();
		const joined = closing.then(() =>
			!signal?.aborted && host
				? host.waitForTask(resolved.taskId as TaskId, undefined, undefined, signal)
				: undefined,
		);
		if (
			(await unlessInterrupted(
				joined.then(() => undefined),
				signal,
			)) === INTERRUPTED ||
			signal?.aborted
		)
			return interruptedResume(saved, true, request.message);
		return resumeChild(deps, ctx, request, signal);
	}
	const wakeKey = subagentWakeKey(ownerSessionId, resolved.childId);
	let record = resolved;
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
		if (check !== "readable") return alreadyRunning(record, check.taskId);
		const admitted = liveResumeAdmissions(ctx, ownerSessionId).get(resolved.childId);
		if (admitted) return alreadyRunning(admitted, admitted.taskId);
		record = ownedRecords(ctx).get(resolved.childId) ?? resolved;
	}
	const terminalReason =
		record.state === "terminal" ? NON_RESUMABLE_STATUSES.get(record.terminalStatus ?? "") : undefined;
	if (terminalReason)
		return errorResult(
			action,
			`${label(record)} is terminal and cannot be resumed: ${terminalReason}. Launch a fresh subagent if its work is still needed.`,
		);
	// A wake that did not reopen the child may still be finishing: the resume is queued behind it, not dropped.
	const waking = isReleasedChildWakeActive(wakeKey);
	const message = request.message?.trim() ? request.message : undefined;
	if (signal?.aborted) return interruptedResume(record, true, message);
	const interrupted = record.state === "running" || INTERRUPTED_STATUSES.has(record.terminalStatus ?? "");
	const resumeRequest =
		message && interrupted
			? { prompt: message, continuation: SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, message }
			: { prompt: message ?? SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, ...(message ? { message } : {}) };
	const queued =
		waking || isReleased(record) || ((record.waitingOn?.length ?? 0) > 0 && stoppedAs(record))
			? resumeReleasedChild(ownerSessionId, record.childId, resumeRequest, signal)
			: undefined;
	let outcome: SubagentChildRestoreOutcome | typeof INTERRUPTED;
	try {
		// A queued resume answers an interruption itself; a direct one cannot be withdrawn, and goes on.
		outcome = await (queued ??
			unlessInterrupted(restoreSubagentChild(deps, ctx, record.childId, resumeRequest), signal));
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
function wakeFailureText(record: SubagentChildRecord): string {
	const failure = currentWakeFailure(record);
	return failure === undefined ? "" : ` Its last wake failed: ${failure.reason} (${failure.code}). ${failure.hint}`;
}

/** How `status` shows a released child: what it waits on, and what wakes it. */
function releasedLine(record: SubagentChildRecord): string {
	const calls = (record.waitingOn ?? []).map((call) => `${call.toolName} (${call.toolCallId})`).join(", ");
	return `${label(record)} released · waiting${calls ? ` on ${calls}` : ""}; it holds nothing and is not paused: it wakes by itself when that finishes or a message reaches it, and needs no resume. To wake it sooner, resume it with { action: "resume", id: "${record.childId}", message? }.${wakeFailureText(record)}`;
}

/** How `status` shows a child pause or quit stopped: paused and awaiting resume. */
function awaitingResumeLine(record: SubagentChildRecord): string {
	const how = record.terminalStatus === "quit" ? "quit · paused · awaiting resume" : "paused · awaiting resume";
	return `${label(record)} ${how}. Resume it with { action: "resume", id: "${record.childId}", message? }.${wakeFailureText(record)}`;
}

function wakeFailedLine(record: SubagentChildRecord): string {
	return `${label(record)} keeps results its wake could not deliver. Resume it with { action: "resume", id: "${record.childId}", message? }.${wakeFailureText(record)}`;
}

function statusLines(record: SubagentChildRecord): string[] {
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
	let worktreeNotice = "";
	const stopping = stopChildren(deps, ctx, { ...request, action }, () => {
		worktreeNotice = " Any worktree cleanup continues in the background.";
	});
	return unlessInterrupted(stopping, signal).then((result) =>
		result === INTERRUPTED
			? errorResult(
					action,
					`Interrupted before ${action} finished: the stop was requested and goes on.${worktreeNotice} subagent({ action: "status"${request.id ? `, id: "${request.id}"` : ""} }) shows where ${request.id ? "the child stands" : "each child stands"}.`,
				)
			: result,
	);
}

/**
 * Recovery, when a session is opened at startup or by resume, of the paused and quit children it launched, as
 * `resumeInFlight` selects: `ask` confirms once and lists them, `auto` resumes them, and each resumes through the
 * `resume` action.
 * It never throws: a failure is reported as a warning, and `isCurrent` ends it once the session it began in is gone.
 */
export async function resumeAwaitingSubagentChildren(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	mode: ResumeInFlight,
	isCurrent: () => boolean,
): Promise<void> {
	if (mode === "never" || ctx.isPresentationOnly === true) return;
	if (isSubagentChildSession(ctx)) return;
	if (mode === "ask" && (ctx.hasUI === false || typeof ctx.ui?.confirm !== "function")) return;
	const notify = (message: string, type: "info" | "warning"): void => {
		try {
			ctx.ui?.notify?.(message, type);
		} catch {
			return;
		}
	};
	try {
		const awaiting = [...ownedRecords(ctx).values()].filter(stoppedAs);
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
