import { randomUUID } from "node:crypto";
import {
	type AgentTaskHost,
	type AgentWakeDispatcher,
	agentWakeDispatcher,
	type OperationId,
	ranOnModelLine,
	type WaitPolicy,
} from "@bastani/atomic";
import type {
	Cleanup,
	ModelParallelResponse,
	ModelSingleResponse,
	Result,
	TaskId,
	TaskRecord,
	TaskResult,
	WaitOutcome,
	YieldError,
	YieldReason,
} from "../../../../coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../../../coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../agents/agents.js";
import { taskRecordModel } from "../../shared/model-info.js";
import type { RunSyncOptions, SingleResult, SubagentToolResult } from "../../shared/types.js";
import { getSingleResultOutput } from "../../shared/utils.js";
import { launchRequestedModel } from "../shared/model-fallback.js";
import { reserveReleasedChildTargets } from "./released-child-reservations.js";
import {
	forwardDetachedResults,
	routeReleasedChildShellCompletions,
	subagentReleasePolicy,
	subagentWakeKey,
	wakeReleasedChildWithHeldResults,
} from "./released-children.js";
import {
	claimRunWorktree,
	holdRunWorktree,
	parkRunWorktree,
	runWorktreeRecord,
	unparkRunWorktree,
} from "./run-worktrees.js";
import { subagentChildRecordOf } from "./subagent-child-card-state.js";
import {
	pendingMessagesOfResult,
	SUBAGENT_CHILD_RELEASED_STATUS,
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildLaunch,
	type SubagentChildPendingMessages,
	type SubagentChildRecordInput,
	type SubagentChildRecordSink,
	subagentChildId,
	subagentChildInheritance,
	subagentChildLaunch,
	subagentChildModelChoice,
	subagentChildRecordsAppended,
	takeSubagentChildStop,
} from "./subagent-child-records.js";
import type { SubagentExecutorRuntimeDeps } from "./subagent-executor-types.js";
import { INLINE_TASK_OUTPUT_MAX_BYTES, retainedTaskOutput, retainTaskOutput } from "./task-output-retention.js";

export { INLINE_TASK_OUTPUT_MAX_BYTES } from "./task-output-retention.js";

/** Project explicit user stops without changing the shared host cancellation record. */
export function subagentTaskResultLabel(result: TaskResult): string {
	if (result.kind === "cancelled" && result.cause === "user") return "killed (non-resumable)";
	// A quit or paused child awaits resume, as a quit workflow run does.
	if (result.kind === "cancelled" && (result.cause === "pause" || result.cause === "quit"))
		return "paused · awaiting resume";
	return result.kind;
}

export function subagentTaskResponseText(response: ModelSingleResponse | ModelParallelResponse): string {
	const outcomes = response.kind === "parallel" ? response.slots.map((slot) => slot.outcome) : [response];
	const killed = outcomes.filter(
		(outcome) =>
			outcome.kind === "admitted" &&
			outcome.observation.kind === "settled" &&
			subagentTaskResultLabel(outcome.observation.result) === "killed (non-resumable)",
	);
	return `${killed.length ? `${killed.length} killed. These children cannot be resumed. Underlying host response:\n` : ""}${JSON.stringify(response)}`;
}

export type SettledTaskOutput = { taskId: TaskId; result: TaskResult };

export function settledOutputsFromResponse(response: ModelSingleResponse | ModelParallelResponse): SettledTaskOutput[] {
	const outcomes = response.kind === "parallel" ? response.slots.map((slot) => slot.outcome) : [response];
	return outcomes.flatMap((outcome) =>
		outcome.kind === "admitted" && outcome.observation.kind === "settled"
			? [{ taskId: outcome.observation.taskId, result: outcome.observation.result }]
			: [],
	);
}

export function settledOutputsFromRecords(records: readonly TaskRecord[]): SettledTaskOutput[] {
	return records.flatMap((record) =>
		record.execution.kind === "settled" ? [{ taskId: record.ref.taskId, result: record.execution.result }] : [],
	);
}

function settledOutputSection(
	taskId: TaskId,
	label: string,
	output: {
		head: string;
		shown: number;
		total: number;
		path?: string;
		requestedPath?: string;
		saveError?: string;
	},
	ranOn: string | undefined,
): string {
	const truncated =
		output.shown < output.total
			? `, first ${output.shown} shown${output.path ? "; read the full output file for the rest" : ""}`
			: "";
	const lines = [`Output of ${taskId} (${label}, ${output.total} bytes${truncated}):`];
	if (ranOn) lines.push(ranOn);
	if (output.requestedPath) lines.push(`Requested output: ${output.requestedPath}`);
	if (output.saveError) lines.push(`Output file error: ${output.saveError}`);
	if (output.path) lines.push(`Full output: ${output.path}`);
	lines.push(output.head);
	return lines.join("\n");
}

async function readSettledOutput(
	host: AgentTaskHost,
	settled: SettledTaskOutput,
	record: TaskRecord | undefined,
): Promise<string | undefined> {
	const output = settled.result.output;
	if (!output) return undefined;
	const label = subagentTaskResultLabel(settled.result);
	// A child that ran on another model than its launch asked for says so beside its output (#4188).
	const ranOn = ranOnModelLine(record);
	const kept = retainedTaskOutput(output.ownerId, output.taskId);
	if (kept) {
		return settledOutputSection(
			settled.taskId,
			label,
			{
				...kept,
				shown: Math.min(kept.totalBytes, INLINE_TASK_OUTPUT_MAX_BYTES),
				total: kept.totalBytes,
			},
			ranOn,
		);
	}
	const unavailable = (reason: string) => `Output of ${settled.taskId} (${label}) is unavailable: ${reason}`;
	const lease = host.resolveTask(settled.taskId);
	if (!lease.ok) return unavailable(lease.error.message);
	try {
		const page = await host.ownerBinding.supervisor.readTaskOutput(lease.value, {
			start: "0",
			maximumBytes: INLINE_TASK_OUTPUT_MAX_BYTES,
		});
		if (!page.ok) return unavailable(page.error.message);
		const decoder = new TextDecoder();
		const head =
			page.value.chunks.map((chunk) => decoder.decode(chunk.bytes, { stream: true })).join("") + decoder.decode();
		const shown = page.value.chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
		return settledOutputSection(settled.taskId, label, { head, shown, total: Number(output.byteCount) }, ranOn);
	} catch (error) {
		return unavailable(error instanceof Error ? error.message : String(error));
	}
}

/** Resolve settled `output:<taskId>` references into readable text for the model (#3294). */
export async function settledTaskOutputText(
	host: AgentTaskHost | undefined,
	settled: readonly SettledTaskOutput[],
): Promise<string> {
	if (!host || settled.length === 0) return "";
	const records = ownerTaskRecords(new Set(settled.map((entry) => entry.taskId)), host);
	const sections = await Promise.all(
		settled.map((entry) =>
			readSettledOutput(
				host,
				entry,
				records.find((record) => record.ref.taskId === entry.taskId),
			),
		),
	);
	const present = sections.filter((section): section is string => section !== undefined);
	return present.length ? `\n\n${present.join("\n\n")}` : "";
}

export function taskToolResult(response: ModelSingleResponse, host?: AgentTaskHost): SubagentToolResult {
	return {
		content: [{ type: "text", text: subagentTaskResponseText(response) }],
		details: {
			mode: "single",
			results: [],
			taskResponse: response,
			taskRecords: taskResponseRecords(response, host),
		},
		...(response.kind === "unstarted" ? { isError: true } : {}),
	};
}

/** A launch result whose settled `output:<taskId>` references are resolved into readable text. */
export async function taskToolResultWithOutput(
	response: ModelSingleResponse,
	host?: AgentTaskHost,
): Promise<SubagentToolResult> {
	const result = taskToolResult(response, host);
	const outputText = await settledTaskOutputText(host, settledOutputsFromResponse(response));
	if (!outputText) return result;
	return {
		...result,
		content: [{ type: "text", text: `${subagentTaskResponseText(response)}${outputText}` }],
	};
}

export async function parallelTaskToolResultWithOutput(
	response: ModelParallelResponse,
	host?: AgentTaskHost,
): Promise<SubagentToolResult> {
	return {
		content: [
			{
				type: "text",
				text: `${subagentTaskResponseText(response)}${await settledTaskOutputText(host, settledOutputsFromResponse(response))}`,
			},
		],
		details: {
			mode: "parallel",
			results: [],
			taskResponse: response,
			taskRecords: taskResponseRecords(response, host),
		},
	};
}

/** Snapshot execution metadata for receipt playback, scoped to this response only. */
export function taskResponseRecords(
	response: ModelSingleResponse | ModelParallelResponse,
	host?: AgentTaskHost,
): TaskRecord[] {
	const outcomes = response.kind === "parallel" ? response.slots.map((slot) => slot.outcome) : [response];
	return ownerTaskRecords(
		new Set(outcomes.flatMap((outcome) => (outcome.kind === "admitted" ? [outcome.observation.taskId] : []))),
		host,
	);
}

/** The owner's current records of the tasks `ids` names. */
function ownerTaskRecords(ids: ReadonlySet<TaskId>, host: AgentTaskHost | undefined): TaskRecord[] {
	const watched = host?.watchOwnerTasks();
	if (!watched?.ok) return [];
	try {
		return watched.value.snapshot.tasks.filter((task) => ids.has(task.ref.taskId));
	} finally {
		watched.value.dispose();
	}
}

/** How a child that pause or quit stopped before the host dispatched it is started later, on its original launch. */
export interface QueuedSubagentChildStart {
	/** Whether its original launch had Intercom supervisor authorization. */
	readonly usesIntercom: boolean;
	start(launch: {
		readonly host: AgentTaskHost;
		readonly recordChild: SubagentChildRecordSink;
		/** Delivered after its original task, which it never started. */
		readonly message?: string;
		readonly supervisorAuthorization?: RunSyncOptions["supervisorAuthorization"];
		readonly onTerminal: () => void;
	}): Promise<ModelSingleResponse>;
}

/** Children the host admitted but has not dispatched yet, by task id; `stopped` once they never will be. */
const queuedChildren = new Map<string, { readonly start: QueuedSubagentChildStart; stopped: boolean }>();

/** Whether the host admitted this task but has not dispatched it yet. */
export function isQueuedSubagentChild(taskId: string): boolean {
	return queuedChildren.get(taskId)?.stopped === false;
}

/**
 * Call after cancelling a task: whether it was still queued. A cancelled task is never dispatched, so nothing records
 * how it stopped; the caller records it, and {@link takeStoppedQueuedSubagentChild} later starts it.
 */
export function stopQueuedSubagentChild(taskId: string): boolean {
	const queued = queuedChildren.get(taskId);
	if (queued?.stopped !== false) return false;
	queued.stopped = true;
	return true;
}

/** Take how to start a child that was stopped before it started, while this process still has it. */
export function takeStoppedQueuedSubagentChild(taskId: string): QueuedSubagentChildStart | undefined {
	const queued = queuedChildren.get(taskId);
	if (!queued?.stopped) return undefined;
	queuedChildren.delete(taskId);
	return queued.start;
}

/**
 * The transcript a task keeps. It is built here, outside `runAgentTask`: a closure made inside it would keep the
 * whole launch input reachable for as long as the task exists, a released child's session manager included.
 */
function taskTranscriptSource(
	session: TaskTranscriptSource,
	runId: string,
	intercomTarget: string | undefined,
): TaskTranscriptSource {
	return {
		getSessionId: () => session.getSessionId(),
		getEntries: () => session.getEntries(),
		...(session.subscribe ? { subscribe: session.subscribe.bind(session) } : {}),
		...(session.getStreamingMessage ? { getStreamingMessage: session.getStreamingMessage.bind(session) } : {}),
		...(intercomTarget === undefined ? {} : { completionSource: { runId, intercomTarget } }),
	};
}

type ExecutionSchedule = (dispatch: () => Promise<void>) => void;

/** The scheduler each child's run dispatched it on, by child id, so a resumed child waits for a slot in that run. */
const childSchedules = new Map<string, ExecutionSchedule>();

/** The scheduler the child's run dispatched it on, while this process has it and the child can still resume. */
export function subagentChildSchedule(runId: string, index: number): ExecutionSchedule | undefined {
	return childSchedules.get(`${runId}:${index}`);
}

/** Remember the scheduler the child's run dispatched it on, so its resume waits for a slot in that run. */
export function rememberSubagentChildSchedule(runId: string, index: number, schedule: ExecutionSchedule): void {
	childSchedules.set(`${runId}:${index}`, schedule);
}

/** The child ended for good: nothing resumes it into its run's scheduler or worktrees any more. */
export function forgetRunMembership(runId: string, index: number): void {
	childSchedules.delete(`${runId}:${index}`);
	unparkRunWorktree(runId, index);
}

const closingChildren = new Map<string, Promise<void>>();

export function subagentChildClosed(runId: string, index: number): Promise<void> {
	return closingChildren.get(subagentChildId(runId, index)) ?? Promise.resolve();
}

function trackChildClosing(childId: string, cleanup: Promise<Cleanup>): void {
	const closed = cleanup.then(
		() => undefined,
		() => undefined,
	);
	closingChildren.set(childId, closed);
	void closed.then(() => {
		if (closingChildren.get(childId) === closed) closingChildren.delete(childId);
	});
}

function wakeForResultsHeldDuringRun(
	dispatcher: AgentWakeDispatcher,
	ownerSessionId: string,
	childId: string,
	taskId: string,
	delivered: readonly string[],
): void {
	void subagentChildRecordsAppended(ownerSessionId).then(() => {
		const arrived = (subagentChildRecordOf(ownerSessionId, childId)?.heldToolResults ?? []).filter(
			(held) => !delivered.includes(held.toolCallId),
		);
		if (arrived.length > 0)
			wakeReleasedChildWithHeldResults(dispatcher, subagentWakeKey(ownerSessionId, childId), taskId);
	});
}

/** Bind the real foreground runner once; only its registered observation may yield. */
export async function runAgentTask(input: {
	host: AgentTaskHost;
	cwd: string;
	agents: AgentConfig[];
	agent: string;
	task: string;
	intentTask?: string;
	options: RunSyncOptions;
	wait?: WaitPolicy;
	runtime: SubagentExecutorRuntimeDeps;
	onTerminal?: (result: SingleResult) => void;
	schedule?: (dispatch: () => Promise<void>) => void;
	outputText?: (result: SingleResult) => string;
	recordChild?: SubagentChildRecordSink;
	/** Whether the child was launched with `context: "fork"`; by default, whether `options` fork a session for it. */
	forked?: boolean;
	/** Launch operation id; a resumed child needs a fresh one, since the host replays a repeated operation. */
	operation?: string;
	/** Task heartbeat cadence the caller chose; omitted uses the owner default. */
	heartbeatMs?: number;
	/** The dispatcher a released child's results wake it through; by default the process's one dispatcher. */
	wakeDispatcher?: AgentWakeDispatcher;
}): Promise<ModelSingleResponse> {
	let yieldWait: ((reason: YieldReason) => Result<WaitOutcome, YieldError>) | undefined;
	let pendingYield = false;
	let parentObserving = input.wait?.kind === "foreground";
	const registered = Promise.withResolvers<void>();
	const childCwd = input.options.cwd ?? input.cwd;
	let childSession: Pick<SubagentChildRecordInput, "childSessionId" | "childSessionFile"> = {};
	let childLaunch: Pick<SubagentChildRecordInput, "launchModel" | "launchThinkingLevel" | "launchLeafId"> = {};
	const agentConfig = input.agents.find((agent) => agent.name === input.agent);
	const agentSource = agentConfig?.source;
	const requestedModel = launchRequestedModel(agentConfig, input.options);
	const forked = input.forked ?? (input.options.sessionManager !== undefined && input.options.resumeSession !== true);
	const recordChildTask = (
		taskId: TaskId,
		state: SubagentChildRecordInput["state"],
		terminalStatus?: string,
		heldMessages?: SubagentChildPendingMessages,
		launch?: SubagentChildLaunch,
		waitingOn?: SubagentChildRecordInput["waitingOn"],
		releasedIntercomId?: string,
	) => {
		const worktree = runWorktreeRecord(input.options.runId, input.options.index ?? 0);
		input.recordChild?.record({
			runId: input.options.runId,
			index: input.options.index ?? 0,
			agent: input.agent,
			...(agentSource ? { agentSource } : {}),
			forked,
			state,
			cwd: childCwd,
			taskId,
			...childSession,
			...childLaunch,
			...(input.options.intercomSessionName ? { intercomTarget: input.options.intercomSessionName } : {}),
			...(input.options.intercomGroup ? { intercomGroup: input.options.intercomGroup } : {}),
			...(input.options.orchestratorIntercomTarget
				? { orchestratorTarget: input.options.orchestratorIntercomTarget }
				: {}),
			...(worktree ? { worktree } : {}),
			...(terminalStatus ? { terminalStatus } : {}),
			...(waitingOn ? { waitingOn } : {}),
			...(releasedIntercomId === undefined ? {} : { releasedIntercomId }),
			...(heldMessages?.messages.length ? { heldMessages: { taskId, ...heldMessages } } : {}),
			...(launch
				? { launch }
				: heldMessages?.taskExpands &&
						input.options.resumeSession !== true &&
						childSession.childSessionId === undefined
					? // It stopped before its session existed, holding its unread task: only its launch can start it again.
						{ launch: subagentChildLaunch(input.task, input.intentTask, input.options) }
					: {}),
			inherited: subagentChildInheritance(input.options),
			...subagentChildModelChoice(input.options, agentConfig),
		});
	};
	let dispatched = false;
	let admittedTaskId: TaskId | undefined;
	const runId = input.options.runId;
	const index = input.options.index ?? 0;
	if (input.schedule) rememberSubagentChildSchedule(runId, index, input.schedule);
	// The host skips a queued dispatch once its task was cancelled: record how a child that never started ended.
	const settleSkipped = async (taskId: TaskId) => {
		const queued = queuedChildren.get(taskId);
		if (queued?.stopped !== false) return;
		if (input.recordChild?.ownerEndedForGood?.()) {
			queuedChildren.delete(taskId);
			forgetRunMembership(runId, index);
			recordChildTask(taskId, "terminal", SUBAGENT_CHILD_STAGE_CLOSED_STATUS);
			return;
		}
		// Mark it stopped before its dispatch's hold is released, so its worktree is kept if it has unsaved work.
		parkRunWorktree(runId, index);
		const observed = await input.host.waitForTask(taskId);
		if (
			observed.ok &&
			observed.value.kind === "settled" &&
			observed.value.result.kind === "cancelled" &&
			observed.value.result.cause === "user"
		) {
			queuedChildren.delete(taskId);
			forgetRunMembership(runId, index);
			recordChildTask(taskId, "terminal", "killed");
			return;
		}
		// Its owner closed or paused: it stays restorable, and restoring it in this process starts it.
		queued.stopped = true;
	};
	let scheduled = false;
	// Every dispatch holds the run's worktrees with a hold of its own, released once that dispatch drains: a cancelled
	// dispatch the host skips never releases the hold of a later execution of the same child.
	const schedule = (dispatch: () => Promise<void>) => {
		const release = holdRunWorktree(runId, index);
		if (!input.schedule) {
			void dispatch().finally(release);
			return;
		}
		scheduled = true;
		input.schedule(() =>
			dispatch().finally(() => {
				if (!dispatched && admittedTaskId !== undefined) void settleSkipped(admittedTaskId);
				release();
			}),
		);
	};
	const queuedStart = (): QueuedSubagentChildStart => ({
		usesIntercom: input.options.supervisorAuthorization !== undefined,
		start: (launch) =>
			runAgentTask({
				host: launch.host,
				cwd: input.cwd,
				agents: input.agents,
				agent: input.agent,
				task: launch.message ? `${input.task}\n\n${launch.message}` : input.task,
				...(input.intentTask === undefined ? {} : { intentTask: input.intentTask }),
				options: {
					...input.options,
					signal: undefined,
					interruptSignal: undefined,
					intercomDetachSignal: undefined,
					onIntercomDetachCommit: undefined,
					onUpdate: undefined,
					onDetachedExit: undefined,
					supervisorAuthorization: launch.supervisorAuthorization,
				},
				wait: { kind: "background" },
				runtime: input.runtime,
				...(input.heartbeatMs === undefined ? {} : { heartbeatMs: input.heartbeatMs }),
				onTerminal: launch.onTerminal,
				// It waits for a slot in its run, as its original launch did.
				...(input.schedule ? { schedule: input.schedule } : {}),
				...(input.outputText ? { outputText: input.outputText } : {}),
				recordChild: launch.recordChild,
				forked,
				operation: `${input.options.runId}:${input.options.index ?? 0}:resume:${randomUUID()}`,
			}),
	});
	input.options.modelRoute?.assertCurrent();
	const started = await input.host.startAgentTask(
		{
			kind: "agent",
			agent: input.agent,
			task: input.intentTask ?? input.task,
			cwd: input.options.cwd ?? input.cwd,
			...(input.options.modelRoute ? { routerSelection: input.options.modelRoute.routerSelection } : {}),
			...(requestedModel ? { requestedModel } : {}),
			...(input.heartbeatMs === undefined ? {} : { heartbeatMs: input.heartbeatMs }),
		},
		(input.operation ?? `${input.options.runId}:${input.options.index ?? 0}`) as OperationId,
		(context) => {
			dispatched = true;
			queuedChildren.delete(context.ref.taskId);
			// This execution owns the child's worktree now; a stopped child's worktree was kept for it until here.
			claimRunWorktree(runId, index);
			const cleaned = Promise.withResolvers<Cleanup>();
			let executionBound = false;
			const ownerClosed = () =>
				context.signal.aborted && (context.signal.reason === "owner-close" || context.signal.reason === "shutdown");
			const recordChild = (
				state: SubagentChildRecordInput["state"],
				terminalStatus?: string,
				heldMessages?: SubagentChildPendingMessages,
				waitingOn?: SubagentChildRecordInput["waitingOn"],
				releasedIntercomId?: string,
			) =>
				recordChildTask(
					context.ref.taskId,
					state,
					terminalStatus,
					heldMessages,
					undefined,
					waitingOn,
					releasedIntercomId,
				);
			const childId = subagentChildId(runId, index);
			const wokenWith = input.options.wakeToolResultIds ?? [];
			const clearDelivered = (toolCallIds: readonly string[]) => {
				const delivered = toolCallIds.filter((toolCallId) => wokenWith.includes(toolCallId));
				return delivered.length === 0
					? Promise.resolve()
					: (input.recordChild?.clearHeldToolResults?.(childId, delivered) ?? Promise.resolve());
			};
			const result = registered.promise.then(async (): Promise<TaskResult> => {
				try {
					input.options.modelRoute?.assertCurrent();
					const ownerSessionId = input.recordChild?.ownerSessionId;
					const child = await input.runtime.runSync(input.cwd, input.agents, input.agent, input.task, {
						...input.options,
						// A background child is released while it waits, and its owner wakes it (#4326).
						...(input.options.releaseWhenWaiting === undefined &&
						ownerSessionId !== undefined &&
						input.wait?.kind !== "foreground"
							? { releaseWhenWaiting: subagentReleasePolicy() }
							: {}),
						signal: context.signal,
						taskExecution: {
							signal: context.signal,
							reportActivity: context.reportActivity,
							bindTranscript: (session) =>
								context.bindTranscript(
									taskTranscriptSource(session, input.options.runId, input.options.intercomSessionName),
								),
							setExtensionStatus: context.setExtensionStatus,
							clearExtensionStatuses: context.clearExtensionStatuses,
							bindChildSession: (session) => {
								childSession = {
									childSessionId: session.sessionId,
									...(session.sessionFile ? { childSessionFile: session.sessionFile } : {}),
								};
								recordChild("running");
							},
							bindChildLaunch: (launch) => {
								childLaunch = {
									...(launch.model ? { launchModel: launch.model } : {}),
									...(launch.thinking ? { launchThinkingLevel: launch.thinking } : {}),
									launchLeafId: launch.leafId,
								};
								recordChild("running");
							},
							toolResultsSaved: (toolCallIds) => void clearDelivered(toolCallIds),
							onExecution: (execution) => {
								executionBound = true;
								trackChildClosing(childId, execution.cleanup);
								void execution.cleanup.then(cleaned.resolve, (error) =>
									cleaned.resolve({
										kind: "failed",
										resources: [{ resource: "agent-session", code: "CleanupFailed", message: String(error) }],
									}),
								);
							},
							yieldTaskWait: () => {
								parentObserving = false;
								if (yieldWait) yieldWait("intercom-coordination");
								else pendingYield = true;
							},
							isParentObserving: () => parentObserving,
						},
					});
					if (child.model !== undefined || child.thinking !== undefined)
						context.reportActivity({
							reportId: "terminal-model",
							change: { kind: "model", model: taskRecordModel(child.model), thinking: child.thinking },
						});
					const stopped = takeSubagentChildStop(context.ref.taskId);
					const stoppedByControl = stopped !== undefined && child.status === "interrupted";
					// The only resumable pause run control did not request is the owner's workflow stage pausing.
					const stoppedByStagePause =
						!stoppedByControl &&
						child.status === "interrupted" &&
						context.signal.aborted &&
						context.signal.reason === "pause";
					const endedForGood = ownerClosed() && input.recordChild?.ownerEndedForGood?.() === true;
					// Released while it waits (#4326): resumable, woken by a tool result, a message or resume.
					const released = child.released !== undefined && !stoppedByControl && !endedForGood;
					// Run control marked it stopped before it stopped it; a child that ended otherwise is not stopped.
					if (stopped !== undefined && !stoppedByControl) unparkRunWorktree(runId, index);
					// A child that stays restorable is marked stopped before its dispatch's hold is released.
					if (released || stoppedByStagePause || (ownerClosed() && !endedForGood)) parkRunWorktree(runId, index);
					if (endedForGood || child.status === "killed") forgetRunMembership(runId, index);
					if (released && child.released) {
						// The record goes first: a result forwarded before it would find the child still recorded running.
						recordChild(
							"terminal",
							SUBAGENT_CHILD_RELEASED_STATUS,
							pendingMessagesOfResult(child),
							child.released.waitingOn,
							child.released.intercomId,
						);
						if (ownerSessionId !== undefined)
							forwardDetachedResults(
								input.wakeDispatcher ?? agentWakeDispatcher(),
								subagentWakeKey(ownerSessionId, childId),
								child.released.calls,
							);
						void reserveReleasedChildTargets(
							input.options,
							childSession.childSessionId,
							child.released.intercomId,
						);
						const holdMessages = input.recordChild?.holdMessages;
						if (ownerSessionId !== undefined && holdMessages !== undefined)
							routeReleasedChildShellCompletions(
								child.released,
								holdMessages,
								ownerSessionId,
								childId,
								input.wakeDispatcher ?? agentWakeDispatcher(),
							);
					} else if (!ownerClosed())
						recordChild(
							"terminal",
							stoppedByControl
								? stopped
								: stoppedByStagePause
									? SUBAGENT_CHILD_STAGE_PAUSED_STATUS
									: child.status,
							// A child that stays resumable keeps what it had queued and not read, for its resume.
							stoppedByControl || stoppedByStagePause ? pendingMessagesOfResult(child) : undefined,
						);
					else if (endedForGood) recordChild("terminal", SUBAGENT_CHILD_STAGE_CLOSED_STATUS);
					// Its owner closed, which ends nothing: it stays restorable, with what it had queued and not read.
					else if (child.pendingMessages?.length)
						recordChild("running", undefined, pendingMessagesOfResult(child));
					const settled = released || !ownerClosed();
					if (settled && (released || child.status === "ok" || stoppedByControl || stoppedByStagePause))
						void clearDelivered(wokenWith);
					input.onTerminal?.(child);
					if (
						ownerSessionId !== undefined &&
						settled &&
						!stoppedByControl &&
						!stoppedByStagePause &&
						child.status !== "killed"
					)
						wakeForResultsHeldDuringRun(
							input.wakeDispatcher ?? agentWakeDispatcher(),
							ownerSessionId,
							childId,
							context.ref.taskId,
							wokenWith,
						);
					const text = input.outputText?.(child) ?? getSingleResultOutput(child);
					if (!released) retainTaskOutput(child, text, context.ref);
					const bytes = Buffer.from(text);
					context.reportActivity({
						reportId: "terminal-output",
						change: { kind: "output", offset: "0", bytesBase64: bytes.toString("base64") },
					});
					const output = {
						ownerId: context.ref.ownerId,
						taskId: context.ref.taskId,
						artifactId: `output:${context.ref.taskId}`,
						byteCount: String(bytes.length),
						omittedRanges: [],
					};
					if (child.status === "killed") return { kind: "cancelled", cause: "user", output };
					// The task host's resumable stop: the child is not running and not ended, and nothing of it stays live.
					if (released) return { kind: "cancelled", cause: "pause", output };
					if (child.interrupted)
						return {
							kind: "cancelled",
							// Pause and quit are typed resumable stops; a fresh-start handoff stays parent-handoff.
							cause: stoppedByControl
								? stopped === "quit"
									? "quit"
									: "pause"
								: stoppedByStagePause
									? "pause"
									: input.options.interruptSignal?.aborted
										? "parent-handoff"
										: "owner-close",
							output,
						};
					return child.status === "ok"
						? { kind: "completed", output }
						: {
								kind: "failed",
								code: "AgentFailed",
								message: child.error ?? child.envelope ?? "Agent failed",
								output,
							};
				} catch (error) {
					if (takeSubagentChildStop(context.ref.taskId) !== undefined) unparkRunWorktree(runId, index);
					if (!ownerClosed()) recordChild("terminal", "error");
					else if (input.recordChild?.ownerEndedForGood?.()) {
						forgetRunMembership(runId, index);
						recordChild("terminal", SUBAGENT_CHILD_STAGE_CLOSED_STATUS);
					}
					throw error;
				} finally {
					// A refusal before session admission has no session resources to reap.
					if (!executionBound) cleaned.resolve({ kind: "reaped" });
				}
			});
			return { result, cleanup: cleaned.promise };
		},
		schedule,
	);
	if (!started.ok) return { kind: "unstarted", reason: { kind: "rejected", error: started.error } };
	admittedTaskId = started.value.taskId;
	// Its execution waits for `registered`, so nothing it records can precede this. Pause and quit then find a child
	// still queued behind its concurrency limit, and run control never reads a resumed child's previous task id.
	const queuedAtAdmission = scheduled && !dispatched;
	recordChildTask(
		started.value.taskId,
		"running",
		undefined,
		undefined,
		// Nothing of a queued launch survives a restart but its records: they say how to start it fresh then.
		queuedAtAdmission ? subagentChildLaunch(input.task, input.intentTask, input.options) : undefined,
	);
	if (queuedAtAdmission) queuedChildren.set(started.value.taskId, { start: queuedStart(), stopped: false });
	// A queued execution has no runSync listener yet. Release its observation too,
	// without spending a concurrency slot or cancelling its owner-bound execution.
	const yieldForIntercom = () => {
		parentObserving = false;
		if (yieldWait) yieldWait("intercom-coordination");
		else pendingYield = true;
	};
	input.options.intercomDetachSignal?.addEventListener("abort", yieldForIntercom, { once: true });
	if (input.options.intercomDetachSignal?.aborted) yieldForIntercom();
	const observation = input.host.observeAgentLaunch(started.value.taskId, input.wait, (yieldRegistered) => {
		yieldWait = yieldRegistered;
		if (pendingYield) yieldRegistered("intercom-coordination");
		registered.resolve();
	});
	registered.resolve();
	const observed = await observation.finally(() => {
		parentObserving = false;
		input.options.intercomDetachSignal?.removeEventListener("abort", yieldForIntercom);
	});
	if (!observed.ok) throw new Error(`${observed.error.code}: ${observed.error.message}`);
	return { kind: "admitted", observation: observed.value };
}

/** Queued children, remembered run schedulers and executions still closing in this process; counted by tests. */
export function subagentTaskRegistrySizes(): {
	readonly queued: number;
	readonly schedules: number;
	readonly closing: number;
} {
	return { queued: queuedChildren.size, schedules: childSchedules.size, closing: closingChildren.size };
}
