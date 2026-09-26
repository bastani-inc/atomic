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
}): Promise<ModelSingleResponse> {
	let yieldWait: ((reason: YieldReason) => Result<WaitOutcome, YieldError>) | undefined;
	let pendingYield = false;
	let parentObserving = input.wait?.kind === "foreground";
	const registered = Promise.withResolvers<void>();
	input.options.modelRoute?.assertCurrent();
	const started = await input.host.startAgentTask(
		{
			kind: "agent",
			agent: input.agent,
			task: input.intentTask ?? input.task,
			cwd: input.options.cwd ?? input.cwd,
			...(input.options.modelRoute ? { routerSelection: input.options.modelRoute.routerSelection } : {}),
		},
		`${input.options.runId}:${input.options.index ?? 0}` as OperationId,
		(context) => {
			const cleaned = Promise.withResolvers<Cleanup>();
			let executionBound = false;
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
							cause: input.options.interruptSignal?.aborted ? "parent-handoff" : "owner-close",
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
				} finally {
					// A refusal before session admission has no session resources to reap.
					if (!executionBound) cleaned.resolve({ kind: "reaped" });
				}
			});
			return { result, cleanup: cleaned.promise };
		},
		input.schedule,
	);
	if (!started.ok) return { kind: "unstarted", reason: { kind: "rejected", error: started.error } };
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
