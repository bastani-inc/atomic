import type { AgentTaskHost, ExtensionContext, TaskId } from "@bastani/atomic";
import type {
	SubagentRunControlAction,
	SubagentRunControlChild,
	SubagentRunControlDetails,
	SubagentToolResult,
} from "../../shared/types.js";
import { inheritedIntercomGroup } from "../shared/intercom-group.js";
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

async function stopLiveChild(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	host: AgentTaskHost,
	record: SubagentChildRecord,
	status: SubagentChildStopStatus,
): Promise<string | undefined> {
	const taskId = record.taskId as TaskId;
	requestSubagentChildStop(taskId, status);
	// It stays resumable: its worktree is kept if it has unsaved work when its run's worktrees are removed.
	parkRunWorktree(record.runId, record.index);
	const cancelled = await host.cancelTask(taskId, "parent-handoff");
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
	if (status === "paused") {
		const hold = await holdChildTargets(
			deps.pi.events,
			record,
			record.intercomGroup ?? inheritedIntercomGroup(ctx),
		).catch(() => undefined);
		if (hold) parkPausedChildHold(childHoldKey(subagentChildOwner(ctx).sessionId, record.childId), hold);
	}
	return undefined;
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
	const isLive = (record: SubagentChildRecord) => record.taskId !== undefined && live.has(record.taskId);
	const isQueued = (record: SubagentChildRecord) =>
		record.taskId !== undefined && isQueuedSubagentChild(record.taskId);
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
		if (host && isLive(record)) {
			const failure = await stopLiveChild(deps, ctx, host, record, status);
			if (failure) {
				failures.push(`Could not ${action} ${label(record)}: ${failure}`);
				continue;
			}
			children.push(childDetails(record, status));
			lines.push(
				action === "pause"
					? `Paused ${label(record)}. Its queued messages are held until resume; resume it with { action: "resume", id: "${record.childId}", message? }.`
					: `Quit ${label(record)}. It stays resumable with { action: "resume", id: "${record.childId}", message? }.`,
			);
			continue;
		}
		const stopped = stoppedAs(record);
		if (stopped) {
			if (action === "quit" && stopped === "paused") {
				releasePausedChildHold(key);
				await recordSubagentChildStatus(deps.pi, record, "quit");
				children.push(childDetails(record, "quit"));
				lines.push(`Quit paused ${label(record)}. It stays resumable.`);
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
	if (record.taskId !== undefined && liveTaskIds(ctx.getAgentTaskHost?.()).has(record.taskId))
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
	return controlResult(
		`Resumed ${label(record)} from its own session as task ${outcome.taskId}${message ? (interrupted ? ", with your message delivered before it continues its interrupted turn" : ", with your message as its new prompt") : ""}.${intercom}`,
		{
			action,
			children: [childDetails(record, "running", outcome.taskId)],
			...(message ? { message } : {}),
		},
	);
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
