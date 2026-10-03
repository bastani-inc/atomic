import { durableRootRunIdForRun } from "../durable/run-owner-backend.js";
import { stageMatchesPathPattern, workflowBoundaryHops } from "./pending-stage-status.js";
import type { RunSnapshot } from "./store-types.js";
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
): StickyStageDeliveryStatus[] {
	const root = runs.find((run) => run.id === rootRunId);
	const entries = (root?.pendingStageMessages ?? []).filter((entry) => entry.sticky === true);
	const result: StickyStageDeliveryStatus[] = [];
	for (const run of runs) {
		if (run.id !== rootRunId && run.rootRunId !== rootRunId && durableRootRunIdForRun(runs, run.id) !== rootRunId)
			continue;
		const resolved = durableRootRunIdForRun(runs, run.id) === rootRunId;
		const hops = workflowBoundaryHops(runs, run.id);
		for (const stage of run.stages) {
			if (
				stage.nodeKind === "tool" ||
				stage.replayKey?.startsWith("prompt:") === true ||
				stage.replayKey?.startsWith("workflow:") === true ||
				stage.workflowChildRun !== undefined ||
				stage.workflowChild !== undefined
			)
				continue;
			for (const entry of entries) {
				const target = entry.targetPath ?? entry.stageKey;
				const parsed = parseWorkflowStageTarget(target);
				if (!parsed || parsed.rootRunId !== rootRunId) continue;
				if (resolved && hops && !stageMatchesPathPattern(parsed.segments, hops, [stage.id, stage.name])) continue;
				const receipts = (entry.deliveries ?? []).filter(
					(delivery) => delivery.runId === run.id && delivery.stageId === stage.id,
				);
				const delivered = receipts.some(
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
					reason =
						"Legacy or live transport receipt only; inspect the session transcript to confirm context admission";
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
