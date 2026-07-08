import type { StageSnapshot } from "../../shared/store-types.js";
import type { RunContinuationOpts } from "./executor-types.js";

export type PromptAnswerReplaySafety = "allowed" | "unavailable" | "ambiguous";

export function getPromptAnswerState(
  hasReplayAnswer: boolean,
  replaySourceId: string | undefined,
  answerReplay: PromptAnswerReplaySafety,
): StageSnapshot["promptAnswerState"] {
  if (replaySourceId === undefined) return undefined;
  if (hasReplayAnswer) return "available";
  if (answerReplay === "ambiguous") return "ambiguous";
  return "unavailable";
}

export type ContinuationReplayDecision =
  | {
      readonly kind: "execute";
      readonly source?: StageSnapshot;
      readonly parentIds: readonly string[];
      readonly answerReplay: PromptAnswerReplaySafety;
    }
  | {
      readonly kind: "replay";
      readonly source: StageSnapshot;
      readonly parentIds: readonly string[];
      readonly answerReplay: PromptAnswerReplaySafety;
    };

interface ContinuationReplayInput {
  readonly displayName: string;
  readonly replayKey: string;
  readonly parentIds: readonly string[];
  readonly stageId: string;
  readonly kind: "stage" | "prompt" | "workflow";
}

export interface ContinuationReplayIndex {
  decide(input: ContinuationReplayInput): ContinuationReplayDecision;
  markPromptAnswerReplayed(stageId: string): void;
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function sortedIdentity(values: readonly string[]): string {
  return [...values].sort().join("\u0000");
}

export function createContinuationReplayIndex(continuation: RunContinuationOpts | undefined): ContinuationReplayIndex {
  if (continuation === undefined) {
    return {
      decide: (input) => ({
        kind: "execute",
        parentIds: input.parentIds,
        answerReplay: "unavailable",
      }),
      markPromptAnswerReplayed: () => {},
    };
  }
  const resumeStage = continuation.source.stages.find((stage) => stage.id === continuation.resumeFromStageId);
  if (resumeStage === undefined) {
    throw new Error(`atomic-workflows: insufficient_state: resume stage ${continuation.resumeFromStageId} was not found in source run ${continuation.source.id}`);
  }

  const stagesByReplayIdentity = new Map<string, StageSnapshot[]>();
  const stagesByDisplayName = new Map<string, StageSnapshot[]>();
  const promptDuplicateCounts = new Map<string, number>();
  for (const stage of continuation.source.stages) {
    const identity = stage.replayKey ?? stage.name;
    const stages = stagesByReplayIdentity.get(identity);
    if (stages === undefined) stagesByReplayIdentity.set(identity, [stage]);
    else stages.push(stage);
    const namedStages = stagesByDisplayName.get(stage.name);
    if (namedStages === undefined) stagesByDisplayName.set(stage.name, [stage]);
    else namedStages.push(stage);
    const duplicateKeys = [
      `${identity}\u0001${sortedIdentity(stage.parentIds)}`,
      ...(identity === stage.name ? [] : [`${stage.name}\u0001${sortedIdentity(stage.parentIds)}`]),
    ];
    for (const duplicateKey of duplicateKeys) {
      promptDuplicateCounts.set(duplicateKey, (promptDuplicateCounts.get(duplicateKey) ?? 0) + 1);
    }
  }

  const consumedSourceStageIds = new Set<string>();
  const continuationStageIdBySourceStageId = new Map<string, string>();
  const replayablePromptContinuationStageIds = new Set<string>();

  const failTopology = (displayName: string, replayKey: string, reason: "mismatch" | "ambiguous"): never => {
    throw new Error(`atomic-workflows: insufficient_state: replay topology ${reason} for stage "${displayName}" (replayKey "${replayKey}") in source run ${continuation.source.id}`);
  };

  const translateSourceParents = (source: StageSnapshot): string[] | undefined => {
    const parentIds: string[] = [];
    for (const sourceParentId of source.parentIds) {
      const continuationParentId = continuationStageIdBySourceStageId.get(sourceParentId);
      if (continuationParentId === undefined) return undefined;
      parentIds.push(continuationParentId);
    }
    return parentIds;
  };

  const allSameParentSet = (candidates: readonly { readonly parentIds: readonly string[] }[]): boolean => {
    const first = candidates[0]?.parentIds;
    if (first === undefined) return false;
    return candidates.every((candidate) => sameStringSet(candidate.parentIds, first));
  };

  const hasOnlyReplayablePromptParentDrift = (
    sourceParentIds: readonly string[],
    provisionalParentIds: readonly string[],
  ): boolean => {
    const sourceParentSet = new Set(sourceParentIds);
    const provisionalParentSet = new Set(provisionalParentIds);
    const driftParentIds = [
      ...sourceParentIds.filter((parentId) => !provisionalParentSet.has(parentId)),
      ...provisionalParentIds.filter((parentId) => !sourceParentSet.has(parentId)),
    ];
    return driftParentIds.length > 0 && driftParentIds.every((parentId) => replayablePromptContinuationStageIds.has(parentId));
  };

  return {
    markPromptAnswerReplayed(stageId: string): void {
      replayablePromptContinuationStageIds.add(stageId);
    },

    decide(input: ContinuationReplayInput): ContinuationReplayDecision {
      const { displayName, replayKey, parentIds, stageId, kind } = input;
      let identity = replayKey;
      let candidates = stagesByReplayIdentity.get(replayKey)?.filter((stage) => !consumedSourceStageIds.has(stage.id)) ?? [];
      if (candidates.length === 0) {
        identity = displayName;
        const namedCandidates = stagesByDisplayName.get(displayName)?.filter((stage) => !consumedSourceStageIds.has(stage.id)) ?? [];
        candidates = kind === "prompt" ? namedCandidates.filter((stage) => stage.replayKey === undefined) : namedCandidates;
      }
      if (candidates.length === 0) return { kind: "execute", parentIds, answerReplay: "unavailable" };

      const mappedCandidates = candidates
        .map((source) => ({ source, parentIds: translateSourceParents(source) }))
        .filter((candidate): candidate is { readonly source: StageSnapshot; readonly parentIds: string[] } => candidate.parentIds !== undefined);

      if (mappedCandidates.length === 0) failTopology(displayName, replayKey, "mismatch");

      const provisionalMatches = mappedCandidates.filter((candidate) => sameStringSet(candidate.parentIds, parentIds));
      const hasPromptDriftMatch = kind === "prompt" &&
        allSameParentSet(mappedCandidates) &&
        hasOnlyReplayablePromptParentDrift(mappedCandidates[0]!.parentIds, parentIds);
      let matches: typeof mappedCandidates | undefined;
      if (provisionalMatches.length > 0) matches = provisionalMatches;
      else if (hasPromptDriftMatch) matches = mappedCandidates;
      if (matches === undefined) return failTopology(displayName, replayKey, "mismatch");
      if (matches.length > 1 && (kind !== "prompt" || !allSameParentSet(matches))) {
        failTopology(displayName, replayKey, "ambiguous");
      }

      const selected = matches[0]!;
      const duplicateKey = `${identity}\u0001${sortedIdentity(selected.source.parentIds)}`;
      const ambiguousPromptAnswer = kind === "prompt" && (promptDuplicateCounts.get(duplicateKey) ?? 0) > 1;
      const answerReplay: PromptAnswerReplaySafety = ambiguousPromptAnswer
        ? "ambiguous"
        : selected.source.status === "completed"
          ? "allowed"
          : "unavailable";
      consumedSourceStageIds.add(selected.source.id);
      continuationStageIdBySourceStageId.set(selected.source.id, stageId);
      if (selected.source.status === "completed" && answerReplay === "allowed") {
        return { kind: "replay", source: selected.source, parentIds: selected.parentIds, answerReplay };
      }
      return { kind: "execute", source: selected.source, parentIds: selected.parentIds, answerReplay };
    },
  };
}
