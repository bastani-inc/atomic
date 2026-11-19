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
	private readonly generations = new Map<string, number>();
	private readonly runs = new Map<string, { work: PoolWorkToken; liveStages: ReadonlySet<string> }>();

	constructor(private readonly isLive: (stage: StageSnapshot) => boolean) {}

	/** The attempt on another host whose activity relayed `runId` last; undefined once no other host runs it. */
	attemptOf(runId: string): PoolWorkToken | undefined {
		return this.runs.get(runId)?.work;
	}

	/**
	 * Takes in an attempt's relayed runs, and returns the views it ends: a view of an earlier attempt of the work, which
	 * reconnects to this one, and a view of a stage that finished.
	 */
	relayed(work: PoolWorkToken, runs: readonly RunSnapshot[]): [WatchId, WatchEndReason][] {
		this.generations.set(work.id, work.generation);
		for (const run of runs)
			this.runs.set(run.id, {
				work,
				liveStages: new Set(run.stages.filter(this.isLive).map((s) => s.id)),
			});
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
		this.generations.delete(workId);
		for (const [id, run] of this.runs) if (run.work.id === workId) this.runs.delete(id);
		const ended = [...this.watches].filter(([, watch]) => watch.work.id === workId).map(([id]) => id);
		for (const id of ended) this.watches.delete(id);
		return ended;
	}

	/** A fence or finish takes effect at relay time; a new watch uses only the root's acknowledged attempt. */
	open(
		id: WatchId,
		runId: string,
		stage: StageSnapshot,
		accepted: PoolWorkToken | undefined,
	): PoolWorkToken | "pending" | undefined {
		const run = this.runs.get(runId);
		if (!run?.liveStages.has(stage.id)) return undefined;
		if (accepted?.id !== run.work.id || accepted.generation !== this.generations.get(run.work.id)) return "pending";
		if (!this.isLive(stage)) return undefined;
		this.watches.set(id, { work: accepted, runId, stageId: stage.id });
		return accepted;
	}

	get(id: WatchId): RemoteStageWatch | undefined {
		return this.watches.get(id);
	}

	/** Closes a view; false when it is not one of these. */
	close(id: WatchId): boolean {
		return this.watches.delete(id);
	}
}
