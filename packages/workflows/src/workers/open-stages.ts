import { isTerminalStageStatus } from "../shared/store-internal.js";
import type { StageSnapshot } from "../shared/store-types.js";
import { isRunChanges, type PublishedRun } from "./run-changes.js";

/** The stages of one pooled run that a publication gives the root's prompt routing and stage registrations. */
export interface PublishedStages {
	readonly id: string;
	readonly stages: readonly StageSnapshot[];
}

interface AttemptStages {
	readonly generation: number;
	/** Each run's stages that have not ended, by id, as the attempt's worker last published them. */
	readonly runs: Map<string, Map<string, StageSnapshot>>;
}

/**
 * Which stages each publication hands the root's prompt routing and stage registrations (#4317): every stage of a run
 * published in full; of a run published as changes, its changed stages followed by its other stages that have not
 * ended, as the worker last published them; and the open stages of every other run of the attempt, which a
 * publication of changes leaves out because nothing in them changed. A stage that ended and did not change leaves
 * them nothing to do, so a publication costs what changed and what still runs, not every stage the attempt ever had.
 */
export class OpenStages {
	private readonly attempts = new Map<string, AttemptStages>();

	visit(work: { readonly id: string; readonly generation: number }, runs: readonly PublishedRun[]): PublishedStages[] {
		let attempt = this.attempts.get(work.id);
		if (attempt?.generation !== work.generation) {
			attempt = { generation: work.generation, runs: new Map() };
			this.attempts.set(work.id, attempt);
		}
		const open = attempt.runs;
		if (!runs.some(isRunChanges)) open.clear();
		const visited: PublishedStages[] = [];
		for (const run of runs) {
			const stages = isRunChanges(run) ? (open.get(run.id) ?? new Map<string, StageSnapshot>()) : new Map();
			for (const stage of run.stages) {
				if (isTerminalStageStatus(stage.status)) stages.delete(stage.id);
				else stages.set(stage.id, stage);
			}
			if (stages.size > 0) open.set(run.id, stages);
			else open.delete(run.id);
			const changed = new Set(run.stages.map((stage) => stage.id));
			visited.push({
				id: run.id,
				stages: [...run.stages, ...[...stages.values()].filter((stage) => !changed.has(stage.id))],
			});
		}
		const named = new Set(runs.map((run) => run.id));
		for (const [id, stages] of open) if (!named.has(id)) visited.push({ id, stages: [...stages.values()] });
		return visited;
	}

	forget(workId: string): void {
		this.attempts.delete(workId);
	}
}
