import type { Store } from "../../shared/store.js";
import { isTerminalRunStatus } from "../../shared/store-internal.js";
import type { StageSnapshot } from "../../shared/store-types.js";
import { isTerminalStage } from "./executor-scheduler.js";

/** Whether the run ended killed or cancelled, which ends the stages it still had in flight (#4875). */
export function runEndedInFlightStages(store: Store, runId: string): boolean {
	const status = store.run(runId)?.status;
	return status === "killed" || status === "cancelled";
}

/**
 * A stage whose call stopped before its run decided how it ends finalizes unfinished. When the run then ends killed
 * or cancelled, the store ends that stage (#4875) and `persist` records the end it was given; when the run ends
 * otherwise, the stage keeps what it recorded.
 */
export function persistStageEndWhenRunEndsIt(
	store: Store,
	runId: string,
	stage: StageSnapshot,
	persist: () => Promise<void>,
): void {
	const unsubscribe = store.subscribe(() => {
		const run = store.run(runId);
		if (run !== undefined && !isTerminalRunStatus(run.status)) return;
		unsubscribe();
		if (runEndedInFlightStages(store, runId) && isTerminalStage(stage)) void persist().catch(() => {});
	});
}
