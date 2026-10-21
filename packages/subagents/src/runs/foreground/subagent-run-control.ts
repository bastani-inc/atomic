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
import { inheritedIntercomGroup } from "../shared/intercom-group.js";
import { isLiveOwnerlessChild, isQueuedOwnerlessChild, stopOwnerlessChild } from "./ownerless-children.js";
import { parkRunWorktree, unparkRunWorktree } from "./run-worktrees.js";
import { childHoldKey, holdChildTargets, parkPausedChildHold, releasePausedChildHold } from "./subagent-child-hold.js";
import {
	findSubagentChildRecord,
	readSubagentChildRecords,
	recordSubagentChildStatus,
	requestSubagentChildStop,
	SUBAGENT_CHILD_GONE_STATUS,
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildRecord,
	type SubagentChildStopStatus,
	subagentChildOwner,
	subagentChildRecordsAppended,
	takeSubagentChildStop,
} from "./subagent-child-records.js";
import { restoreSubagentChild, type SubagentChildRestoreDeps } from "./subagent-child-restore.js";
import { isQueuedSubagentChild, stopQueuedSubagentChild } from "./task-execution.js";

/** The prompt a resumed child runs when `resume` carries no message, as a resumed workflow stage receives. */
export const SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT =
	"Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.";

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

function label(record: SubagentChildRecord): string {
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

function ownedRecords(ctx: ExtensionContext): Map<string, SubagentChildRecord> {
	return readSubagentChildRecords(ctx.sessionManager.getEntries(), subagentChildOwner(ctx).sessionId);
}

/** A child by its child id, launch task id, Intercom name, or the run id of a run that launched only that child. */
function resolveRecord(
	records: ReadonlyMap<string, SubagentChildRecord>,
	id: string,
): SubagentChildRecord | string | undefined {
	const direct = findSubagentChildRecord(records, id);
	if (direct) return direct;
	const inRun = [...records.values()].filter((record) => record.runId === id.trim());
	if (inRun.length === 1) return inRun[0];
	if (inRun.length > 1)
		return `Run ${id} launched ${inRun.length} children; target one by its child id: ${inRun.map((record) => record.childId).join(", ")}.`;
	return undefined;
}

/** How a settled child already stands for pause and quit: a child its workflow stage's pause stopped counts as paused. */
function stoppedAs(record: SubagentChildRecord): SubagentChildStopStatus | undefined {
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
		unparkRunWorktree(record.runId, record.index);
		return cancelled.error.message;
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
	const isLive = (record: SubagentChildRecord) =>
		record.taskId !== undefined && (live.has(record.taskId) || isLiveOwnerlessChild(record.taskId));
	const isQueued = (record: SubagentChildRecord) =>
		record.taskId !== undefined && (isQueuedSubagentChild(record.taskId) || isQueuedOwnerlessChild(record.taskId));
	let targets: SubagentChildRecord[];
	if (request.all) {
		// Queued children are stopped first, so stopping a running sibling cannot free a slot that starts them.
		targets = [...records.values()]
			.filter((record) => isLive(record) || (action === "quit" && stoppedAs(record) === "paused"))
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
	for (const record of targets) {
		const key = childHoldKey(subagentChildOwner(ctx).sessionId, record.childId);
		if (isLive(record)) {
			const stop = await stopLiveChild(deps, ctx, host, record, status);
			if (stop.kind === "failed") {
				failures.push(`Could not ${action} ${label(record)}: ${stop.reason}`);
				continue;
			}
			if (stop.kind === "settled") {
				failures.push(
					`${label(record)} ${stop.status === "ok" ? "completed" : stop.status === "error" ? "failed" : "ended"} (${stop.status}) before it could be ${status}; there is nothing to ${action}.`,
				);
				continue;
			}
			children.push(childDetails(record, status));
			lines.push(
				action === "pause"
					? `Paused ${label(record)} · awaiting resume. Its queued messages are held until resume; resume it with { action: "resume", id: "${record.childId}", message? }.`
					: `Quit ${label(record)}: paused · awaiting resume, as a quit workflow run is. It stays resumable with { action: "resume", id: "${record.childId}", message? }.`,
			);
			continue;
		}
		const stopped = stoppedAs(record);
		if (stopped) {
			if (action === "quit" && stopped === "paused") {
				releasePausedChildHold(key);
				await recordSubagentChildStatus(deps.pi, record, "quit");
				children.push(childDetails(record, "quit"));
				lines.push(
					`Quit paused ${label(record)}: paused · awaiting resume. It stays resumable with { action: "resume", id: "${record.childId}", message? }.`,
				);
				continue;
			}
			children.push(childDetails(record, stopped));
			lines.push(`${label(record)} is already ${stopped}.`);
			continue;
		}
		failures.push(
			`${label(record)} is not running (${record.state === "terminal" ? (record.terminalStatus ?? "settled") : "not live in this process"}); there is nothing to ${action}.`,
		);
	}
	const text = [...lines, ...failures].join("\n");
	return controlResult(text, { action, children }, failures.length > 0 && children.length === 0);
}

async function resumeChild(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	request: SubagentRunControlRequest,
): Promise<SubagentToolResult> {
	const action = "resume";
	if (request.all)
		return errorResult(action, "resume targets one child by id; all: true is only valid with pause or quit.");
	if (!request.id?.trim()) return errorResult(action, "resume needs the id of the child to resume.");
	const records = ownedRecords(ctx);
	const resolved = resolveRecord(records, request.id);
	if (typeof resolved === "string") return errorResult(action, resolved);
	if (!resolved) return errorResult(action, `Unknown subagent '${request.id}': this session launched no such child.`);
	const record = resolved;
	const terminalReason =
		record.state === "terminal" ? NON_RESUMABLE_STATUSES.get(record.terminalStatus ?? "") : undefined;
	if (terminalReason)
		return errorResult(
			action,
			`${label(record)} is terminal and cannot be resumed: ${terminalReason}. Launch a fresh subagent if its work is still needed.`,
		);
	if (
		record.taskId !== undefined &&
		(liveTaskIds(ctx.getAgentTaskHost?.()).has(record.taskId) || isLiveOwnerlessChild(record.taskId))
	)
		return errorResult(
			action,
			`${label(record)} is already running as task ${record.taskId}; pause or quit it first.`,
		);
	const message = request.message?.trim() ? request.message : undefined;
	const interrupted = record.state === "running" || INTERRUPTED_STATUSES.has(record.terminalStatus ?? "");
	const outcome = await restoreSubagentChild(
		deps,
		ctx,
		record.childId,
		message && interrupted
			? { prompt: message, continuation: SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, message }
			: { prompt: message ?? SUBAGENT_RUN_CONTROL_CONTINUATION_PROMPT, ...(message ? { message } : {}) },
	);
	if (outcome.kind === "terminal") return errorResult(action, `${label(record)} is terminal and cannot be resumed.`);
	if (outcome.kind === "unrestorable")
		return errorResult(action, `${label(record)} could not be resumed: ${outcome.reason}.`);
	const intercom =
		outcome.intercomLive === true
			? " It is live on Intercom under the same name."
			: outcome.intercomLive === false
				? " It has not reconnected to Intercom yet; its result still arrives as a task completion."
				: "";
	const held =
		record.heldMessages?.taskId === record.taskId
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
/** How `status` shows a child pause or quit stopped: paused and awaiting resume, as a quit workflow run shows. */
function awaitingResumeLine(record: SubagentChildRecord): string {
	const how =
		record.terminalStatus === "quit"
			? "quit · paused · awaiting resume"
			: record.terminalStatus === SUBAGENT_CHILD_STAGE_PAUSED_STATUS
				? "paused with its workflow stage · awaiting resume"
				: "paused · awaiting resume";
	return `${label(record)} ${how}. Resume it with { action: "resume", id: "${record.childId}", message? }.`;
}

/**
 * `status` lines for the paused or quit children this session launched: the one `id` names, or every one without an
 * id. Read from the session's child records, so they survive a restart.
 */
export function subagentChildrenAwaitingResume(ctx: ExtensionContext, id?: string): string[] {
	const records = ownedRecords(ctx);
	if (id?.trim()) {
		const resolved = resolveRecord(records, id);
		return typeof resolved === "object" && stoppedAs(resolved) ? [awaitingResumeLine(resolved)] : [];
	}
	return [...records.values()].filter((record) => stoppedAs(record)).map(awaitingResumeLine);
}

/** `subagent({ action: "pause" | "resume" | "quit" })` for the children this session launched. */
export function controlSubagentChildren(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	request: SubagentRunControlRequest,
): Promise<SubagentToolResult> {
	if (request.all && request.id)
		return Promise.resolve(errorResult(request.action, "Pass either id or all: true, not both."));
	if (!request.all && !request.id?.trim() && request.action !== "resume")
		return Promise.resolve(errorResult(request.action, `${request.action} needs the id of a child, or all: true.`));
	return request.action === "resume"
		? resumeChild(deps, ctx, request)
		: stopChildren(deps, ctx, { ...request, action: request.action });
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
