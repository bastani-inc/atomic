import { isTerminalStageStatus } from "./store-internal.js";
import type { RunSnapshot, StageSnapshot } from "./store-types.js";

/**
 * The few stages of a run that status surfaces ask about on every repaint: the ones waiting to start and the ones
 * waiting for input. A long run is mostly finished stages, so repaints look at these and never walk
 * the rest (#4642).
 */
export interface RunStageIndex {
	/** Whether any stage, finished or not, awaits input or holds a prompt or an input request. */
	readonly awaitingInput: boolean;
	/** Stages whose status is `pending`, in run order. */
	readonly pending: readonly StageSnapshot[];
	/** Stages that are not finished and await input or hold a pending prompt or an input request, in run order. */
	readonly waiting: readonly StageSnapshot[];
}

const indexes = new WeakMap<object, RunStageIndex>();

function buildIndex(stages: readonly StageSnapshot[]): RunStageIndex {
	let awaitingInput = false;
	const pending: StageSnapshot[] = [];
	const waiting: StageSnapshot[] = [];
	for (const stage of stages) {
		const asksForInput =
			stage.pendingPrompt !== undefined ||
			stage.inputRequest !== undefined ||
			stage.status === "awaiting_input" ||
			stage.awaitingInputSince !== undefined;
		if (asksForInput) awaitingInput = true;
		if (stage.status === "pending") pending.push(stage);
		if (asksForInput && !isTerminalStageStatus(stage.status)) waiting.push(stage);
	}
	return { awaitingInput, pending, waiting };
}

/**
 * The index of a run's stages. A graph snapshot is deep-frozen per store version and shares each run it did not change
 * with the version before, so the index of a frozen run is built once for as long as the run lives. A run that is not
 * frozen may change after it is read, so its index is built again on every call.
 */
export function runStageIndex(run: Pick<RunSnapshot, "stages">): RunStageIndex {
	const known = indexes.get(run);
	if (known !== undefined) return known;
	const built = buildIndex(run.stages);
	if (Object.isFrozen(run)) indexes.set(run, built);
	return built;
}
