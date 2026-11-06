import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import type { PoolWorkToken } from "./coordinator-protocol.js";
import type { WatchEndReason, WatchId } from "./stage-watch-types.js";

/** A view of a stage that runs on another host's worker, bound to the attempt it opened on (#4391). */
export interface RemoteStageWatch {
	readonly work: PoolWorkToken;
	readonly runId: string;
	readonly stageId: string;
}

/**
 * The root's views of stages that run on other hosts' workers (#4391), with the attempt that last relayed each run. No
 * events stream to such a view: its user text goes through the stage's input queue, and it ends when relayed activity
 * shows its attempt replaced or its stage finished, or when a worker of the root's own host takes its work over.
 */
export class RemoteStageWatches {
	private readonly watches = new Map<WatchId, RemoteStageWatch>();
	private readonly attempts = new Map<string, PoolWorkToken>();

	constructor(private readonly isLive: (stage: StageSnapshot) => boolean) {}

	/** The attempt on another host whose activity relayed `runId` last; undefined once no other host runs it. */
	attemptOf(runId: string): PoolWorkToken | undefined {
		return this.attempts.get(runId);
	}

	/**
	 * Takes in an attempt's relayed runs, and returns the views it ends: a view of an earlier attempt of the work, which
	 * reconnects to this one, and a view of a stage that finished.
	 */
	relayed(work: PoolWorkToken, runs: readonly RunSnapshot[]): [WatchId, WatchEndReason][] {
		for (const run of runs) this.attempts.set(run.id, work);
		const ended: [WatchId, WatchEndReason][] = [];
		for (const [id, watch] of this.watches) {
			if (watch.work.id !== work.id) continue;
			const stage = runs
				.find((run) => run.id === watch.runId)
				?.stages.find((candidate) => candidate.id === watch.stageId);
			if (watch.work.generation !== work.generation) ended.push([id, "attempt_fenced"]);
			else if (stage !== undefined && !this.isLive(stage)) ended.push([id, "stage_finished"]);
		}
		for (const [id] of ended) this.watches.delete(id);
		return ended;
	}

	/**
	 * A worker of the root's own host took the work `workId` over: its runs no longer run elsewhere, and the views of
	 * them end as fenced, to reconnect to that worker's attempt.
	 */
	takenOver(workId: string): WatchId[] {
		for (const [runId, work] of [...this.attempts]) if (work.id === workId) this.attempts.delete(runId);
		const ended = [...this.watches].filter(([, watch]) => watch.work.id === workId).map(([id]) => id);
		for (const id of ended) this.watches.delete(id);
		return ended;
	}

	/** Opens a view of `stageId` of `runId` on the attempt that relayed it, while the stage is live; undefined otherwise. */
	open(id: WatchId, runId: string, stageId: string, stage: StageSnapshot): PoolWorkToken | undefined {
		const work = this.attempts.get(runId);
		if (work === undefined || !this.isLive(stage)) return undefined;
		this.watches.set(id, { work, runId, stageId });
		return work;
	}

	get(id: WatchId): RemoteStageWatch | undefined {
		return this.watches.get(id);
	}

	/** Closes a view; false when it is not one of these. */
	close(id: WatchId): boolean {
		return this.watches.delete(id);
	}
}
