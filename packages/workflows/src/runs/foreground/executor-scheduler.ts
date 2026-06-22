import type { RunSnapshot, StageSnapshot } from "../../shared/store-types.js";
import type { Store } from "../../shared/store.js";
import type { GraphFrontierTracker } from "../../engine/graph-inference.js";
import type { StageControlRegistry } from "./stage-control-registry.js";

interface ReleaseBarrier {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
}

export function isTerminalStage(stage: StageSnapshot): boolean {
  return stage.status === "completed" || stage.status === "failed" || stage.status === "skipped";
}

export interface StageScheduler {
  readonly tracker: GraphFrontierTracker;
  stageById(stageId: string): StageSnapshot | undefined;
  setStageParentIds(stage: StageSnapshot, parentIds: readonly string[]): void;
  descendantsOf(stageId: string): StageSnapshot[];
  blockingAncestorFor(stage: StageSnapshot): string | undefined;
  blockStageUntilCascadeRelease(stage: StageSnapshot, blockedBy: string): void;
  blockKnownNonTerminalDescendants(failedStageId: string): void;
  cascadePauseFrom(pausedStageId: string): Promise<void>;
  cascadeResumeFrom(resumedStageId: string): Promise<void>;
  rejectReleaseBarriers(reason: unknown): void;
  releaseStageBarrier(stageId: string): void;
  ensureReleaseBarrier(stageId: string): void;
  waitForStageRelease(stageId: string, onRejected: () => Promise<void>): Promise<void>;
  markCascadePaused(stageId: string, ownerStageId: string): void;
  releaseCascadePauseOwner(stageId: string, ownerStageId: string): boolean;
  hasCascadePauseOwners(stageId: string): boolean;
}

export function createStageScheduler(input: {
  readonly runId: string;
  readonly runSnapshot: RunSnapshot;
  readonly activeStore: Store;
  readonly tracker: GraphFrontierTracker;
  readonly stageRegistry: () => StageControlRegistry;
}): StageScheduler {
  const releaseBarriers = new Map<string, ReleaseBarrier>();
  const cascadePauseOwners = new Map<string, Set<string>>();

  const makeReleaseBarrier = (): ReleaseBarrier => {
    const resolver = Promise.withResolvers<void>();
    void resolver.promise.catch(() => {});
    return { promise: resolver.promise, resolve: resolver.resolve, reject: resolver.reject };
  };

  const stageById = (stageId: string): StageSnapshot | undefined =>
    input.runSnapshot.stages.find((stage) => stage.id === stageId);

  const setStageParentIds = (stage: StageSnapshot, parentIds: readonly string[]): void => {
    stage.parentIds = Object.freeze([...parentIds]);
  };

  const hasAncestor = (stage: StageSnapshot, ancestorId: string): boolean => {
    const queue = [...stage.parentIds];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next)) continue;
      if (next === ancestorId) return true;
      seen.add(next);
      queue.push(...input.tracker.getParents(next));
    }
    return false;
  };

  const descendantsOf = (stageId: string): StageSnapshot[] =>
    input.runSnapshot.stages.filter((stage) => stage.id !== stageId && hasAncestor(stage, stageId));

  const blockingAncestorFor = (stage: StageSnapshot): string | undefined => {
    const queue = [...stage.parentIds];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      const ancestor = stageById(next);
      if (ancestor?.status === "paused" || ancestor?.status === "blocked") return next;
      queue.push(...input.tracker.getParents(next));
    }
    return undefined;
  };

  const ensureReleaseBarrier = (stageId: string): void => {
    if (!releaseBarriers.has(stageId)) releaseBarriers.set(stageId, makeReleaseBarrier());
  };

  const blockStageUntilCascadeRelease = (stage: StageSnapshot, blockedBy: string): void => {
    ensureReleaseBarrier(stage.id);
    input.activeStore.recordStageBlocked(input.runId, stage.id, blockedBy);
  };

  const blockKnownNonTerminalDescendants = (failedStageId: string): void => {
    for (const descendant of descendantsOf(failedStageId)) {
      if (isTerminalStage(descendant) || descendant.status === "paused" || descendant.status === "blocked") continue;
      blockStageUntilCascadeRelease(descendant, failedStageId);
    }
  };

  const markCascadePaused = (stageId: string, ownerStageId: string): void => {
    let owners = cascadePauseOwners.get(stageId);
    if (!owners) {
      owners = new Set<string>();
      cascadePauseOwners.set(stageId, owners);
    }
    owners.add(ownerStageId);
  };

  const releaseCascadePauseOwner = (stageId: string, ownerStageId: string): boolean => {
    const owners = cascadePauseOwners.get(stageId);
    if (!owners) return false;
    const changed = owners.delete(ownerStageId);
    if (owners.size === 0) cascadePauseOwners.delete(stageId);
    return changed;
  };

  const releaseStageBarrier = (stageId: string): void => {
    const barrier = releaseBarriers.get(stageId);
    if (!barrier) return;
    releaseBarriers.delete(stageId);
    barrier.resolve();
  };

  const cascadePauseFrom = async (pausedStageId: string): Promise<void> => {
    const stageRegistry = input.stageRegistry();
    for (const descendant of descendantsOf(pausedStageId)) {
      if (isTerminalStage(descendant) || descendant.status === "paused" || descendant.status === "blocked") continue;
      const descendantHandle = stageRegistry.get(input.runId, descendant.id);
      if (descendantHandle?.isStreaming || descendant.status === "running") {
        if (descendantHandle && (descendantHandle.status === "running" || descendantHandle.status === "pending")) {
          await descendantHandle.pause();
          markCascadePaused(descendant.id, pausedStageId);
        }
        continue;
      }
      blockStageUntilCascadeRelease(descendant, pausedStageId);
    }
  };

  const cascadeResumeFrom = async (resumedStageId: string): Promise<void> => {
    const stageRegistry = input.stageRegistry();
    for (const descendant of descendantsOf(resumedStageId)) {
      if (isTerminalStage(descendant)) continue;
      if (descendant.status === "blocked") {
        if (blockingAncestorFor(descendant) !== undefined) continue;
        if (input.activeStore.recordStageUnblocked(input.runId, descendant.id)) releaseStageBarrier(descendant.id);
        continue;
      }
      if (descendant.status === "paused") {
        const ownedByResumedStage = releaseCascadePauseOwner(descendant.id, resumedStageId);
        if (!ownedByResumedStage) continue;
        if (cascadePauseOwners.has(descendant.id)) continue;
        if (blockingAncestorFor(descendant) !== undefined) continue;
        const descendantHandle = stageRegistry.get(input.runId, descendant.id);
        if (descendantHandle?.status === "paused") await descendantHandle.resume();
      }
    }
  };

  const rejectReleaseBarriers = (reason: unknown): void => {
    cascadePauseOwners.clear();
    for (const [stageId, barrier] of releaseBarriers) {
      releaseBarriers.delete(stageId);
      input.activeStore.recordStageUnblocked(input.runId, stageId);
      barrier.reject(reason);
    }
  };

  const waitForStageRelease = async (stageId: string, onRejected: () => Promise<void>): Promise<void> => {
    while (true) {
      const barrier = releaseBarriers.get(stageId);
      if (!barrier) return;
      try {
        await barrier.promise;
      } catch (err) {
        await onRejected();
        throw err;
      }
    }
  };

  return {
    tracker: input.tracker,
    stageById,
    setStageParentIds,
    descendantsOf,
    blockingAncestorFor,
    blockStageUntilCascadeRelease,
    blockKnownNonTerminalDescendants,
    cascadePauseFrom,
    cascadeResumeFrom,
    rejectReleaseBarriers,
    releaseStageBarrier,
    ensureReleaseBarrier,
    waitForStageRelease,
    markCascadePaused,
    releaseCascadePauseOwner,
    hasCascadePauseOwners: (stageId) => cascadePauseOwners.has(stageId),
  };
}
