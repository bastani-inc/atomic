import { workerHost } from "../durable/journal/sql-shared-pool.js";
import { isTerminalStageStatus } from "../shared/store-internal.js";
import type { PendingStageMessage } from "../shared/store-types.js";
import type { PublishedStages } from "./open-stages.js";

interface StageRef {
	readonly runId: string;
	readonly stageId: string;
}

/** One live stage on another host's worker whose queued Intercom messages the root drains into it (#4391). */
export interface RemoteStageDrainTarget extends StageRef {
	readonly sessionId: string;
	readonly generation: number;
	/** The queues the drain reads (the stage's run's and the root run's), by identity: a new list is a change. */
	readonly queues: readonly (readonly PendingStageMessage[] | undefined)[];
}

/** Whether `worker` runs on a host other than `host`, the root's: its stages hold no live route of the root's (#4391). */
export function runsOnOtherHost(host: string | undefined, worker: string | null | undefined): worker is string {
	return host !== undefined && typeof worker === "string" && workerHost(worker) !== host;
}

/**
 * The drains the root offers for the stages an attempt `generation` on another host published (#4391): one for each
 * stage whose session takes Intercom messages now, with the queues it reads. The other stages are forgotten, so their
 * next publication that can take messages drains them: a stage with no session yet, one released while it waits
 * (#4418), one whose session has no Intercom, and one that ended.
 */
export function remoteStageDrainTargets(
	generation: number,
	runs: readonly PublishedStages[],
	queueOf: (runId: string) => readonly PendingStageMessage[] | undefined,
	rootQueue: readonly PendingStageMessage[] | undefined,
): {
	readonly drain: readonly { readonly target: RemoteStageDrainTarget; readonly stageName: string }[];
	readonly forget: readonly StageRef[];
} {
	const drain: { readonly target: RemoteStageDrainTarget; readonly stageName: string }[] = [];
	const forget: StageRef[] = [];
	for (const run of runs) {
		const queues = [queueOf(run.id), rootQueue];
		for (const stage of run.stages) {
			const target = { runId: run.id, stageId: stage.id };
			const { sessionId } = stage;
			if (
				sessionId === undefined ||
				stage.status === "waiting" ||
				stage.pendingStageDeliveryAvailable !== true ||
				isTerminalStageStatus(stage.status)
			)
				forget.push(target);
			else drain.push({ target: { ...target, sessionId, generation, queues }, stageName: stage.name });
		}
	}
	return { drain, forget };
}

interface StageDrains {
	drained?: RemoteStageDrainTarget;
	running: boolean;
	/** The latest target offered while a drain ran, with its drain: it runs once that one finishes. */
	next?: { readonly target: RemoteStageDrainTarget; readonly drain: () => Promise<void> };
}

/**
 * Which drains the root runs for live stages on other hosts' workers (#4391). Such a stage holds no live route, so the
 * root drains its queued Intercom messages into it through the stage's input queue: once its session is published,
 * and again whenever its attempt, its session or a queue it reads changed since its last drain finished. A stage runs
 * one drain at a time; one offered meanwhile, such as a drain into the session that replaced the one being drained,
 * runs once it finishes. A drain that fails runs again on the stage's next publication.
 */
export class RemoteStageDrains {
	private readonly stages = new Map<string, StageDrains>();

	/** Runs `drain` for `target` unless the last drain of its stage that finished saw the same state. */
	offer(target: RemoteStageDrainTarget, drain: () => Promise<void>): void {
		const key = stageKey(target);
		const state = this.stages.get(key);
		if (state?.running === true) {
			state.next = { target, drain };
			return;
		}
		if (state?.drained !== undefined && unchanged(state.drained, target)) return;
		const next: StageDrains = { running: true };
		this.stages.set(key, next);
		void drain()
			.then(
				() => {
					next.drained = target;
				},
				// The handoff recorded the failure on the root run; the stage's next publication drains it again.
				() => undefined,
			)
			.finally(() => {
				next.running = false;
				const queued = next.next;
				next.next = undefined;
				if (queued !== undefined && this.stages.get(key) === next) this.offer(queued.target, queued.drain);
			});
	}

	/** Forgets a stage that cannot take messages now: nothing is drained into it until it is offered again. */
	forget(stage: StageRef): void {
		this.stages.delete(stageKey(stage));
	}
}

function stageKey(stage: StageRef): string {
	return JSON.stringify([stage.runId, stage.stageId]);
}

function unchanged(drained: RemoteStageDrainTarget, target: RemoteStageDrainTarget): boolean {
	return (
		drained.generation === target.generation &&
		drained.sessionId === target.sessionId &&
		drained.queues.length === target.queues.length &&
		drained.queues.every((queue, index) => queue === target.queues[index])
	);
}
