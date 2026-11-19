/**
 * Runs a tool call's in-process work as a task of the session's owner, observed exactly like a bash command: the same
 * `wait` policy (the owner's automatic yield when omitted), the same task id, `/tasks` row, heartbeats, completion
 * notice, `action: "wait"` observation and stop path. Only the work differs: it runs in this process instead of a
 * child process, and its output is what it writes.
 */

import { setTimeout as poll } from "node:timers/promises";
import type {
	CancelCause,
	OperationId,
	OutputRef,
	TaskId,
	TaskResult,
	ToolIntent,
	WaitPolicy,
} from "../tasks/contracts.js";
import type { FakeExecution, FakeRunnerContext } from "../tasks/supervisor.js";
import { type SupervisedCommandOwner, type SupervisedCommandResult, validateBashWait } from "./bash-pty-native.js";

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
	/** Receives the task's output while the call observes it. */
	readonly onData?: (bytes: Buffer) => void;
	readonly heartbeatMs?: number;
	readonly work: ToolTaskWork;
}

export interface ToolTaskResult extends SupervisedCommandResult {
	readonly taskId: TaskId;
	/** Whether the work ended because its execution timeout elapsed. */
	readonly timedOut: boolean;
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
function toolTaskRunner(launch: ToolTaskLaunch, timedOut: { value: boolean }) {
	return (context: FakeRunnerContext, _intent: ToolIntent): FakeExecution => {
		const stop = new AbortController();
		const forward = () => stop.abort(context.signal.reason);
		if (context.signal.aborted) forward();
		else context.signal.addEventListener("abort", forward, { once: true });
		const timer =
			launch.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						// A stop that came first keeps its own reason.
						if (stop.signal.aborted) return;
						timedOut.value = true;
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
				const ended = await launch.work(write, stop.signal);
				// Work that finished before a late stop reached it completed: nothing of it was cut short.
				if (ended === "stopped")
					return { kind: "cancelled", cause: stopCause(stop.signal.reason), output: output() };
				// A tool's work has no exit code; it finished, as a command that exits 0 does.
				return { kind: "completed", output: output(), exitCode: 0 };
			} catch (error) {
				if (stop.signal.aborted)
					return { kind: "cancelled", cause: stopCause(stop.signal.reason), output: output() };
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
 * wait's budget (the owner's automatic yield when none is named), then it goes on in the background. Output it writes
 * while observed reaches `onData`.
 */
export async function executeSupervisedToolTask(
	context: SupervisedCommandOwner,
	launch: ToolTaskLaunch,
): Promise<ToolTaskResult> {
	validateBashWait(launch.wait, !!context.startToolTask);
	launch.signal?.throwIfAborted();
	if (!context.startToolTask) throw new Error("This tool's background task requires a supported task owner");
	const timedOut = { value: false };
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
		toolTaskRunner(launch, timedOut),
	);
	if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
	const { taskId, lease: task } = started.value;
	context.onCommandStarted?.(taskId);
	const abort = () => {
		void context.supervisor.cancelTask(task, "user");
	};
	launch.signal?.addEventListener("abort", abort, { once: true });
	if (launch.signal?.aborted) abort();
	let offset = "0";
	let done = false;
	const observation = context.supervisor.initialObservation(task, launch.wait).finally(() => {
		done = true;
	});
	const drain = async (): Promise<boolean> => {
		const page = await context.supervisor.readTaskOutput(task, { start: offset, maximumBytes: 64 * 1024 });
		if (!page.ok) throw new Error(page.error.message);
		const segments = [
			...page.value.chunks.map((chunk) => ({ offsets: chunk.offsets, bytes: Buffer.from(chunk.bytes) })),
			...page.value.omittedRanges.map((offsets) => ({
				offsets,
				bytes: Buffer.from(`\n[Output omitted: bytes ${offsets.start}-${offsets.end}]\n`),
			})),
		].sort((a, b) => (BigInt(a.offsets.start) < BigInt(b.offsets.start) ? -1 : 1));
		for (const segment of segments) {
			launch.onData?.(segment.bytes);
			offset = segment.offsets.end;
		}
		if (page.value.nextOffset !== undefined) offset = page.value.nextOffset;
		return page.value.nextOffset !== undefined;
	};
	try {
		while (!done) {
			if (!(await drain())) await poll(10);
		}
		const observed = await observation;
		if (!observed.ok) throw new Error(`${observed.error.code}: ${observed.error.message}`);
		// What the work wrote before the observation ended, including all of it once it settled.
		while (await drain()) {}
		if (observed.value.kind === "settled" && observed.value.result.kind === "cancelled")
			launch.signal?.throwIfAborted();
		return {
			taskId,
			timedOut: timedOut.value,
			exitCode: observed.value.kind === "settled" && observed.value.result.kind === "completed" ? 0 : null,
			observation: observed.value,
		};
	} finally {
		launch.signal?.removeEventListener("abort", abort);
	}
}
