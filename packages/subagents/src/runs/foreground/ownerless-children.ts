import { randomUUID } from "node:crypto";
import { spanElapsedMs, type TaskElapsedSpan } from "@bastani/atomic";
import type { AgentSource } from "../../agents/agent-types.js";
import type { RunSyncOptions, SingleResult } from "../../shared/types.js";
import { isExecutionTicket } from "../shared/parallel-utils.js";
import { type AdmittedSubagentChild, admittedSubagentChild, recordSubagentAdmission } from "./released-child-resume.js";
import {
	beginWorktreeExecution,
	boundedWorktreeReply,
	childWorktreeFinishing,
	claimRunWorktree,
	parkRunWorktree,
	runWorktreeRecord,
	unparkRunWorktree,
} from "./run-worktrees.js";
import {
	pendingMessagesOfResult,
	requestSubagentChildStop,
	type SubagentChildLaunch,
	type SubagentChildPendingMessages,
	type SubagentChildRecordInput,
	type SubagentChildRecordSink,
	type SubagentChildStopStatus,
	subagentChildId,
	subagentChildInheritance,
	subagentChildLaunch,
	subagentChildModelChoice,
	subagentChildTask,
	subagentChildTitle,
	takeSubagentChildStop,
} from "./subagent-child-records.js";
import { runUnboundParallelTask } from "./subagent-executor-parallel-task.js";
import { forgetRunMembership, queuedResumeStart, rememberSubagentChildSchedule } from "./task-execution.js";

/**
 * Children a session without a task host (an SDK session) launched directly, recorded like task-host launches so
 * `pause`, `resume` and `quit` reach them (#3784). Each launch has an id of its own that stands in for the host's
 * task id in its child records; live launches are found by it while this process runs them.
 */
interface OwnerlessLaunch {
	readonly stop: (status: SubagentChildStopStatus) => Promise<void>;
	/** Whether a slot in its run dispatched it; a child stopped before then never starts. */
	dispatched: boolean;
}

// An SDK launch stays live across extension evaluation; its stop and settlement remove it from this same table.
const LIVE_LAUNCHES = Symbol.for("@bastani/subagents/live-sdk-launches@1");
const processLaunches = globalThis as { [LIVE_LAUNCHES]?: Map<string, OwnerlessLaunch> };
const liveLaunches = processLaunches[LIVE_LAUNCHES] ?? new Map<string, OwnerlessLaunch>();
processLaunches[LIVE_LAUNCHES] = liveLaunches;

export interface OwnerlessChildLaunch {
	/** Stands in for the host's task id in the child's records. */
	readonly launchId: string;
	readonly result: Promise<SingleResult>;
}

/** How a child that pause or quit stopped before it was dispatched starts later, on its original launch. */
export type OwnerlessQueuedStart = (launch: {
	readonly recordChild: SubagentChildRecordSink;
	/** The resuming session's lifetime: closing it stops the child, which reopening that session restores. */
	readonly ownerSignal?: AbortSignal;
	/** Delivered after its original task, which it never started. */
	readonly message?: string;
	readonly supervisorAuthorization?: RunSyncOptions["supervisorAuthorization"];
}) => OwnerlessChildLaunch;

const stoppedQueued = new Map<string, OwnerlessQueuedStart>();

/** The SDK children still live for this owner, including a launch whose first record has not been saved. */
export function* liveOwnerlessAdmissions(ownerSessionId: string): Iterable<AdmittedSubagentChild> {
	for (const launch of liveLaunches.values()) {
		const admitted = admittedSubagentChild(launch, ownerSessionId);
		if (admitted) yield admitted;
	}
}

/** Whether this process runs the launch, queued or started. */
export function isLiveOwnerlessChild(launchId: string): boolean {
	return liveLaunches.has(launchId);
}

/** Whether the launch waits for a slot in its run and has not started. */
export function isQueuedOwnerlessChild(launchId: string): boolean {
	return liveLaunches.get(launchId)?.dispatched === false;
}

/** Stop a live launch resumably, as pause or quit; settles once it stopped and its record says how. */
export async function stopOwnerlessChild(launchId: string, status: SubagentChildStopStatus): Promise<boolean> {
	const launch = liveLaunches.get(launchId);
	if (!launch) return false;
	await launch.stop(status);
	return true;
}

/** Take how to start a child that was stopped before it started, while this process still has it. */
export function takeStoppedQueuedOwnerlessChild(launchId: string): OwnerlessQueuedStart | undefined {
	const start = stoppedQueued.get(launchId);
	stoppedQueued.delete(launchId);
	return start;
}

const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

/**
 * Launch a child no task host owns, recording it in the owner's session as a task-host launch is: running at launch
 * and once its own session exists, then how it settled, with what it had queued when pause or quit stopped it.
 * With `schedule` it waits for a slot in its run, and so does every resume of it. The launch holds its run's
 * worktrees until it ends.
 */
export function runOwnerlessChild(input: {
	readonly agent: string;
	/** Where the agent definition the launch resolved came from. */
	readonly agentSource?: AgentSource;
	/** Whether the child was launched with `context: "fork"`; by default, whether `options` fork a session for it. */
	readonly forked?: boolean;
	readonly task: string;
	/** The child's working directory, as its records name it. */
	readonly cwd: string;
	readonly options: RunSyncOptions;
	/**
	 * The owning session's lifetime. Closing it stops the child without settling it: the child stays `running`, with
	 * what it had queued and not read, so reopening the session restores it as it restores a task-host child.
	 */
	readonly ownerSignal?: AbortSignal;
	readonly recordChild: SubagentChildRecordSink;
	readonly schedule?: (dispatch: () => Promise<void>) => void;
	readonly runSync: (task: string, options: RunSyncOptions) => Promise<SingleResult>;
}): OwnerlessChildLaunch {
	const launchId = `sdk-${randomUUID()}`;
	const runId = input.options.runId;
	const index = input.options.index ?? 0;
	const stopper = new AbortController();
	const signal = AbortSignal.any(
		[input.options.signal, input.ownerSignal, stopper.signal].filter((candidate) => candidate !== undefined),
	);
	let childSession: Pick<SubagentChildRecordInput, "childSessionId" | "childSessionFile"> = {};
	let childLaunch: Pick<
		SubagentChildRecordInput,
		"launchModel" | "launchThinkingLevel" | "launchLeafId" | "launchLeafSeq"
	> = {};
	let elapsedSpan: TaskElapsedSpan | undefined;
	let exitTime: number | undefined;
	let stoppedBeforeDispatch = false;
	const forked = input.forked ?? (input.options.sessionManager !== undefined && input.options.resumeSession !== true);
	const record = (
		state: SubagentChildRecordInput["state"],
		terminalStatus?: string,
		held?: SubagentChildPendingMessages,
		queuedLaunch?: SubagentChildLaunch,
	) => {
		const worktree = runWorktreeRecord(runId, index);
		input.recordChild.record({
			runId,
			index,
			agent: input.agent,
			...(input.agentSource ? { agentSource: input.agentSource } : {}),
			forked,
			state,
			elapsedMs: elapsedSpan ? spanElapsedMs(elapsedSpan, exitTime) : 0,
			elapsedSpan: elapsedSpan ? { ...elapsedSpan } : null,
			cwd: input.cwd,
			taskId: launchId,
			...childSession,
			...childLaunch,
			...(input.options.intercomSessionName ? { intercomTarget: input.options.intercomSessionName } : {}),
			...(input.options.intercomGroup ? { intercomGroup: input.options.intercomGroup } : {}),
			...(input.options.orchestratorIntercomTarget
				? { orchestratorTarget: input.options.orchestratorIntercomTarget }
				: {}),
			...subagentChildTask(input.task, input.options),
			...subagentChildTitle(input.task, input.options),
			...(worktree ? { worktree } : {}),
			...(terminalStatus ? { terminalStatus } : {}),
			...(held?.messages.length ? { heldMessages: { taskId: launchId, ...held } } : {}),
			...(queuedLaunch
				? { launch: queuedLaunch }
				: held?.taskExpands && input.options.resumeSession !== true && childSession.childSessionId === undefined
					? // It stopped before its session existed, holding its unread task: only its launch can start it again.
						{ launch: subagentChildLaunch(input.task, undefined, input.options) }
					: {}),
			inherited: subagentChildInheritance(input.options),
			...subagentChildModelChoice(input.options),
		});
	};
	const settled = Promise.withResolvers<void>();
	const finishWorktree = beginWorktreeExecution(runId, index, input.cwd, () => launchId, input.options.intercomEvents);
	let finishing = false;
	const launch: OwnerlessLaunch = {
		dispatched: false,
		async stop(status) {
			if (finishing) return settled.promise;
			// It stays resumable: its worktree is kept if it has unsaved work when its run's worktrees are removed.
			parkRunWorktree(runId, index);
			if (launch.dispatched) {
				requestSubagentChildStop(launchId, status);
				stopper.abort();
				await settled.promise;
				return;
			}
			// It never starts, so nothing else records how it stopped; resuming it in this process starts it. It is not
			// live any more: its dispatch, still waiting for a slot, only drains once a slot frees.
			stoppedBeforeDispatch = true;
			liveLaunches.delete(launchId);
			stopper.abort();
			stoppedQueued.set(launchId, (resumed) =>
				runOwnerlessChild({
					...input,
					...(input.schedule
						? { schedule: isExecutionTicket(input.schedule) ? input.schedule.scheduler : input.schedule }
						: {}),
					forked,
					...queuedResumeStart(input.task, input.options, resumed.message),
					options: {
						...queuedResumeStart(input.task, input.options, resumed.message).options,
						cwdVerdict: undefined,
						signal: undefined,
						supervisorAuthorization: resumed.supervisorAuthorization,
					},
					ownerSignal: resumed.ownerSignal,
					recordChild: resumed.recordChild,
				}),
			);
			const swept = finishWorktree?.(status);
			record("terminal", status);
			if (swept) await swept;
			finish();
			await input.recordChild.flushed?.();
		},
	};
	const finish = () => {
		liveLaunches.delete(launchId);
		settled.resolve();
	};
	const recordExit = async (
		child: SingleResult,
		onBackground?: (result: SingleResult) => void,
	): Promise<SingleResult> => {
		const stopped = takeSubagentChildStop(launchId);
		const stoppedByControl = stopped !== undefined && child.status === "interrupted";
		const ownerClosed = !stoppedByControl && child.status === "interrupted" && input.ownerSignal?.aborted === true;
		// Run control marked it stopped before it stopped it; a child that ended otherwise is not stopped.
		if (stopped !== undefined && !stoppedByControl) unparkRunWorktree(runId, index);
		if (child.status === "killed") forgetRunMembership(runId, index);
		// Its owner closed, which ends nothing: it stays restorable, with its worktree and unread messages.
		if (ownerClosed) parkRunWorktree(runId, index);
		const status = stoppedByControl ? stopped : child.status;
		if (finishWorktree) {
			exitTime = Date.now();
			finishing = true;
		}
		const swept = finishWorktree?.(status);
		if (ownerClosed) record("running", undefined, pendingMessagesOfResult(child));
		else record("terminal", status, stoppedByControl ? pendingMessagesOfResult(child) : undefined);
		if (!swept) {
			finish();
			return child;
		}
		const published = swept.then(finish);
		if (onBackground) {
			const note = await boundedWorktreeReply(runId, published);
			if (note && childWorktreeFinishing({ runId, index, taskId: launchId })) {
				void published.then(() => onBackground(child));
				return {
					...child,
					status: "continued",
					interrupted: false,
					detached: true,
					detachedReason: "worktree-cleanup",
					worktreeNote: note,
				};
			}
			child.worktreeNote = note;
		} else await published;
		return child;
	};
	const execute = async (options: RunSyncOptions): Promise<SingleResult> => {
		launch.dispatched = true;
		if (stoppedBeforeDispatch) {
			if (finishWorktree) await finishWorktree();
			finish();
			return {
				agent: input.agent,
				task: input.task,
				status: "interrupted",
				interrupted: true,
				messages: [],
				usage: NO_USAGE,
				progressSummary: { durationMs: 0, tokens: 0, toolCount: 0 },
			};
		}
		elapsedSpan = { dispatchedAt: Date.now() };
		record("running");
		// This execution owns the child's worktree now; a stopped child's worktree was kept for it until here.
		claimRunWorktree(runId, index);
		try {
			const running = input.runSync(input.task, {
				...options,
				elapsedSpan,
				onElapsedSpanChanged: () => record("running"),
				signal,
				onDetachedExit: async (child) => {
					try {
						await recordExit(child);
					} finally {
						finish();
						options.onDetachedExit?.(child);
					}
				},
				onChildSession: (session) => {
					childSession = {
						childSessionId: session.sessionId,
						...(session.sessionFile ? { childSessionFile: session.sessionFile } : {}),
					};
					record("running");
				},
				onChildLaunch: (started) => {
					childLaunch = {
						...(started.model ? { launchModel: started.model } : {}),
						...(started.thinking ? { launchThinkingLevel: started.thinking } : {}),
						launchLeafId: started.leafId,
						...(started.leafSeq === undefined ? {} : { launchLeafSeq: started.leafSeq }),
					};
					record("running");
				},
			});
			if (isExecutionTicket(input.schedule)) input.schedule.onEntered();
			const child = await running;
			// Handoff settles only the caller's observation. The launch, its stop and its worktree live until exit.
			return child.detached
				? child
				: await recordExit(child, input.options.onDetachedExit ? options.onDetachedExit : undefined);
		} catch (error) {
			if (isExecutionTicket(input.schedule)) input.schedule.onEntered();
			if (takeSubagentChildStop(launchId) !== undefined) unparkRunWorktree(runId, index);
			if (finishWorktree) {
				// Sample at failure without adding an end to a span the runner left open.
				exitTime = Date.now();
				finishing = true;
			}
			const swept = finishWorktree?.("error");
			// Its owner closed: its latest record stays `running`, so reopening the owner restores it.
			if (input.ownerSignal?.aborted !== true) record("terminal", "error");
			if (swept) await swept;
			finish();
			throw error;
		}
	};
	liveLaunches.set(launchId, launch);
	// Pause or quit right after the launch must find the child, also while it waits for a slot. Nothing of a queued
	// launch survives a restart but its records: they say how to start it fresh then.
	const schedule = input.schedule;
	record(
		"running",
		undefined,
		undefined,
		schedule ? subagentChildLaunch(input.task, undefined, input.options) : undefined,
	);
	if (input.recordChild.ownerSessionId !== undefined)
		recordSubagentAdmission(launch, {
			ownerSessionId: input.recordChild.ownerSessionId,
			childId: subagentChildId(runId, index),
			runId,
			agent: input.agent,
			taskId: launchId,
			intercomTarget: input.options.intercomSessionName,
		});
	if (schedule) rememberSubagentChildSchedule(runId, index, schedule);
	const result = runUnboundParallelTask(
		input.options,
		input.agent,
		input.task,
		(dispatch) => {
			if (schedule) {
				schedule(dispatch);
				if (isExecutionTicket(schedule)) schedule.onObserved();
			} else {
				void dispatch().catch((error: unknown) =>
					console.error("atomic-subagents: child worktree cleanup failed", error),
				);
			}
		},
		execute,
	);
	return { launchId, result };
}

/** Children launched without a task host that are live or stopped while queued; counted by tests and the benchmark. */
export function ownerlessChildCounts(): { readonly live: number; readonly stoppedQueued: number } {
	return { live: liveLaunches.size, stoppedQueued: stoppedQueued.size };
}
