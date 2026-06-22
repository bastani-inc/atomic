/**
 * GraphFrontierTracker — infers DAG parents from JavaScript execution order.
 *
 * Algorithm:
 * - Maintain `frontier: Set<string>` — settled stage IDs not yet consumed as parents
 * - At onSpawn(stageId): snapshot current frontier as parents, store in stageParents
 * - At onSettle(stageId): remove stage's parents from frontier, add stageId to frontier
 * - getParents(stageId): return recorded parents
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

  /**
   * Call when ctx.stage(name) is invoked.
   * Returns the inferred parent IDs (snapshot of current frontier).
   */
  onSpawn(stageId: string, stageName: string): string[] {
    const parents = Array.from(this.frontier);
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
    this.stageParents.set(stageId, parents);
    const node = this.nodes.get(stageId);
    if (node !== undefined) {
      this.nodes.set(stageId, {
        ...node,
        parentIds: Object.freeze(parents),
      });
    }
  }

  /**
   * Call when the stage's Promise settles.
   * Removes the stage's parents from the frontier and adds stageId to frontier.
   */
  onSettle(stageId: string): void {
    const parents = this.stageParents.get(stageId) ?? [];
    // Remove parents from frontier (they are now consumed)
    for (const parentId of parents) {
      this.frontier.delete(parentId);
    }
    // Add this stage to the frontier
    this.frontier.add(stageId);
  }

  /** Get all recorded nodes as an array. */
  getNodes(): StageNode[] {
    return Array.from(this.nodes.values());
  }

  /** Get parent IDs for a stage. */
  getParents(stageId: string): string[] {
    return this.stageParents.get(stageId) ?? [];
  }

  /** Reset to initial state. */
  reset(): void {
    this.frontier.clear();
    this.stageParents.clear();
    this.nodes.clear();
  }
}
