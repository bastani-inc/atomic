import { randomUUID } from "node:crypto";
import type { RunSyncOptions, SingleResult } from "../../shared/types.js";
import {
	claimRunWorktree,
	holdRunWorktree,
	parkRunWorktree,
	runWorktreeRecord,
	unparkRunWorktree,
} from "./run-worktrees.js";
import {
	requestSubagentChildStop,
	type SubagentChildRecordInput,
	type SubagentChildRecordSink,
	type SubagentChildStopStatus,
	takeSubagentChildStop,
} from "./subagent-child-records.js";
import { runUnboundParallelTask } from "./subagent-executor-parallel-task.js";

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

const liveLaunches = new Map<string, OwnerlessLaunch>();

export interface OwnerlessChildLaunch {
	/** Stands in for the host's task id in the child's records. */
	readonly launchId: string;
	readonly result: Promise<SingleResult>;
}

/** How a child that pause or quit stopped before it was dispatched starts later, on its original launch. */
export type OwnerlessQueuedStart = (launch: {
	readonly recordChild: SubagentChildRecordSink;
	/** Delivered after its original task, which it never started. */
	readonly message?: string;
	readonly supervisorAuthorization?: RunSyncOptions["supervisorAuthorization"];
}) => OwnerlessChildLaunch;

const stoppedQueued = new Map<string, OwnerlessQueuedStart>();

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
 * With `schedule` it waits for a slot in its run. The launch holds its run's worktrees until it ends.
 */
export function runOwnerlessChild(input: {
	readonly agent: string;
	readonly task: string;
	/** The child's working directory, as its records name it. */
	readonly cwd: string;
	readonly options: RunSyncOptions;
	readonly recordChild: SubagentChildRecordSink;
	readonly schedule?: (dispatch: () => Promise<void>) => void;
	readonly runSync: (task: string, options: RunSyncOptions) => Promise<SingleResult>;
}): OwnerlessChildLaunch {
	const launchId = `sdk-${randomUUID()}`;
	const runId = input.options.runId;
	const index = input.options.index ?? 0;
	const stopper = new AbortController();
	const signal = input.options.signal ? AbortSignal.any([input.options.signal, stopper.signal]) : stopper.signal;
	let childSession: Pick<SubagentChildRecordInput, "childSessionId" | "childSessionFile"> = {};
	let childLaunch: Pick<SubagentChildRecordInput, "launchModel" | "launchThinkingLevel" | "launchLeafId"> = {};
	let stoppedBeforeDispatch = false;
	const record = (state: SubagentChildRecordInput["state"], terminalStatus?: string, held?: readonly string[]) => {
		const worktree = runWorktreeRecord(runId, index);
		input.recordChild.record({
			runId,
			index,
			agent: input.agent,
			state,
			cwd: input.cwd,
			taskId: launchId,
			...childSession,
			...childLaunch,
			...(input.options.intercomSessionName ? { intercomTarget: input.options.intercomSessionName } : {}),
			...(input.options.intercomGroup ? { intercomGroup: input.options.intercomGroup } : {}),
			...(input.options.orchestratorIntercomTarget
				? { orchestratorTarget: input.options.orchestratorIntercomTarget }
				: {}),
			...(worktree ? { worktree } : {}),
			...(terminalStatus ? { terminalStatus } : {}),
			...(held?.length ? { heldMessages: { taskId: launchId, messages: held } } : {}),
		});
	};
	const settled = Promise.withResolvers<void>();
	const launch: OwnerlessLaunch = {
		dispatched: false,
		async stop(status) {
			// It stays resumable: its worktree is kept if it has unsaved work when its run's worktrees are removed.
			parkRunWorktree(runId, index);
			if (launch.dispatched) {
				requestSubagentChildStop(launchId, status);
				stopper.abort();
				await settled.promise;
				return;
			}
			// It never starts, so nothing else records how it stopped; resuming it in this process starts it.
			stoppedBeforeDispatch = true;
			stopper.abort();
			stoppedQueued.set(launchId, (resumed) =>
				runOwnerlessChild({
					...input,
					task: resumed.message ? `${input.task}\n\n${resumed.message}` : input.task,
					options: {
						...input.options,
						signal: undefined,
						supervisorAuthorization: resumed.supervisorAuthorization,
					},
					recordChild: resumed.recordChild,
				}),
			);
			record("terminal", status);
			await input.recordChild.flushed?.();
		},
	};
	const execute = async (options: RunSyncOptions): Promise<SingleResult> => {
		launch.dispatched = true;
		if (stoppedBeforeDispatch)
			return {
				agent: input.agent,
				task: input.task,
				status: "interrupted",
				interrupted: true,
				messages: [],
				usage: NO_USAGE,
			};
		// This execution owns the child's worktree now; a stopped child's worktree was kept for it until here.
		claimRunWorktree(runId, index);
		try {
			const child = await input.runSync(input.task, {
				...options,
				signal,
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
					};
					record("running");
				},
			});
			const stopped = takeSubagentChildStop(launchId);
			const stoppedByControl = stopped !== undefined && child.status === "interrupted";
			// Run control marked it stopped before it stopped it; a child that ended otherwise is not stopped.
			if (stopped !== undefined && !stoppedByControl) unparkRunWorktree(runId, index);
			// A child that stays resumable keeps what it had queued and not read, for its resume.
			record(
				"terminal",
				stoppedByControl ? stopped : child.status,
				stoppedByControl ? child.pendingMessages : undefined,
			);
			return child;
		} catch (error) {
			if (takeSubagentChildStop(launchId) !== undefined) unparkRunWorktree(runId, index);
			record("terminal", "error");
			throw error;
		}
	};
	liveLaunches.set(launchId, launch);
	// Pause or quit right after the launch must find the child, also while it waits for a slot.
	record("running");
	const schedule = input.schedule;
	const result = (
		schedule
			? runUnboundParallelTask(
					input.options,
					input.agent,
					input.task,
					(dispatch) => {
						const release = holdRunWorktree(runId, index);
						schedule(() => dispatch().finally(release));
					},
					execute,
				)
			: (async () => {
					const release = holdRunWorktree(runId, index);
					try {
						return await execute(input.options);
					} finally {
						release();
					}
				})()
	).finally(() => {
		liveLaunches.delete(launchId);
		settled.resolve();
	});
	return { launchId, result };
}
