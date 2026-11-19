/**
 * Runs a tool call's in-process work as a task of the session's owner, observed exactly like a bash command: the same
 * `wait` policy (the owner's automatic yield when omitted), the same task id, `/tasks` row, heartbeats, completion
 * notice, `action: "wait"` observation and stop path. Only the work differs: it runs in this process instead of a
 * child process, and its output is what it writes.
 */

import type {
	CancelCause,
	OperationId,
	OutputRef,
	TaskId,
	TaskResult,
	ToolIntent,
	WaitOutcome,
	WaitPolicy,
} from "../tasks/contracts.js";
import type { FakeExecution, FakeRunnerContext, TaskLease } from "../tasks/supervisor.js";
import { type SupervisedCommandOwner, validateBashWait } from "./bash-pty-native.js";

/**
 * The work of a tool call that runs as a task. It writes its output as it goes, and resolves `finished` when it did
 * all of it or `stopped` when its signal ended it first (it then writes where to continue from).
 */
export type ToolTaskWork = (write: (text: string) => void, signal: AbortSignal) => Promise<"finished" | "stopped">;

export interface ToolTaskLaunch {
	/** The tool whose call this is, for example `search`. */
	readonly tool: string;
	/** What the task does, as `/tasks` and its notices name it. */
	readonly label: string;
	readonly cwd?: string;
	/** Execution bound: the task stops, as cancelled with cause `execution-timeout`, once it has run this long. */
	readonly timeoutMs?: number;
	readonly wait?: WaitPolicy;
	/** The tool call's abort: it stops the task, as a stop from `/tasks` does. */
	readonly signal?: AbortSignal;
	readonly onStarted?: (task: TaskLease) => void;
	readonly heartbeatMs?: number;
	readonly work: ToolTaskWork;
}

export interface ToolTaskResult {
	readonly taskId: TaskId;
	readonly observation: WaitOutcome;
}

/** Why the work was asked to stop: a cancellation's cause, or its own execution timeout. */
function stopCause(reason: unknown): CancelCause {
	return typeof reason === "string" &&
		[
			"user",
			"owner-close",
			"execution-timeout",
			"output-limit",
			"parent-handoff",
			"pause",
			"quit",
			"shutdown",
		].includes(reason)
		? (reason as CancelCause)
		: "user";
}

/** A tool task's runner: run the work, write its output to the task, and settle with how it ended. */
function toolTaskRunner(launch: ToolTaskLaunch) {
	return (context: FakeRunnerContext, _intent: ToolIntent): FakeExecution => {
		const stop = new AbortController();
		const forward = () => stop.abort(launch.signal?.aborted ? launch.signal.reason : context.signal.reason);
		const signal = launch.signal ? AbortSignal.any([launch.signal, stop.signal]) : stop.signal;
		if (context.signal.aborted) forward();
		else context.signal.addEventListener("abort", forward, { once: true });
		const timer =
			launch.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						// A stop that came first keeps its own reason.
						if (signal.aborted) return;
						stop.abort("execution-timeout");
					}, launch.timeoutMs);
		let bytes = 0;
		const write = (text: string) => {
			if (text.length === 0) return;
			const chunk = Buffer.from(text, "utf8");
			bytes += chunk.length;
			context.appendOutput?.(chunk);
		};
		const output = (): OutputRef => ({
			ownerId: context.ref.ownerId,
			taskId: context.ref.taskId,
			artifactId: `output:${context.ref.taskId}`,
			byteCount: String(bytes),
			omittedRanges: [],
		});
		const result: Promise<TaskResult> = (async () => {
			try {
				const ended = await launch.work(write, signal);
				// Work that finished before a late stop reached it completed: nothing of it was cut short.
				if (ended === "stopped") return { kind: "cancelled", cause: stopCause(signal.reason), output: output() };
				// A tool's work has no exit code; it finished, as a command that exits 0 does.
				return { kind: "completed", output: output(), exitCode: 0 };
			} catch (error) {
				if (signal.aborted) return { kind: "cancelled", cause: stopCause(signal.reason), output: output() };
				return {
					kind: "failed",
					code: "ToolFailed",
					message: error instanceof Error ? error.message : String(error),
					output: output(),
				};
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				context.signal.removeEventListener("abort", forward);
			}
		})();
		// In-process work holds nothing past its result: once it settles, it is reaped.
		return { result, cleanup: result.then(() => ({ kind: "reaped" as const })) };
	};
}

/**
 * Start `launch` as a task of `context`'s owner and observe it as bash observes a command: in the foreground for the
 * wait's budget (the owner's automatic yield when none is named), then it goes on in the background.
 */
export async function executeSupervisedToolTask(
	context: SupervisedCommandOwner,
	launch: ToolTaskLaunch,
): Promise<ToolTaskResult> {
	validateBashWait(launch.wait, !!context.startToolTask);
	launch.signal?.throwIfAborted();
	if (!context.startToolTask) throw new Error("This tool's background task requires a supported task owner");
	const started = await context.startToolTask(
		{
			kind: "tool",
			tool: launch.tool,
			label: launch.label,
			...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
			...(launch.heartbeatMs === undefined ? {} : { heartbeatMs: launch.heartbeatMs }),
			...(launch.timeoutMs === undefined ? {} : { executionTimeoutMs: launch.timeoutMs }),
			...(context.parentTaskId === undefined ? {} : { parentTaskId: context.parentTaskId }),
			...(context.launchedBy === undefined ? {} : { launchedBy: context.launchedBy }),
		},
		crypto.randomUUID() as OperationId,
		toolTaskRunner(launch),
	);
	if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
	const { taskId, lease: task } = started.value;
	launch.onStarted?.(task);
	context.onCommandStarted?.(taskId);
	const abort = () => {
		void context.supervisor.cancelTask(task, "user");
	};
	launch.signal?.addEventListener("abort", abort, { once: true });
	if (launch.signal?.aborted) abort();
	try {
		const observed = await context.supervisor.initialObservation(task, launch.wait);
		launch.signal?.throwIfAborted();
		if (!observed.ok) throw new Error(`${observed.error.code}: ${observed.error.message}`);
		return { taskId, observation: observed.value };
	} finally {
		launch.signal?.removeEventListener("abort", abort);
	}
}
