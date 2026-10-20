import { randomUUID } from "node:crypto";
import type { AgentTaskHost, OperationId, WaitPolicy } from "@bastani/atomic";
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
import type { AgentConfig } from "../../agents/agents.js";
import type { RunSyncOptions, SingleResult, SubagentToolResult } from "../../shared/types.js";
import { getSingleResultOutput } from "../../shared/utils.js";
import {
	claimRunWorktree,
	holdRunWorktree,
	parkRunWorktree,
	runWorktreeRecord,
	unparkRunWorktree,
} from "./run-worktrees.js";
import {
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildRecordInput,
	type SubagentChildRecordSink,
	takeSubagentChildStop,
} from "./subagent-child-records.js";
import type { SubagentExecutorRuntimeDeps } from "./subagent-executor-types.js";
import { INLINE_TASK_OUTPUT_MAX_BYTES, retainedTaskOutput, retainTaskOutput } from "./task-output-retention.js";

export { INLINE_TASK_OUTPUT_MAX_BYTES } from "./task-output-retention.js";

/** Project explicit user stops without changing the shared host cancellation record. */
export function subagentTaskResultLabel(result: TaskResult): string {
	return result.kind === "cancelled" && result.cause === "user" ? "killed (non-resumable)" : result.kind;
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
): string {
	const truncated =
		output.shown < output.total
			? `, first ${output.shown} shown${output.path ? "; read the full output file for the rest" : ""}`
			: "";
	const lines = [`Output of ${taskId} (${label}, ${output.total} bytes${truncated}):`];
	if (output.requestedPath) lines.push(`Requested output: ${output.requestedPath}`);
	if (output.saveError) lines.push(`Output file error: ${output.saveError}`);
	if (output.path) lines.push(`Full output: ${output.path}`);
	lines.push(output.head);
	return lines.join("\n");
}

async function readSettledOutput(host: AgentTaskHost, settled: SettledTaskOutput): Promise<string | undefined> {
	const output = settled.result.output;
	if (!output) return undefined;
	const label = subagentTaskResultLabel(settled.result);
	const kept = retainedTaskOutput(output.ownerId, output.taskId);
	if (kept) {
		return settledOutputSection(settled.taskId, label, {
			...kept,
			shown: Math.min(kept.totalBytes, INLINE_TASK_OUTPUT_MAX_BYTES),
			total: kept.totalBytes,
		});
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
		return settledOutputSection(settled.taskId, label, { head, shown, total: Number(output.byteCount) });
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
	const sections = await Promise.all(settled.map((entry) => readSettledOutput(host, entry)));
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
	const ids = new Set(
		outcomes.flatMap((outcome) => (outcome.kind === "admitted" ? [outcome.observation.taskId] : [])),
	);
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
	/** Launch operation id; a resumed child needs a fresh one, since the host replays a repeated operation. */
	operation?: string;
}): Promise<ModelSingleResponse> {
	let yieldWait: ((reason: YieldReason) => Result<WaitOutcome, YieldError>) | undefined;
	let pendingYield = false;
	let parentObserving = input.wait?.kind === "foreground";
	const registered = Promise.withResolvers<void>();
	const childCwd = input.options.cwd ?? input.cwd;
	let childSession: Pick<SubagentChildRecordInput, "childSessionId" | "childSessionFile"> = {};
	let childLaunch: Pick<SubagentChildRecordInput, "launchModel" | "launchThinkingLevel" | "launchLeafId"> = {};
	const recordChildTask = (
		taskId: TaskId,
		state: SubagentChildRecordInput["state"],
		terminalStatus?: string,
		heldMessages?: readonly string[],
	) => {
		const worktree = runWorktreeRecord(input.options.runId, input.options.index ?? 0);
		input.recordChild?.record({
			runId: input.options.runId,
			index: input.options.index ?? 0,
			agent: input.agent,
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
			...(heldMessages?.length ? { heldMessages: { taskId, messages: heldMessages } } : {}),
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
				onTerminal: launch.onTerminal,
				// It waits for a slot in its run, as its original launch did.
				...(input.schedule ? { schedule: input.schedule } : {}),
				...(input.outputText ? { outputText: input.outputText } : {}),
				recordChild: launch.recordChild,
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
				heldMessages?: readonly string[],
			) => recordChildTask(context.ref.taskId, state, terminalStatus, heldMessages);
			const result = registered.promise.then(async (): Promise<TaskResult> => {
				try {
					input.options.modelRoute?.assertCurrent();
					const child = await input.runtime.runSync(input.cwd, input.agents, input.agent, input.task, {
						...input.options,
						signal: context.signal,
						taskExecution: {
							signal: context.signal,
							reportActivity: context.reportActivity,
							bindTranscript: (session) =>
								context.bindTranscript({
									getSessionId: () => session.getSessionId(),
									getEntries: () => session.getEntries(),
									...(session.subscribe ? { subscribe: session.subscribe.bind(session) } : {}),
									...(session.getStreamingMessage
										? { getStreamingMessage: session.getStreamingMessage.bind(session) }
										: {}),
									...(input.options.intercomSessionName
										? {
												completionSource: {
													runId: input.options.runId,
													intercomTarget: input.options.intercomSessionName,
												},
											}
										: {}),
								}),
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
							onExecution: (execution) => {
								executionBound = true;
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
							change: { kind: "model", model: child.model, thinking: child.thinking },
						});
					const stopped = takeSubagentChildStop(context.ref.taskId);
					const stoppedByControl = stopped !== undefined && child.status === "interrupted";
					// The only handoff cancellation run control did not request is the owner's workflow stage pausing.
					const stoppedByStagePause =
						!stoppedByControl &&
						child.status === "interrupted" &&
						context.signal.aborted &&
						context.signal.reason === "parent-handoff";
					const endedForGood = ownerClosed() && input.recordChild?.ownerEndedForGood?.() === true;
					// Run control marked it stopped before it stopped it; a child that ended otherwise is not stopped.
					if (stopped !== undefined && !stoppedByControl) unparkRunWorktree(runId, index);
					// A child that stays restorable is marked stopped before its dispatch's hold is released.
					if (stoppedByStagePause || (ownerClosed() && !endedForGood)) parkRunWorktree(runId, index);
					if (endedForGood || child.status === "killed") forgetRunMembership(runId, index);
					if (!ownerClosed())
						recordChild(
							"terminal",
							stoppedByControl
								? stopped
								: stoppedByStagePause
									? SUBAGENT_CHILD_STAGE_PAUSED_STATUS
									: child.status,
							// A child that stays resumable keeps what it had queued and not read, for its resume.
							stoppedByControl || stoppedByStagePause ? child.pendingMessages : undefined,
						);
					else if (endedForGood) recordChild("terminal", SUBAGENT_CHILD_STAGE_CLOSED_STATUS);
					input.onTerminal?.(child);
					const text = input.outputText?.(child) ?? getSingleResultOutput(child);
					retainTaskOutput(child, text, context.ref);
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
					if (child.interrupted)
						return {
							kind: "cancelled",
							cause:
								stoppedByControl || stoppedByStagePause || input.options.interruptSignal?.aborted
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
	recordChildTask(started.value.taskId, "running");
	if (scheduled && !dispatched) queuedChildren.set(started.value.taskId, { start: queuedStart(), stopped: false });
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
