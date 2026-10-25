import type { DurableWorkflowBackend } from "../durable/backend.js";
import { availableRunDurableBackend, durableBackendForRun } from "../durable/run-owner-backend.js";
import { createStagePathPatternIndex, createWorkflowBoundaryHopsResolver } from "./pending-stage-status.js";
import type { PendingStageMessageDelivery, RunSnapshot } from "./store-types.js";
import { reciprocalWorkflowRootRunId } from "./workflow-run-ownership.js";
import { parseWorkflowStageTarget } from "./workflow-stage-target.js";

export interface StickyStageDeliveryStatus {
	readonly messageId: string;
	readonly target: string;
	readonly runId: string;
	readonly stageId: string;
	readonly sessionId?: string;
	readonly state:
		| "delivered"
		| "queued"
		| "session-replaced"
		| "receipt-unverified"
		| "delivery-unavailable"
		| "stage-terminal"
		| "root-unresolved";
	readonly reason: string;
}

export function stickyStageDeliveryStatuses(
	runs: readonly RunSnapshot[],
	rootRunId: string,
	availableBackend?: DurableWorkflowBackend,
): StickyStageDeliveryStatus[] {
	const root = runs.find((run) => run.id === rootRunId);
	const entries = (root?.pendingStageMessages ?? []).filter((entry) => entry.sticky === true);
	const result: StickyStageDeliveryStatus[] = [];
	// Parse each distinct target once and index the patterns, so a stage is matched only
	// against the targets that can reach it rather than re-parsing every entry per stage.
	const patternByTarget = new Map<string, number>();
	const patterns: string[][] = [];
	const entriesByPattern: number[][] = [];
	const ownEntries: number[] = [];
	entries.forEach((entry, index) => {
		const target = entry.targetPath ?? entry.stageKey;
		let pattern = patternByTarget.get(target);
		if (pattern === undefined) {
			const parsed = parseWorkflowStageTarget(target);
			pattern = parsed?.rootRunId === rootRunId ? patterns.push(parsed.segments) - 1 : -1;
			if (pattern >= 0) entriesByPattern.push([]);
			patternByTarget.set(target, pattern);
		}
		if (pattern < 0) return;
		entriesByPattern[pattern]!.push(index);
		ownEntries.push(index);
	});
	if (ownEntries.length === 0) return result;
	const patternIndex = createStagePathPatternIndex(patterns);
	const deliveriesByEntry = new Map<number, Map<string, PendingStageMessageDelivery[]>>();
	const entryReceipts = (index: number, runId: string, stageId: string): readonly PendingStageMessageDelivery[] => {
		let byStage = deliveriesByEntry.get(index);
		if (byStage === undefined) {
			byStage = new Map();
			for (const delivery of entries[index]!.deliveries ?? []) {
				const key = `${delivery.runId}\u0000${delivery.stageId}`;
				const list = byStage.get(key);
				if (list === undefined) byStage.set(key, [delivery]);
				else list.push(delivery);
			}
			deliveriesByEntry.set(index, byStage);
		}
		return byStage.get(`${runId}\u0000${stageId}`) ?? [];
	};
	availableBackend = availableRunDurableBackend(runs, rootRunId) ?? availableBackend;
	const backend = availableBackend === undefined ? undefined : durableBackendForRun(availableBackend, runs, rootRunId);
	const runById = new Map(runs.map((run) => [run.id, run]));
	const hopsFor = createWorkflowBoundaryHopsResolver(runs);
	for (const run of runs) {
		const durableRootRunId = reciprocalWorkflowRootRunId(runById, run.id);
		if (run.id !== rootRunId && run.rootRunId !== rootRunId && durableRootRunId !== rootRunId) continue;
		const resolved = durableRootRunId === rootRunId;
		const hops = hopsFor(run.id);
		for (const stage of run.stages) {
			if (
				stage.nodeKind === "tool" ||
				stage.replayKey?.startsWith("prompt:") === true ||
				stage.replayKey?.startsWith("workflow:") === true ||
				stage.workflowChildRun !== undefined ||
				stage.workflowChild !== undefined
			)
				continue;
			const matchedEntries =
				resolved && hops
					? patternIndex
							.matching(hops, [stage.id, stage.name])
							.flatMap((pattern) => entriesByPattern[pattern]!)
							.sort((left, right) => left - right)
					: ownEntries;
			for (const index of matchedEntries) {
				const entry = entries[index]!;
				const target = entry.targetPath ?? entry.stageKey;
				const receipts = entryReceipts(index, run.id, stage.id);
				const delivered =
					backend?.hasCachedPendingStageDeliveryReceipt?.(
						rootRunId,
						entry.id,
						{
							runId: run.id,
							stageId: stage.id,
							sessionId: stage.sessionId,
							admission: "context",
						},
						stage.sessionId === undefined,
					) === true ||
					receipts.some(
						(delivery) =>
							delivery.admission === "context" &&
							delivery.sessionId !== undefined &&
							(stage.sessionId === undefined || delivery.sessionId === stage.sessionId),
					);
				let state: StickyStageDeliveryStatus["state"];
				let reason: string;
				if (!resolved || !hops) {
					state = "root-unresolved";
					reason = "Repair reciprocal parent/boundary ownership before startup";
				} else if (delivered) {
					state = "delivered";
					reason = "Startup context admission confirmed; sticky subscription remains for future stages";
				} else if (["completed", "failed", "skipped"].includes(stage.status)) {
					state = "stage-terminal";
					reason = `${stage.error ? `${stage.error}; ` : ""}Stage ended without confirmed context admission; steer a live stage or start a new stage`;
				} else if (
					receipts.some(
						(delivery) =>
							delivery.admission !== "context" &&
							(delivery.sessionId === undefined ||
								stage.sessionId === undefined ||
								delivery.sessionId === stage.sessionId),
					)
				) {
					state = "receipt-unverified";
					reason = "Live delivery receipt only; inspect the session transcript to confirm context admission";
				} else if (stage.pendingStageDeliveryAvailable !== true) {
					state = "delivery-unavailable";
					reason = "Stage has no pre-start Intercom helper; enable Intercom in the invocation group";
				} else if (receipts.length > 0) {
					state = "session-replaced";
					reason = "Only a previous session has a receipt; replacement must drain before its first turn";
				} else {
					state = "queued";
					reason = "No delivery receipt; stage startup must drain before its first turn";
				}
				result.push({
					messageId: entry.message.id,
					target,
					runId: run.id,
					stageId: stage.id,
					...(stage.sessionId === undefined ? {} : { sessionId: stage.sessionId }),
					state,
					reason,
				});
			}
		}
	}
	return result;
}
