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

/** An index with what it was counted from, so the index of the run's next version can be derived from it. */
interface IndexedStages {
	readonly index: RunStageIndex;
	/** Stages that ask for input, finished or not. */
	readonly asking: number;
	/** Positions of the stages that are not finished, in run order. */
	readonly unfinished: readonly number[];
}

const indexes = new WeakMap<object, IndexedStages>();

function asksForInput(stage: StageSnapshot): boolean {
	return (
		stage.pendingPrompt !== undefined ||
		stage.inputRequest !== undefined ||
		stage.status === "awaiting_input" ||
		stage.awaitingInputSince !== undefined
	);
}

function isFinished(stage: StageSnapshot): boolean {
	return stage.status === "completed" || stage.status === "failed" || stage.status === "skipped";
}

/** The index of `stages` from the unfinished ones, which are the only ones that can be pending or waiting. */
function indexFrom(stages: readonly StageSnapshot[], asking: number, unfinished: readonly number[]): IndexedStages {
	const pending: StageSnapshot[] = [];
	const waiting: StageSnapshot[] = [];
	for (const position of unfinished) {
		const stage = stages[position]!;
		if (stage.status === "pending") pending.push(stage);
		if (asksForInput(stage)) waiting.push(stage);
	}
	return { index: { awaitingInput: asking > 0, pending, waiting }, asking, unfinished };
}

function buildIndex(stages: readonly StageSnapshot[]): IndexedStages {
	let asking = 0;
	const unfinished: number[] = [];
	stages.forEach((stage, position) => {
		if (asksForInput(stage)) asking++;
		if (!isFinished(stage)) unfinished.push(position);
	});
	return indexFrom(stages, asking, unfinished);
}

/**
 * The index of a run's stages. A graph snapshot is deep-frozen per store version and shares each run it did not change
 * with the version before, so the index of a frozen run is built once for as long as the run lives. A run that is not
 * frozen may change after it is read, so its index is built again on every call.
 */
export function runStageIndex(run: Pick<RunSnapshot, "stages">): RunStageIndex {
	const known = indexes.get(run);
	if (known !== undefined) return known.index;
	const built = buildIndex(run.stages);
	if (Object.isFrozen(run)) indexes.set(run, built);
	return built.index;
}

/**
 * Indexes `run`, a frozen version of `previous` whose stages are the same objects except at `changed` positions and
 * from `appendedFrom` on, from the index of `previous` when it has one: a store change reads the stages it touched and
 * the unfinished ones rather than every stage the run finished (#4642). The graph snapshot builder calls this.
 */
export function indexRunFrom(
	run: Pick<RunSnapshot, "stages">,
	previous: Pick<RunSnapshot, "stages">,
	changed: Iterable<number>,
	appendedFrom: number,
): void {
	const known = indexes.get(previous);
	if (known === undefined || !Object.isFrozen(run)) return;
	let asking = known.asking;
	const unfinished = new Set(known.unfinished);
	const update = (position: number, before: StageSnapshot | undefined): void => {
		const stage = run.stages[position]!;
		if (before !== undefined && asksForInput(before)) asking--;
		if (asksForInput(stage)) asking++;
		if (isFinished(stage)) unfinished.delete(position);
		else unfinished.add(position);
	};
	for (const position of changed) update(position, previous.stages[position]);
	for (let position = appendedFrom; position < run.stages.length; position++) update(position, undefined);
	indexes.set(
		run,
		indexFrom(
			run.stages,
			asking,
			[...unfinished].sort((left, right) => left - right),
		),
	);
}
