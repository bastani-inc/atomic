import { type BoundaryLifecycleResolution, resolveBoundaryLifecycleFromRecords } from "./boundary-lifecycle.js";
import { type DirectChildTopologyRecords, durableStageGroupKey } from "./stage-topology-validation.js";
import type { DurableCheckpoint, DurableStageCheckpoint } from "./types.js";

/**
 * Lookups over one checkpoint list, built once per reconstruction.
 *
 * Reconstruction validates every boundary, child run, and run group against the
 * whole list. Scanning the list for each of them made one reconstruction
 * O(boundaries × checkpoints). Each lookup here returns exactly the records the
 * scan selected, in checkpoint order, so validation results do not change.
 */
export class CheckpointCatalogIndex {
	readonly stages: readonly DurableStageCheckpoint[];
	private readonly positions = new Map<DurableCheckpoint, number>();
	private readonly groupKeys = new Map<DurableStageCheckpoint, string>();
	private readonly groups = new Map<string, DurableStageCheckpoint[]>();
	private readonly stagesByRunId = new Map<string, DurableStageCheckpoint[]>();
	private readonly boundariesByReplayKey = new Map<string, DurableStageCheckpoint[]>();
	private readonly boundariesByStageId = new Map<string, DurableStageCheckpoint[]>();
	private readonly boundariesByChildRunId = new Map<string, DurableStageCheckpoint[]>();
	private readonly outputsByReplayKey = new Map<string, DurableStageCheckpoint[]>();
	private evidence: ScopedEvidenceIndex | undefined;

	constructor(private readonly checkpoints: readonly DurableCheckpoint[]) {
		const stages: DurableStageCheckpoint[] = [];
		checkpoints.forEach((checkpoint, index) => {
			if (!this.positions.has(checkpoint)) this.positions.set(checkpoint, index);
			if (checkpoint.kind !== "stage") return;
			stages.push(checkpoint);
			const key = durableStageGroupKey(checkpoint);
			this.groupKeys.set(checkpoint, key);
			append(this.groups, key, checkpoint);
			const runId = checkpoint.topology?.run?.runId;
			if (runId !== undefined) append(this.stagesByRunId, runId, checkpoint);
			if (checkpoint.output !== undefined) append(this.outputsByReplayKey, checkpoint.replayKey, checkpoint);
			const boundary = checkpoint.topology?.boundary;
			if (boundary === undefined) return;
			append(this.boundariesByReplayKey, checkpoint.replayKey, checkpoint);
			append(this.boundariesByStageId, checkpoint.topology!.stageId, checkpoint);
			append(this.boundariesByChildRunId, boundary.child.runId, checkpoint);
		});
		this.stages = stages;
	}

	/** One-based checkpoint sequence, matching `checkpoints.indexOf(checkpoint) + 1`. */
	sequence(checkpoint: DurableCheckpoint): number {
		return (this.positions.get(checkpoint) ?? -1) + 1;
	}

	/** `groupByDurableStageKey(this.stages).values()`. */
	stageGroups(): IterableIterator<readonly DurableStageCheckpoint[]> {
		return this.groups.values();
	}

	/** `resolveBoundaryLifecycle(start, this.stages, requireTerminal)` without rescanning every stage. */
	boundaryLifecycle(start: DurableStageCheckpoint, requireTerminal: boolean): BoundaryLifecycleResolution {
		const topology = start.topology;
		const childRunId = topology?.boundary?.child.runId;
		const related = this.inCheckpointOrder([
			this.boundariesByReplayKey.get(start.replayKey),
			topology === undefined ? undefined : this.boundariesByStageId.get(topology.stageId),
			childRunId === undefined ? undefined : this.boundariesByChildRunId.get(childRunId),
		]);
		return resolveBoundaryLifecycleFromRecords(
			start,
			{ related, outputRecords: () => this.outputsByReplayKey.get(start.replayKey) ?? [] },
			requireTerminal,
		);
	}

	/** Records `directChildTopologyError(this.stages, …, run)` selects for one child run. */
	directChildRecords(childRunId: string): DirectChildTopologyRecords {
		return {
			claiming: this.stagesByRunId.get(childRunId) ?? [],
			direct: (claiming) =>
				this.inCheckpointOrder(
					[...new Set(claiming.map((stage) => this.groupKeys.get(stage)!))].map((key) => this.groups.get(key)),
				),
		};
	}

	/** Whether any raw record is scoped under a boundary replay key or claims the child run. */
	childScopedEvidenceExists(boundaryReplayKey: string, childRunId: string): boolean {
		this.evidence ??= scopedEvidenceIndex(this.checkpoints);
		return this.evidence.runIds.has(childRunId) || hasPrefix(this.evidence.identities, `${boundaryReplayKey}:`);
	}

	private inCheckpointOrder(
		lists: ReadonlyArray<readonly DurableStageCheckpoint[] | undefined>,
	): readonly DurableStageCheckpoint[] {
		const present = lists.filter((list): list is readonly DurableStageCheckpoint[] => list !== undefined);
		if (present.length === 1) return present[0]!;
		return [...new Set(present.flat())].sort((left, right) => this.sequence(left) - this.sequence(right));
	}
}

interface ScopedEvidenceIndex {
	readonly runIds: ReadonlySet<string>;
	/** Every checkpoint id and lookup identity, sorted so a prefix match is one binary search. */
	readonly identities: readonly string[];
}

function scopedEvidenceIndex(checkpoints: readonly DurableCheckpoint[]): ScopedEvidenceIndex {
	const runIds = new Set<string>();
	const identities: string[] = [];
	for (const checkpoint of checkpoints) {
		identities.push(
			checkpoint.checkpointId,
			checkpoint.kind === "tool"
				? checkpoint.argsHash
				: checkpoint.kind === "ui"
					? checkpoint.promptHash
					: checkpoint.replayKey,
		);
		if (checkpoint.kind !== "ui" && checkpoint.topology?.run?.runId !== undefined) {
			runIds.add(checkpoint.topology.run.runId);
		}
	}
	identities.sort(compareCodeUnits);
	return { runIds, identities };
}

/** Whether any sorted identity starts with `prefix`; all such identities sort contiguously from its lower bound. */
function hasPrefix(sorted: readonly string[], prefix: string): boolean {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (compareCodeUnits(sorted[middle]!, prefix) < 0) low = middle + 1;
		else high = middle;
	}
	return low < sorted.length && sorted[low]!.startsWith(prefix);
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function append<T>(map: Map<string, T[]>, key: string, value: T): void {
	const list = map.get(key);
	if (list === undefined) map.set(key, [value]);
	else list.push(value);
}
