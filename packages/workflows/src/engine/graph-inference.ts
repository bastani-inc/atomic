/**
 * GraphFrontierTracker — infers DAG parents from JavaScript execution order.
 *
 * Algorithm:
 * - Maintain `frontier: Set<string>` — settled stage IDs not yet consumed as parents
 * - At onSpawn(stageId): snapshot current frontier as parents, store in stageParents
 * - At onSettle(stageId): remove stage's parents from frontier, add stageId to frontier
 * - getParents(stageId): return recorded parents
 *
 * A replayed stage may be given recorded parents that have not spawned yet: a stage created before a tool whose
 * result its first call follows replays at creation, before that tool replays (#4888). Such a parent is consumed
 * already, so it never enters the frontier, and it does not take its own descendant as a parent when it spawns.
 */

export interface StageNode {
	readonly id: string;
	readonly name: string;
	readonly parentIds: readonly string[];
}

export class GraphFrontierTracker {
	private frontier: Set<string> = new Set();
	private stageParents: Map<string, string[]> = new Map();
	private nodes: Map<string, StageNode> = new Map();
	private detached: Set<string> = new Set();
	/** Nodes a settled node already took as parents: settling later, they are not leaves. */
	private consumed: Set<string> = new Set();
	/** Parents a node was given before they spawned. */
	private unspawnedParents: Set<string> = new Set();

	/**
	 * Call when ctx.stage(name) is invoked.
	 * Returns the inferred parent IDs (snapshot of current frontier).
	 */
	onSpawn(stageId: string, stageName: string): string[] {
		const parents = Array.from(this.frontier);
		if (this.unspawnedParents.delete(stageId)) {
			// Its recorded children replayed first: they come after it, so they are not its parents.
			return this.spawn(
				stageId,
				stageName,
				parents.filter((parentId) => !this.hasAncestor(parentId, stageId)),
			);
		}
		return this.spawn(stageId, stageName, parents);
	}

	private spawn(stageId: string, stageName: string, parents: string[]): string[] {
		this.assertAcyclicParents(stageId, parents);
		this.stageParents.set(stageId, parents);

		this.nodes.set(stageId, {
			id: stageId,
			name: stageName,
			parentIds: Object.freeze(parents),
		});

		return parents;
	}

	/**
	 * Snapshot the current frontier without registering or mutating a stage.
	 *
	 * Use this when an already-spawned stage needs its parents refreshed before
	 * it starts; `onSpawn` must only be called for the initial `ctx.stage()`
	 * invocation that creates the graph node.
	 */
	currentParents(): string[] {
		return Array.from(this.frontier);
	}

	/**
	 * Replace the recorded parents for a stage before it settles.
	 *
	 * Continuation replay uses source-run topology as authoritative: a replayed
	 * stage may spawn with provisional parents inferred from the continuation's
	 * current frontier, then install the translated source parents before the
	 * stage is recorded or settled.
	 */
	replaceParents(stageId: string, parentIds: readonly string[]): void {
		const parents = Array.from(parentIds);
		this.assertAcyclicParents(stageId, parents);
		this.stageParents.set(stageId, parents);
		for (const parentId of parents) if (!this.nodes.has(parentId)) this.unspawnedParents.add(parentId);
		const node = this.nodes.get(stageId);
		if (node !== undefined) {
			this.nodes.set(stageId, {
				...node,
				parentIds: Object.freeze(parents),
			});
		}
	}

	/**
	 * Keep a spawned node out of the frontier. It retains its parents, but later
	 * stages never depend on it and its settlement consumes nothing; event
	 * children of a subscription use this so the main line stays independent of
	 * event timing.
	 */
	detach(stageId: string): void {
		this.detached.add(stageId);
	}

	/**
	 * Call when the stage's Promise settles.
	 * Removes the stage's parents from the frontier and adds stageId to frontier.
	 */
	onSettle(stageId: string): void {
		if (this.detached.has(stageId)) return;
		const parents = this.stageParents.get(stageId) ?? [];
		// Remove parents from frontier (they are now consumed)
		for (const parentId of parents) {
			this.frontier.delete(parentId);
			this.consumed.add(parentId);
		}
		// Add this stage to the frontier, unless a stage that settled first already took it as a parent
		if (!this.consumed.has(stageId)) this.frontier.add(stageId);
	}

	/** Get all recorded nodes as an array. */
	getNodes(): StageNode[] {
		return Array.from(this.nodes.values());
	}

	/** Get parent IDs for a stage. */
	getParents(stageId: string): string[] {
		return this.stageParents.get(stageId) ?? [];
	}

	private hasAncestor(nodeId: string, ancestorId: string): boolean {
		const pending = [...this.getParents(nodeId)];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const parentId = pending.pop()!;
			if (parentId === ancestorId) return true;
			if (visited.has(parentId)) continue;
			visited.add(parentId);
			pending.push(...this.getParents(parentId));
		}
		return false;
	}

	private assertAcyclicParents(nodeId: string, parentIds: readonly string[]): void {
		const pending = [...parentIds];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const parentId = pending.pop()!;
			if (parentId === nodeId) throw new Error(`atomic-workflows: graph cycle at node ${nodeId}`);
			if (visited.has(parentId)) continue;
			visited.add(parentId);
			pending.push(...(this.stageParents.get(parentId) ?? []));
		}
	}

	/** Reset to initial state. */
	reset(): void {
		this.frontier.clear();
		this.stageParents.clear();
		this.nodes.clear();
		this.detached.clear();
		this.consumed.clear();
		this.unspawnedParents.clear();
	}
}
