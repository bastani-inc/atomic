import { REPLAY_TOPOLOGY_MISMATCH_MESSAGE } from "../../shared/replay-topology-failure.js";
import type { StageSnapshot, ToolNodeSnapshot } from "../../shared/store-types.js";
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
	replaysCompletedStage(replayKey: string): boolean;
	markPromptAnswerReplayed(stageId: string): void;
	/** Confirms a tool the continuation admits against a replayed stage's provisional parent of the same id (#4945). */
	admitToolNode(node: Pick<ToolNodeSnapshot, "id" | "argsHash" | "ordinal">): void;
	/** Fails when a replayed stage's provisional tool parent never materialised (#4945). */
	assertProvisionalParentsAdmitted(): void;
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const rightSet = new Set(right);
	return left.every((value) => rightSet.has(value));
}

function sortedIdentity(values: readonly string[]): string {
	return [...values].sort().join("\u0000");
}

const EXECUTE_EVERY_STAGE: ContinuationReplayIndex = {
	decide: (input) => ({ kind: "execute", parentIds: input.parentIds, answerReplay: "unavailable" }),
	replaysCompletedStage: () => false,
	markPromptAnswerReplayed: () => {},
	admitToolNode: () => {},
	assertProvisionalParentsAdmitted: () => {},
};

export function createContinuationReplayIndex(
	continuation: RunContinuationOpts | undefined,
	sourceToContinuationNodeIds: Map<string, string>,
): ContinuationReplayIndex {
	if (continuation === undefined) {
		return EXECUTE_EVERY_STAGE;
	}
	if (continuation.resumeFromStageId === undefined && continuation.resumeFromToolNodeId === undefined) {
		if (continuation.source.stages.length > 0)
			throw new Error(
				`atomic-workflows: insufficient_state: continuation has no resume stage in source run ${continuation.source.id}`,
			);
		return EXECUTE_EVERY_STAGE;
	}
	const resumeNode =
		continuation.resumeFromToolNodeId === undefined
			? continuation.source.stages.find((stage) => stage.id === continuation.resumeFromStageId)
			: continuation.source.toolNodes.find((node) => node.id === continuation.resumeFromToolNodeId);
	if (resumeNode === undefined) {
		throw new Error(
			`atomic-workflows: insufficient_state: resume frontier ${continuation.resumeFromStageId ?? continuation.resumeFromToolNodeId} was not found in source run ${continuation.source.id}`,
		);
	}
	// Tool parents enter this map when the continuation admits the node (`onNodeStart`), not from the source snapshot.
	// A stage created before the tool its first call follows replays at creation, before that tool is admitted (#4945):
	// its source tool parent is translated provisionally, by the tool's stable id, and the continuation must then admit
	// that tool with the same identity, or the replay fails loudly.
	const sourceToolNodes = new Map(continuation.source.toolNodes.map((node) => [node.id, node]));
	/** Provisional tool parents of replayed stages, by id, with the stage that first took each. */
	const provisionalToolParents = new Map<
		string,
		{ readonly tool: ToolNodeSnapshot; readonly stage: string; readonly replayKey: string }
	>();

	const stagesByReplayIdentity = new Map<string, StageSnapshot[]>();
	const promptDuplicateCounts = new Map<string, number>();
	for (const stage of continuation.source.stages) {
		const identity = stage.replayKey;
		if (identity === undefined) continue;
		const stages = stagesByReplayIdentity.get(identity);
		if (stages === undefined) stagesByReplayIdentity.set(identity, [stage]);
		else stages.push(stage);
		const duplicateKey = `${identity}\u0001${sortedIdentity(stage.parentIds)}`;
		promptDuplicateCounts.set(duplicateKey, (promptDuplicateCounts.get(duplicateKey) ?? 0) + 1);
	}

	const consumedSourceStageIds = new Set<string>();
	// Stages and ToolNodeSnapshot nodes share one source-to-continuation identity map.
	const replayablePromptContinuationStageIds = new Set<string>();

	const failTopology = (displayName: string, replayKey: string, reason: "mismatch" | "ambiguous"): never => {
		const message =
			reason === "mismatch"
				? REPLAY_TOPOLOGY_MISMATCH_MESSAGE
				: "atomic-workflows: insufficient_state: replay topology ambiguous";
		throw new Error(
			`${message} for stage "${displayName}" (replayKey "${replayKey}") in source run ${continuation.source.id}`,
		);
	};

	const failProvisionalParent = (
		pending: { readonly tool: ToolNodeSnapshot; readonly stage: string; readonly replayKey: string },
		outcome: string,
	): never => {
		throw new Error(
			`${REPLAY_TOPOLOGY_MISMATCH_MESSAGE} for stage "${pending.stage}" (replayKey "${pending.replayKey}") in source run ${continuation.source.id}: its tool parent "${pending.tool.name}" (node "${pending.tool.id}") ${outcome}`,
		);
	};

	const translateSourceParents = (
		source: StageSnapshot,
	): { readonly parentIds: string[]; readonly provisional: string[] } | undefined => {
		const parentIds: string[] = [];
		const provisional: string[] = [];
		for (const sourceParentId of source.parentIds) {
			const continuationParentId = sourceToContinuationNodeIds.get(sourceParentId);
			if (continuationParentId !== undefined) parentIds.push(continuationParentId);
			else if (sourceToolNodes.has(sourceParentId)) {
				// A tool keeps its id across runs, so the continuation admits it under its source id.
				parentIds.push(sourceParentId);
				provisional.push(sourceParentId);
			} else return undefined;
		}
		return { parentIds, provisional };
	};

	/**
	 * A candidate whose parents include tools not admitted yet: the stage was created before them, so the parents the
	 * continuation inferred at creation precede those tools. Its admitted parents must still be among them.
	 */
	const matchesBeforeProvisionalParents = (
		candidate: { readonly parentIds: readonly string[]; readonly provisional: readonly string[] },
		inferredParentIds: readonly string[],
	): boolean =>
		candidate.provisional.length > 0 &&
		candidate.parentIds.every(
			(parentId) => candidate.provisional.includes(parentId) || inferredParentIds.includes(parentId),
		);

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
		return (
			driftParentIds.length > 0 &&
			driftParentIds.every((parentId) => replayablePromptContinuationStageIds.has(parentId))
		);
	};

	return {
		markPromptAnswerReplayed(stageId: string): void {
			replayablePromptContinuationStageIds.add(stageId);
		},

		admitToolNode(node): void {
			const pending = provisionalToolParents.get(node.id);
			if (pending === undefined) return;
			provisionalToolParents.delete(node.id);
			if (node.argsHash !== pending.tool.argsHash || node.ordinal !== pending.tool.ordinal)
				failProvisionalParent(pending, "was admitted with another identity");
		},

		assertProvisionalParentsAdmitted(): void {
			const [pending] = provisionalToolParents.values();
			if (pending !== undefined) failProvisionalParent(pending, "was never admitted");
		},

		replaysCompletedStage(replayKey: string): boolean {
			const candidates =
				stagesByReplayIdentity.get(replayKey)?.filter((stage) => !consumedSourceStageIds.has(stage.id)) ?? [];
			return candidates.length > 0 && candidates.every((stage) => stage.status === "completed");
		},

		decide(input: ContinuationReplayInput): ContinuationReplayDecision {
			const { displayName, replayKey, parentIds, stageId, kind } = input;
			const candidates =
				stagesByReplayIdentity.get(replayKey)?.filter((stage) => !consumedSourceStageIds.has(stage.id)) ?? [];
			if (candidates.length === 0) return { kind: "execute", parentIds, answerReplay: "unavailable" };

			const mappedCandidates = candidates.flatMap((source) => {
				const translated = translateSourceParents(source);
				return translated === undefined ? [] : [{ source, ...translated }];
			});

			if (mappedCandidates.length === 0) failTopology(displayName, replayKey, "mismatch");

			const exactMatches = mappedCandidates.filter((candidate) => sameStringSet(candidate.parentIds, parentIds));
			const provisionalMatches =
				exactMatches.length > 0
					? exactMatches
					: mappedCandidates.filter((candidate) => matchesBeforeProvisionalParents(candidate, parentIds));
			const hasPromptDriftMatch =
				kind === "prompt" &&
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
			const duplicateKey = `${replayKey}\u0001${sortedIdentity(selected.source.parentIds)}`;
			const ambiguousPromptAnswer = kind === "prompt" && (promptDuplicateCounts.get(duplicateKey) ?? 0) > 1;
			const answerReplay: PromptAnswerReplaySafety = ambiguousPromptAnswer
				? "ambiguous"
				: selected.source.status === "completed"
					? "allowed"
					: "unavailable";
			consumedSourceStageIds.add(selected.source.id);
			sourceToContinuationNodeIds.set(selected.source.id, stageId);
			for (const toolId of selected.provisional) {
				if (provisionalToolParents.has(toolId)) continue;
				provisionalToolParents.set(toolId, { tool: sourceToolNodes.get(toolId)!, stage: displayName, replayKey });
			}
			if (selected.source.status === "completed" && answerReplay === "allowed") {
				return { kind: "replay", source: selected.source, parentIds: selected.parentIds, answerReplay };
			}
			return { kind: "execute", source: selected.source, parentIds: selected.parentIds, answerReplay };
		},
	};
}
