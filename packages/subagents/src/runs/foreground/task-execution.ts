import { randomUUID } from "node:crypto";
import {
	type AgentTaskHost,
	type AgentWakeDispatcher,
	agentWakeDispatcher,
	finishedSubagentResumeText,
	type OperationId,
	ranOnModelLine,
	sessionStartStepText,
	spanElapsedMs,
	subagentResumeId,
	withTaskTranscriptArchive,
} from "@bastani/atomic";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import type {
	Cleanup,
	ModelParallelResponse,
	ModelSingleResponse,
	TaskElapsedSpan,
	TaskId,
	TaskRecord,
	TaskResult,
} from "../../../../coding-agent/src/core/tasks/contracts.js";
import type { TaskLease, TaskTranscriptSource } from "../../../../coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../agents/agents.js";
import { sendTaskTranscriptMessage } from "../../intercom/task-message.js";
import { checkLaunchCwd } from "../../shared/launch-cwd.js";
import { taskRecordModel } from "../../shared/model-info.js";
import type {
	Details,
	IntercomEventBus,
	RunSyncOptions,
	SingleResult,
	SubagentToolResult,
} from "../../shared/types.js";
import { getSingleResultOutput } from "../../shared/utils.js";
import { launchRequestedModel } from "../shared/model-fallback.js";
import { type ExecutionScheduler, isExecutionTicket } from "../shared/parallel-utils.js";
import {
	recordSubagentStartProgress,
	SUBAGENT_START_ATTEMPTS,
	type SubagentStartProgress,
	type SubagentStartStatus,
	subagentStartStatus,
} from "../shared/start-progress.js";
import { scheduleReleasedReplyTimeouts } from "./released-child-replies.js";
import { endedChildMark, markEndedChildren, reserveReleasedChildTargets } from "./released-child-reservations.js";
import { recordSubagentAdmission } from "./released-child-resume.js";
import {
	forwardDetachedResults,
	routeReleasedChildShellCompletions,
	SUBAGENT_OWNER_GENERATION,
	subagentReleasePolicy,
	subagentWakeKey,
	wakeFailureOf,
	wakeReleasedChildWithHeldResults,
} from "./released-children.js";
import {
	beginWorktreeExecution,
	claimRunWorktree,
	currentChildWorktreeNote,
	observeChildWorktreeAtReply,
	parkRunWorktree,
	pendingChildWorktreeRelease,
	runWorktreeRecord,
	unparkRunWorktree,
} from "./run-worktrees.js";
import { readableSubagentChildRecordOf, subagentChildCardRecord } from "./subagent-child-card-state.js";
import {
	observeChildRecordFailure,
	pendingMessagesOfResult,
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildLaunch,
	type SubagentChildPendingMessages,
	type SubagentChildRecordInput,
	type SubagentChildRecordSink,
	subagentChildId,
	subagentChildInheritance,
	subagentChildLaunch,
	subagentChildModelChoice,
	subagentChildRecordsAppended,
	subagentChildTask,
	subagentChildTitle,
	takeSubagentChildStop,
} from "./subagent-child-records.js";
import type { SubagentExecutorRuntimeDeps } from "./subagent-executor-types.js";
import {
	INLINE_TASK_OUTPUT_MAX_BYTES,
	retainedTaskOutput,
	retainTaskOutput,
	wasTaskOutputEvicted,
} from "./task-output-retention.js";

export { INLINE_TASK_OUTPUT_MAX_BYTES } from "./task-output-retention.js";

function terminalTaskResult(
	child: SingleResult,
	ref: TaskRecord["ref"],
	byteCount: number,
	released: boolean,
	cause: Extract<TaskResult, { kind: "cancelled" }>["cause"],
): TaskResult {
	const output = {
		ownerId: ref.ownerId,
		taskId: ref.taskId,
		artifactId: `output:${ref.taskId}`,
		byteCount: String(byteCount),
		omittedRanges: [],
	};
	if (child.status === "killed") return { kind: "cancelled", cause: "user", output };
	if (released)
		return {
			kind: "cancelled",
			cause: "pause",
			output,
			released: {
				waitingOn: (child.released?.waitingOn ?? []).map(({ toolCallId, toolName }) => ({ toolCallId, toolName })),
			},
		};
	if (child.interrupted) return { kind: "cancelled", cause, output };
	return child.status === "ok"
		? { kind: "completed", output }
		: { kind: "failed", code: "AgentFailed", message: child.error ?? child.envelope ?? "Agent failed", output };
}

/** Project explicit user stops without changing the shared host cancellation record. */
export function subagentTaskResultLabel(result: TaskResult): string {
	if (result.kind === "cancelled" && result.cause === "user") return "killed (non-resumable)";
	// A released child is not paused: it wakes by itself when what it waits on finishes (#5031).
	if (result.kind === "cancelled" && result.released)
		return `released · waiting on ${result.released.waitingOn.map((call) => `${call.toolName} (${call.toolCallId})`).join(", ")}`;
	// A quit or paused child awaits resume.
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
	const notStarted = outcomes.filter((outcome) => outcome.kind === "unstarted" && outcome.reason.kind === "rejected");
	const notices = [
		...(killed.length ? [`${killed.length} killed. These children cannot be resumed.`] : []),
		// #4697: one child's setup failure is its own outcome; its siblings started and report on their own.
		...(response.kind === "parallel" && notStarted.length
			? [
					`${notStarted.length} of ${outcomes.length} children failed to start${notStarted.length < outcomes.length ? "; the others started" : ""}. Each slot reports its own outcome.`,
				]
			: []),
	];
	return `${notices.length ? `${notices.join(" ")} Underlying host response:\n` : ""}${JSON.stringify(response)}`;
}

/** Every parallel child failed to start, so the call itself failed (#4697). */
export function parallelResponseNeverStarted(response: ModelParallelResponse): boolean {
	return (
		response.slots.length > 0 &&
		response.slots.every((slot) => slot.outcome.kind === "unstarted" && slot.outcome.reason.kind === "rejected")
	);
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

interface OutputExcerpt {
	head: string;
	shown: number;
	total: number;
	path?: string;
	requestedPath?: string;
	saveError?: string;
}

function settledOutputSection(
	taskId: TaskId,
	label: string,
	output: OutputExcerpt,
	ranOn: string | undefined,
	worktreeNote?: string,
	resume?: string,
): string {
	const truncated =
		output.shown < output.total
			? `, first ${output.shown} shown${output.path ? "; read the full output file for the rest" : ""}`
			: "";
	// Keep the observation in the header, not in the answer a replayed card extracts from this section.
	const lines = [
		`Output of ${taskId} (${label}, ${output.total} bytes${truncated}):${worktreeNote ? ` ${worktreeNote}` : ""}${resume ? ` ${resume}` : ""}`,
	];
	if (ranOn) lines.push(ranOn);
	if (output.requestedPath) lines.push(`Requested output: ${output.requestedPath}`);
	if (output.saveError) lines.push(`Output file error: ${output.saveError}`);
	if (output.path) lines.push(`Full output: ${output.path}`);
	lines.push(output.head);
	return lines.join("\n");
}

/** A verified copy already owned by the task's transcript. Neither the task nor any output stays alive for this lookup. */
const transcriptOutputs = new WeakMap<TaskLease, WeakRef<{ text: string }>>();

function rememberTranscriptOutput(
	lease: WeakRef<TaskLease>,
	ref: TaskRecord["ref"],
	reply: AssistantMessage | undefined,
): void {
	if (!reply) return;
	const kept = retainedTaskOutput(ref.ownerId, ref.taskId);
	if (!kept || kept.totalBytes > INLINE_TASK_OUTPUT_MAX_BYTES) return;
	const part = reply.content.find((block) => block.type === "text" && block.text === kept.head);
	if (part?.type !== "text") return;
	const task = lease.deref();
	if (task) transcriptOutputs.set(task, new WeakRef(part));
}

export async function readSettledOutput(
	host: AgentTaskHost,
	settled: SettledTaskOutput,
	record: TaskRecord | undefined,
): Promise<OutputExcerpt | { unavailable: string } | undefined> {
	const output = settled.result.output;
	if (!output) return undefined;
	const kept = retainedTaskOutput(output.ownerId, output.taskId);
	if (kept) return { ...kept, shown: Math.min(kept.totalBytes, INLINE_TASK_OUTPUT_MAX_BYTES), total: kept.totalBytes };
	const unavailable = (reason: string) => ({ unavailable: reason });
	const lease = host.resolveTask(settled.taskId);
	if (!lease.ok) return unavailable(lease.error.message);
	const head = transcriptOutputs.get(lease.value)?.deref()?.text;
	const total = Number(output.byteCount);
	if (
		head !== undefined &&
		head.length <= total &&
		total <= INLINE_TASK_OUTPUT_MAX_BYTES &&
		Buffer.byteLength(head) === total
	)
		return { head, shown: total, total };
	try {
		const page = await host.ownerBinding.supervisor.readTaskOutput(lease.value, {
			start: "0",
			maximumBytes: INLINE_TASK_OUTPUT_MAX_BYTES,
		});
		if (!page.ok) {
			if (
				page.error.code === "OutputUnavailable" &&
				record?.kind === "agent" &&
				!(settled.result.kind === "cancelled" && settled.result.released) &&
				wasTaskOutputEvicted(lease.value)
			) {
				return unavailable(
					`The private copy is no longer in the recent output cache. See the earlier result or open /tasks ${settled.taskId} for the child's transcript.`,
				);
			}
			return unavailable(page.error.message);
		}
		const decoder = new TextDecoder();
		const head =
			page.value.chunks.map((chunk) => decoder.decode(chunk.bytes, { stream: true })).join("") + decoder.decode();
		const shown = page.value.chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
		return { head, shown, total: Number(output.byteCount) };
	} catch (error) {
		return unavailable(error instanceof Error ? error.message : String(error));
	}
}

/** Resolve settled `output:<taskId>` references into readable text for the model (#3294). */
export async function settledTaskOutputText(
	host: AgentTaskHost | undefined,
	settled: readonly SettledTaskOutput[],
	signal?: AbortSignal,
): Promise<string> {
	if (!host || settled.length === 0) return "";
	const records = ownerTaskRecords(new Set(settled.map((entry) => entry.taskId)), host);
	const sections = await Promise.all(
		settled.map(async (entry) => {
			const record = records.find((item) => item.ref.taskId === entry.taskId);
			const ref = entry.result.output;
			const kept = ref && retainedTaskOutput(ref.ownerId, ref.taskId);
			const tree = kept
				? kept.worktree
				: record?.kind === "agent"
					? subagentChildCardRecord(undefined, entry.taskId)
					: undefined;
			const output = await readSettledOutput(host, entry, record);
			const note = tree && (await observeChildWorktreeAtReply(tree.runId, tree.index, undefined, signal));
			if (!output) return note ? `${entry.taskId}: ${note}` : undefined;
			const label = subagentTaskResultLabel(entry.result);
			// A subagent that completed or failed keeps its session: its header names the call that continues it. Output
			// kept without its task record is a subagent's; the task id then resolves for resume.
			const agent = record ? record.kind === "agent" : Boolean(kept);
			const resume =
				agent && entry.result.kind !== "cancelled"
					? finishedSubagentResumeText(subagentResumeId(entry.taskId, record))
					: undefined;
			return "unavailable" in output
				? [
						`Output of ${entry.taskId} (${label}) is unavailable: ${output.unavailable}${resume ? ` ${resume}` : ""}`,
						note,
					]
						.filter(Boolean)
						.join("\n")
				: settledOutputSection(entry.taskId, label, output, ranOnModelLine(record), note, resume);
		}),
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
		...(parallelResponseNeverStarted(response) ? { isError: true } : {}),
	};
}

/** Report a rejected slot's current worktree state separately from the host response and any sibling's output. */
export function withRejectedWorktrees(
	result: SubagentToolResult,
	trees: Details["rejectedWorktrees"],
): SubagentToolResult {
	if (!result.details || !trees?.some(Boolean)) return result;
	const notes = trees.flatMap((tree, slot) => {
		const note = tree && currentChildWorktreeNote(tree.runId, tree.index);
		return note ? [{ type: "text" as const, text: `Task ${slot + 1}: ${note}` }] : [];
	});
	return {
		...result,
		details: { ...result.details, rejectedWorktrees: trees },
		content: [...result.content, ...notes],
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
	if (!host || ids.size === 0) return [];
	try {
		return [...host.taskRecords(ids)];
	} catch {
		// An owner that closed has no records left to report.
		return [];
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
const queuedChildren = new Map<
	string,
	{
		readonly start: QueuedSubagentChildStart;
		finishWorktree?: ReturnType<typeof beginWorktreeExecution>;
		stopped: boolean;
	}
>();

/** Whether the host admitted this task but has not dispatched it yet. */
export function isQueuedSubagentChild(taskId: string): boolean {
	return queuedChildren.get(taskId)?.stopped === false;
}

/**
 * Call after cancelling a task: whether it was still queued. A cancelled task is never dispatched, so nothing records
 * how it stopped; the caller records it, and {@link takeStoppedQueuedSubagentChild} later starts it.
 */
export function stopQueuedSubagentChild(taskId: string, status: string): boolean {
	const queued = queuedChildren.get(taskId);
	if (queued?.stopped !== false) return false;
	queued.stopped = true;
	// The host will skip this dispatch. Don't hold the batch until a scheduler slot eventually opens.
	const finish = queued.finishWorktree;
	queued.finishWorktree = undefined;
	if (finish) void finish(status);
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
 * whole launch input reachable for as long as the task exists, a released child's session manager included. A child
 * with an Intercom target accepts messages typed into its transcript through the parent's Intercom relay.
 */
function taskTranscriptSource(
	session: TaskTranscriptSource,
	runId: string,
	intercomTarget: string | undefined,
	intercomEvents: IntercomEventBus | undefined,
): TaskTranscriptSource {
	const source: TaskTranscriptSource = {
		getSessionId: () => session.getSessionId(),
		getEntries: () => session.getEntries(),
		...(session.loadHistory ? { loadHistory: session.loadHistory.bind(session) } : {}),
		...(session.readHistory ? { readHistory: session.readHistory.bind(session) } : {}),
		...(session.readHistoryChunks ? { readHistoryChunks: session.readHistoryChunks.bind(session) } : {}),
		...(session.getFallbackEntries ? { getFallbackEntries: session.getFallbackEntries.bind(session) } : {}),
		...(session.getEarlierCursor ? { getEarlierCursor: session.getEarlierCursor.bind(session) } : {}),
		...(session.getEntrySeq ? { getEntrySeq: session.getEntrySeq.bind(session) } : {}),
		...(session.entryReceipt ? { entryReceipt: session.entryReceipt.bind(session) } : {}),
		...(session.subscribe ? { subscribe: session.subscribe.bind(session) } : {}),
		...(session.getStreamingMessage ? { getStreamingMessage: session.getStreamingMessage.bind(session) } : {}),
		...(session.getCompactionReason ? { getCompactionReason: session.getCompactionReason.bind(session) } : {}),
		...(session.chatSession ? { chatSession: session.chatSession } : {}),
		...(session.commands ? { commands: session.commands.bind(session) } : {}),
		...(session.isRunning ? { isRunning: session.isRunning.bind(session) } : {}),
		...(session.interruptTurn ? { interruptTurn: session.interruptTurn.bind(session) } : {}),
		...(session.pauseTurn ? { pauseTurn: session.pauseTurn.bind(session) } : {}),
		...(session.resumeTurn ? { resumeTurn: session.resumeTurn.bind(session) } : {}),
		...(session.turnPaused ? { turnPaused: session.turnPaused.bind(session) } : {}),
		...(session.getQueuedMessages ? { getQueuedMessages: session.getQueuedMessages.bind(session) } : {}),
		...(session.queueMessage ? { queueMessage: session.queueMessage.bind(session) } : {}),
		...(session.clearQueue ? { clearQueue: session.clearQueue.bind(session) } : {}),
		...(intercomTarget === undefined ? {} : { completionSource: { runId, intercomTarget } }),
		...(intercomTarget === undefined || intercomEvents === undefined
			? {}
			: { sendMessage: (text: string) => sendTaskTranscriptMessage(intercomEvents, intercomTarget, text) }),
	};
	return withTaskTranscriptArchive(source, session);
}

type ExecutionSchedule = ExecutionScheduler;

/**
 * The scheduler each child's run dispatched it on, by run and child index, so a resumed or woken child waits for a slot
 * in that run. A released child keeps no entry (#4395); its run's scheduler is found through a sibling that does
 * (#4856), and a run left with no entry has none here at all.
 */
const runSchedules = new Map<string, Map<number, ExecutionSchedule>>();
let scheduleCount = 0;

/**
 * The scheduler a child of the run still holds in this process, the child's own or a sibling's: a woken or resumed child
 * waits for its slots (#4856).
 */
export function subagentRunSchedule(runId: string): ExecutionSchedule | undefined {
	return runSchedules.get(runId)?.values().next().value;
}

/** Remember the scheduler the child's run dispatched it on, so its resume waits for a slot in that run. */
export function rememberSubagentChildSchedule(runId: string, index: number, schedule: ExecutionSchedule): void {
	const shared = isExecutionTicket(schedule) ? schedule.scheduler : schedule;
	let members = runSchedules.get(runId);
	if (members === undefined) {
		members = new Map();
		runSchedules.set(runId, members);
	}
	if (!members.has(index)) scheduleCount++;
	members.set(index, shared);
}

function forgetChildSchedule(runId: string, index: number): void {
	const members = runSchedules.get(runId);
	if (members?.delete(index) !== true) return;
	scheduleCount--;
	if (members.size === 0) runSchedules.delete(runId);
}

/** The child ended for good: nothing resumes it into its run's scheduler or worktrees any more. */
export function forgetRunMembership(runId: string, index: number): void {
	forgetChildSchedule(runId, index);
	unparkRunWorktree(runId, index);
}

const closingChildren = new Map<string, Promise<void>>();
const finishingWorktreeTasks = new Set<TaskId>();

export function isFinishingWorktreeTask(taskId: TaskId): boolean {
	return finishingWorktreeTasks.has(taskId);
}

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
	// Nothing awaits this: a record it cannot read wakes nothing, and a failure is reported, never left unhandled.
	void subagentChildRecordsAppended(ownerSessionId)
		.then(() => {
			const arrived = (readableSubagentChildRecordOf(ownerSessionId, childId)?.heldToolResults ?? []).filter(
				(held) => !delivered.includes(held.toolCallId),
			);
			if (arrived.length > 0)
				wakeReleasedChildWithHeldResults(dispatcher, subagentWakeKey(ownerSessionId, childId), taskId);
		})
		.catch((error: Error) => observeChildRecordFailure(ownerSessionId, wakeFailureOf(error, childId)));
}

/**
 * Launch a subagent as a task of `host`. It always runs in the background: the launch returns once the task is admitted
 * and its observation registered, and the child reports by its completion notice. `subagent({ action: "wait" })` waits
 * for it explicitly.
 */
export async function runAgentTask(input: {
	host: AgentTaskHost;
	cwd: string;
	agents: AgentConfig[];
	agent: string;
	task: string;
	intentTask?: string;
	options: RunSyncOptions;
	runtime: SubagentExecutorRuntimeDeps;
	onTerminal?: (result: SingleResult) => void;
	schedule?: ExecutionScheduler;
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
	const registered = Promise.withResolvers<WeakRef<TaskLease>>();
	const childCwd = input.options.cwd ?? input.cwd;
	let childSession: Pick<SubagentChildRecordInput, "childSessionId" | "childSessionFile"> = {};
	let childLaunch: Pick<
		SubagentChildRecordInput,
		"launchModel" | "launchThinkingLevel" | "launchLeafId" | "launchLeafSeq"
	> = {};
	const agentConfig = input.agents.find((agent) => agent.name === input.agent);
	const agentSource = agentConfig?.source;
	const requestedModel = launchRequestedModel(agentConfig, input.options);
	const forked = input.forked ?? (input.options.sessionManager !== undefined && input.options.resumeSession !== true);
	let recordSpan: TaskElapsedSpan | undefined;
	/**
	 * Whether the user paused this child from its chat and its next turn has not started. Recorded once it was ever
	 * paused here, or the launch restores a child whose record names a pause (held or not), so a later record clears it;
	 * never otherwise.
	 */
	let turnPaused = input.options.resumePaused === true;
	let recordsPause = input.options.resumePaused !== undefined;
	/** The leaf entry of the child's session its latest pause was taken at; unknown until a pause reports it. */
	let pausedAtLeafId: string | null | undefined;
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
		const record: SubagentChildRecordInput = {
			runId: input.options.runId,
			index: input.options.index ?? 0,
			agent: input.agent,
			...(agentSource ? { agentSource } : {}),
			forked,
			state,
			elapsedMs: recordSpan ? spanElapsedMs(recordSpan) : 0,
			elapsedSpan: recordSpan ? { ...recordSpan } : null,
			cwd: childCwd,
			taskId,
			...childSession,
			...childLaunch,
			...(input.options.intercomSessionName ? { intercomTarget: input.options.intercomSessionName } : {}),
			...(input.options.intercomGroup ? { intercomGroup: input.options.intercomGroup } : {}),
			...(input.options.orchestratorIntercomTarget
				? { orchestratorTarget: input.options.orchestratorIntercomTarget }
				: {}),
			...subagentChildTask(input.intentTask ?? input.task, input.options),
			...subagentChildTitle(input.intentTask ?? input.task, input.options),
			...(worktree ? { worktree } : {}),
			...(terminalStatus ? { terminalStatus } : {}),
			// Every record a run writes says what that run waits on, so a later run's record never keeps the detached calls
			// an earlier released run waited on: records merge field by field (#4845).
			waitingOn: waitingOn ?? [],
			...(input.options.stillRunning === undefined ? {} : { stillRunning: input.options.stillRunning }),
			...(releasedIntercomId === undefined ? {} : { releasedIntercomId }),
			...(terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS ? { ownerGeneration: SUBAGENT_OWNER_GENERATION } : {}),
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
			...(input.schedule?.limit === undefined ? {} : { runConcurrency: input.schedule.limit }),
			...(input.heartbeatMs === undefined ? {} : { heartbeatMs: input.heartbeatMs }),
			...(recordsPause ? { pausedByUser: state === "running" && turnPaused } : {}),
			...(recordsPause && state === "running" && turnPaused && pausedAtLeafId !== undefined
				? { pausedAtLeafId }
				: {}),
		};
		input.recordChild?.record(record);
		// #4639: once its session is gone, a send to the child is told why it ended and how to resume it.
		const events = input.options.intercomEvents;
		if (input.recordChild !== undefined && events !== undefined) {
			const ended = endedChildMark({ ...record, childId: subagentChildId(record.runId, record.index) });
			if (ended !== undefined) {
				const pending = pendingChildWorktreeRelease(record);
				if (pending) void pending.then(() => markEndedChildren(events, [ended]));
				else void markEndedChildren(events, [ended]);
			}
		}
	};
	let dispatched = false;
	let admittedTaskId: TaskId | undefined;
	const ticket = isExecutionTicket(input.schedule) ? input.schedule : undefined;
	const runSchedule = ticket ? ticket.scheduler : input.schedule;
	const runId = input.options.runId;
	const index = input.options.index ?? 0;
	if (runSchedule) rememberSubagentChildSchedule(runId, index, runSchedule);
	// The host skips a queued dispatch once its task was cancelled: record how a child that never started ended.
	const settleSkipped = async (taskId: TaskId) => {
		const queued = queuedChildren.get(taskId);
		if (queued?.stopped !== false) return;
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
	let finishWorktree: ReturnType<typeof beginWorktreeExecution>;
	// Every dispatch holds the run's worktrees with a hold of its own, released once that dispatch drains: a cancelled
	// dispatch the host skips never releases the hold of a later execution of the same child.
	const schedule = (dispatch: () => Promise<void>) => {
		finishWorktree = beginWorktreeExecution(
			runId,
			index,
			childCwd,
			() => admittedTaskId,
			input.options.intercomEvents,
		);
		const drained = () => {
			if (admittedTaskId) finishingWorktreeTasks.delete(admittedTaskId);
			void finishWorktree?.();
		};
		if (!input.schedule) {
			void dispatch().finally(drained);
			return;
		}
		scheduled = true;
		input.schedule(() =>
			dispatch().finally(() => {
				if (!dispatched) ticket?.onEntered();
				if (!dispatched && admittedTaskId !== undefined) void settleSkipped(admittedTaskId);
				drained();
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
					cwdVerdict: undefined,
					signal: undefined,
					interruptSignal: undefined,
					intercomDetachSignal: undefined,
					onIntercomDetachCommit: undefined,
					onUpdate: undefined,
					onDetachedExit: undefined,
					supervisorAuthorization: launch.supervisorAuthorization,
				},
				runtime: input.runtime,
				...(input.heartbeatMs === undefined ? {} : { heartbeatMs: input.heartbeatMs }),
				onTerminal: launch.onTerminal,
				// It waits for a slot in its run, as its original launch did.
				...(runSchedule ? { schedule: runSchedule } : {}),
				recordChild: launch.recordChild,
				forked,
				operation: `${input.options.runId}:${input.options.index ?? 0}:resume:${randomUUID()}`,
			}),
	});
	const cwdVerdict =
		input.options.cwdVerdict?.path === childCwd
			? input.options.cwdVerdict
			: await checkLaunchCwd(childCwd).catch((error: unknown) => {
					ticket?.release();
					throw error;
				});
	const managed = input.schedule && runWorktreeRecord(runId, index);
	const started = await input.host
		.startAgentTask(
			{
				kind: "agent",
				agent: input.agent,
				task: input.intentTask ?? input.task,
				cwd: input.options.cwd ?? input.cwd,
				...(requestedModel ? { requestedModel } : {}),
				...(input.heartbeatMs === undefined ? {} : { heartbeatMs: input.heartbeatMs }),
			},
			(input.operation ?? `${input.options.runId}:${input.options.index ?? 0}`) as OperationId,
			(context) => {
				const elapsedSpan: TaskElapsedSpan = { dispatchedAt: Date.now() };
				recordSpan = elapsedSpan;
				dispatched = true;
				if (queuedChildren.delete(context.ref.taskId)) recordChildTask(context.ref.taskId, "running");
				// This execution owns the child's worktree now; a stopped child's worktree was kept for it until here.
				claimRunWorktree(runId, index);
				const cleaned = Promise.withResolvers<Cleanup>();
				let executionCleanup: Promise<Cleanup> | undefined;
				const ownerClosed = () =>
					context.signal.aborted &&
					(context.signal.reason === "owner-close" || context.signal.reason === "shutdown");
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
				// Results answering no pending call reach it as follow-ups, which a stop keeps as its pending messages.
				const answeredByTurn = new Set((input.options.resumeToolResults ?? []).map((result) => result.toolCallId));
				const clearDelivered = (toolCallIds: readonly string[]) => {
					const delivered = toolCallIds.filter((toolCallId) => wokenWith.includes(toolCallId));
					return delivered.length === 0
						? Promise.resolve()
						: (input.recordChild?.clearHeldToolResults?.(childId, delivered) ?? Promise.resolve());
				};
				// From here until its first turn starts the child is starting, and says where (never merely "running").
				const { dispatchedAt } = elapsedSpan;
				let startText: string | undefined;
				let lastStartStep: SubagentStartProgress["step"] | undefined;
				const reportStart = (progress: SubagentStartProgress | undefined) => {
					recordSubagentStartProgress(context.ref.taskId, progress);
					// A start ends started only once its task was dispatched; one that failed earlier keeps its last step.
					if (progress === undefined && lastStartStep !== "dispatching-task") return;
					lastStartStep = progress?.step;
					const text =
						progress === undefined
							? "started its first turn"
							: `${sessionStartStepText(progress.step)} (attempt ${progress.attempt} of ${SUBAGENT_START_ATTEMPTS}${progress.stalled ? `, after a start that stalled ${sessionStartStepText(progress.stalled.step)}` : ""})`;
					if (text === startText) return;
					startText = text;
					context.reportActivity({
						reportId: `${context.ref.taskId}:start-${randomUUID()}`,
						change: { kind: "action", tool: "start", text },
					});
				};
				reportStart({
					step: "opening-session",
					attempt: 1,
					launchedAt: dispatchedAt,
					startedAt: dispatchedAt,
					stepStartedAt: dispatchedAt,
				});
				const finishDirectory = (
					status: string,
					outcome: TaskResult | { rejected: unknown },
					saved?: Promise<void>,
				) => {
					if (!finishWorktree) return undefined;
					finishingWorktreeTasks.add(context.ref.taskId);
					const journal = Promise.withResolvers<void>();
					// The child record is enqueued synchronously below. Read its flush after that enqueue.
					const drained = Promise.resolve().then(async () => {
						const [session, output, intent, record] = await Promise.allSettled([
							executionCleanup,
							saved,
							journal.promise,
							input.recordChild?.flushed?.(),
						]);
						if (
							session.status === "fulfilled" &&
							(!session.value || session.value.kind === "reaped") &&
							output.status === "fulfilled" &&
							intent.status === "fulfilled" &&
							record.status === "fulfilled"
						)
							context.handoffDirectory?.();
					});
					const swept = finishWorktree(status, drained);
					Promise.resolve(context.markFinishing?.(outcome, swept)).then(journal.resolve, journal.reject);
					return swept;
				};
				const reportOutput = (bytes: Buffer) =>
					context.reportActivity({
						reportId: "terminal-output",
						change: { kind: "output", offset: "0", bytesBase64: bytes.toString("base64") },
					});
				const result = registered.promise.then(async (lease): Promise<TaskResult> => {
					try {
						const ownerSessionId = input.recordChild?.ownerSessionId;
						let settledReply: WeakRef<AssistantMessage> | undefined;
						const running = input.runtime.runSync(input.cwd, input.agents, input.agent, input.task, {
							...input.options,
							elapsedSpan,
							onElapsedSpanChanged: () => recordChild("running"),
							cwdVerdict,
							// A child is released while it waits, and its owner wakes it (#4326).
							...(input.options.releaseWhenWaiting === undefined && ownerSessionId !== undefined
								? { releaseWhenWaiting: subagentReleasePolicy() }
								: {}),
							onBeforeRelease: () =>
								reserveReleasedChildTargets(
									input.options,
									childSession.childSessionId,
									undefined,
									false,
									context.ref.taskId,
								),
							signal: context.signal,
							taskExecution: {
								taskId: context.ref.taskId,
								signal: context.signal,
								reportActivity: context.reportActivity,
								bindTranscript: (session) => {
									context.bindTranscript(
										taskTranscriptSource(
											session,
											input.options.runId,
											input.options.intercomSessionName,
											input.options.intercomEvents,
										),
									);
									settledReply = session.settledReply && new WeakRef(session.settledReply);
									// Disposal may bind the settled transcript before or after the task publishes its output.
									rememberTranscriptOutput(lease, context.ref, session.settledReply);
								},
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
										...(launch.leafSeq === undefined ? {} : { launchLeafSeq: launch.leafSeq }),
									};
									recordChild("running");
								},
								// What its session saved is cleared at once; a stop leaves the rest held for its resume (#5012).
								toolResultsSaved: (toolCallIds) => void clearDelivered(toolCallIds),
								reportTurnPaused: (paused, leafId) => {
									turnPaused = paused;
									if (paused) pausedAtLeafId = leafId;
									recordsPause = true;
									recordChild("running");
									return input.recordChild?.saved?.();
								},
								reportStart,
								onExecution: (execution) => {
									executionCleanup = execution.cleanup;
									trackChildClosing(childId, execution.cleanup);
									void Promise.allSettled([result])
										.then(() => execution.cleanup)
										.then(cleaned.resolve, (error) =>
											cleaned.resolve({
												kind: "failed",
												resources: [
													{ resource: "agent-session", code: "CleanupFailed", message: String(error) },
												],
											}),
										);
								},
							},
						});
						ticket?.onEntered();
						const child = await running;
						elapsedSpan.endedAt ??= Date.now();
						if (child.model !== undefined || child.thinking !== undefined)
							context.reportActivity({
								reportId: "terminal-model",
								change: { kind: "model", model: taskRecordModel(child.model), thinking: child.thinking },
							});
						const stopped = takeSubagentChildStop(context.ref.taskId);
						const stoppedByControl = stopped !== undefined && child.status === "interrupted";
						// Released while it waits (#4326): resumable, woken by a tool result, a message or resume.
						const released = child.released !== undefined && !stoppedByControl;
						// Run control marked it stopped before it stopped it; a child that ended otherwise is not stopped.
						if (stopped !== undefined && !stoppedByControl) unparkRunWorktree(runId, index);
						// A child that stays restorable is marked stopped before its dispatch's hold is released.
						if (released || ownerClosed()) parkRunWorktree(runId, index);
						if (child.status === "killed") forgetRunMembership(runId, index);
						if (released) forgetChildSchedule(runId, index);
						let worktreeOutput: string | undefined;
						const settled = released || !ownerClosed();
						const status = released ? SUBAGENT_CHILD_RELEASED_STATUS : stoppedByControl ? stopped : child.status;
						const cause = stoppedByControl
							? stopped === "quit"
								? "quit"
								: "pause"
							: input.options.interruptSignal?.aborted
								? "parent-handoff"
								: "owner-close";
						let swept: Promise<void> | undefined;
						let prepared: TaskResult | undefined;
						if (finishWorktree) {
							worktreeOutput = getSingleResultOutput(child);
							// Retain requested files inside the worktree before releasing the dispatch's hold.
							const saved = released
								? undefined
								: retainTaskOutput(child, worktreeOutput, context.ref, lease, { runId, index });
							prepared = terminalTaskResult(
								child,
								context.ref,
								Buffer.byteLength(worktreeOutput),
								released,
								cause,
							);
							reportOutput(Buffer.from(worktreeOutput));
							swept = finishDirectory(status, prepared, saved);
						}
						if (released && child.released) {
							// The record goes first: a result forwarded before it would find the child still recorded running.
							recordChild(
								"terminal",
								SUBAGENT_CHILD_RELEASED_STATUS,
								pendingMessagesOfResult(child),
								child.released.waitingOn,
								child.released.intercomId,
							);
						} else if (settled) {
							recordChild("terminal", status, stoppedByControl ? pendingMessagesOfResult(child) : undefined);
						} else if (child.pendingMessages?.length)
							recordChild("running", undefined, pendingMessagesOfResult(child));
						if (swept) {
							await swept;
							child.worktreeNote = currentChildWorktreeNote(runId, index);
						}
						if (released && child.released) {
							if (ownerSessionId !== undefined) {
								const dispatcher = input.wakeDispatcher ?? agentWakeDispatcher();
								const wakeKey = subagentWakeKey(ownerSessionId, childId);
								scheduleReleasedReplyTimeouts(dispatcher, wakeKey, child.released.waitingOn);
								forwardDetachedResults(dispatcher, wakeKey, child.released.calls, child.released.waitingOn);
							}
							void reserveReleasedChildTargets(
								input.options,
								childSession.childSessionId,
								child.released.intercomId,
								true,
								context.ref.taskId,
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
						}
						if (settled && (released || child.status === "ok")) void clearDelivered(wokenWith);
						else if (settled && stoppedByControl)
							void clearDelivered(wokenWith.filter((toolCallId) => !answeredByTurn.has(toolCallId)));
						input.onTerminal?.(child);
						if (ownerSessionId !== undefined && settled && !stoppedByControl && child.status !== "killed")
							wakeForResultsHeldDuringRun(
								input.wakeDispatcher ?? agentWakeDispatcher(),
								ownerSessionId,
								childId,
								context.ref.taskId,
								wokenWith,
							);
						const text = worktreeOutput ?? getSingleResultOutput(child);
						if (!released) {
							if (!finishWorktree) await retainTaskOutput(child, text, context.ref, lease);
							rememberTranscriptOutput(lease, context.ref, settledReply?.deref());
						}
						if (prepared) return prepared;
						const bytes = Buffer.from(text);
						reportOutput(bytes);
						return terminalTaskResult(child, context.ref, bytes.length, released, cause);
					} catch (error) {
						elapsedSpan.endedAt ??= Date.now();
						if (takeSubagentChildStop(context.ref.taskId) !== undefined) unparkRunWorktree(runId, index);
						const swept = finishDirectory("error", { rejected: error });
						if (!ownerClosed()) recordChild("terminal", "error");
						if (swept) await swept;
						throw error;
					} finally {
						ticket?.onEntered();
						recordSubagentStartProgress(context.ref.taskId, undefined);
						// A refusal before session admission has no session resources to reap.
						if (!executionCleanup) cleaned.resolve({ kind: "reaped" });
					}
				});
				return { result, cleanup: cleaned.promise, elapsedSpan };
			},
			schedule,
			managed && !managed.named
				? async (taskId, cause, journal, handoff) => {
						const status =
							cause === "quit" ? "quit" : cause === "pause" ? "paused" : cause === "user" ? "killed" : cause;
						if (cause !== "user") parkRunWorktree(runId, index);
						const control = takeSubagentChildStop(taskId);
						const drained = Promise.resolve()
							.then(() => Promise.all([journal, input.recordChild?.flushed?.()]))
							.then(handoff);
						const swept = finishWorktree?.(status, drained);
						if (control) recordChildTask(taskId, "terminal", control);
						if (cause === "user") {
							queuedChildren.delete(taskId);
							forgetRunMembership(runId, index);
							recordChildTask(taskId, "terminal", "killed");
						}
						await swept;
					}
				: undefined,
		)
		.catch((error: unknown) => {
			ticket?.release();
			throw error;
		});
	if (!started.ok) {
		ticket?.release();
		return { kind: "unstarted", reason: { kind: "rejected", error: started.error } };
	}
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
	if (input.recordChild?.ownerSessionId !== undefined)
		recordSubagentAdmission(started.value.lease, {
			ownerSessionId: input.recordChild.ownerSessionId,
			childId: subagentChildId(runId, index),
			runId,
			agent: input.agent,
			taskId: started.value.taskId,
			intercomTarget: input.options.intercomSessionName,
		});
	if (queuedAtAdmission)
		queuedChildren.set(started.value.taskId, { start: queuedStart(), stopped: false, finishWorktree });
	const lease = new WeakRef(started.value.lease);
	const register = () => registered.resolve(lease);
	const observation = input.host.observeAgentLaunch(started.value.taskId, undefined, register);
	register();
	ticket?.onObserved();
	if (ticket) await ticket.admitted;
	const observed = await observation;
	if (!observed.ok) throw new Error(`${observed.error.code}: ${observed.error.message}`);
	// The one Intercom target this task's child registers under, so a send never has to guess it.
	const admitted: ModelSingleResponse & { readonly intercomTarget?: string } = {
		kind: "admitted",
		observation: observed.value,
		...(input.options.intercomSessionName ? { intercomTarget: input.options.intercomSessionName } : {}),
	};
	return admitted;
}

/**
 * A task record as `subagent status` reports it: with its child's Intercom target, and, while the child has not
 * started its first turn, where its start is. A child that is still starting is never shown as merely running.
 */
export function subagentTaskStatusRecord(
	record: TaskRecord,
	intercomTarget: string | undefined,
	now = Date.now(),
): TaskRecord & { readonly intercomTarget?: string; readonly start?: SubagentStartStatus } {
	const start = record.execution.kind === "settled" ? undefined : subagentStartStatus(record.ref.taskId, now);
	return {
		...record,
		...(intercomTarget === undefined ? {} : { intercomTarget }),
		...(start === undefined ? {} : { start }),
	};
}

/** Queued children, remembered run schedulers and executions still closing in this process; counted by tests. */
export function subagentTaskRegistrySizes(): {
	readonly queued: number;
	readonly schedules: number;
	readonly scheduledRuns: number;
	readonly closing: number;
} {
	return {
		queued: queuedChildren.size,
		schedules: scheduleCount,
		scheduledRuns: runSchedules.size,
		closing: closingChildren.size,
	};
}
