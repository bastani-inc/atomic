import type { StageWaitKind } from "../shared/authoring-contract-stage.js";
import { isTerminalStageStatus } from "../shared/store-internal.js";
import type { RunSnapshot } from "../shared/store-types.js";

/** Waits only something outside the attempt ends: a detached tool call's result, or a person's answer. */
const OUTSIDE_WAITS: ReadonlySet<StageWaitKind> = new Set<StageWaitKind>(["tool", "prompt"]);

/**
 * Whether an attempt waits on nothing it runs itself, as the runs it published show: it has a live stage, every live
 * stage waits with its session released for a detached tool call's result or a person's answer, and none of its
 * durable tool calls runs. A stage the workflow merely holds released (`stage.release()`, idle) does not count: the
 * workflow itself may be busy meanwhile.
 */
export function attemptWaitsReleased(runs: readonly RunSnapshot[]): boolean {
	let waits = false;
	for (const run of runs) {
		if (run.toolNodes.some((node) => node.status === "running")) return false;
		for (const stage of run.stages) {
			if (isTerminalStageStatus(stage.status)) continue;
			if (stage.wait === undefined || !OUTSIDE_WAITS.has(stage.wait.kind)) return false;
			waits = true;
		}
	}
	return waits;
}

/**
 * The workers a pool runs beyond its `count` so attempts that wait released stop occupying the pool: one per waiting
 * attempt, at most `count` of them. A worker that runs a waiting attempt keeps it, so nothing runs twice and no result
 * moves; once fewer attempts wait than extra workers run, an idle worker ends.
 */
export class WaitingWorkerReserve {
	private extra = 0;

	/** Extra workers running or starting. */
	get size(): number {
		return this.extra;
	}

	/** How many more workers to start now that `waiting` attempts wait released; they count as started. */
	grow(waiting: number, count: number): number {
		const wanted = Math.max(0, Math.min(waiting, count) - this.extra);
		this.extra += wanted;
		return wanted;
	}

	/** Whether an idle worker ends now, because fewer than the extra workers' attempts wait; it no longer counts. */
	shrink(waiting: number, count: number): boolean {
		if (this.extra <= Math.min(waiting, count)) return false;
		this.extra -= 1;
		return true;
	}

	/** An extra worker could not start: it no longer counts. */
	lost(): void {
		this.extra = Math.max(0, this.extra - 1);
	}
}
