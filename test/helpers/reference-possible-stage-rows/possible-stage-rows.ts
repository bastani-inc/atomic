/**
 * Verbatim copies of the route-announcement code before incremental possible-stage rows: the root's
 * possible-future rows and every sticky entry's delivery state on every matching stage, recomputed from
 * scratch on each call. Equivalence tests compare the incremental index against these.
 */
import type { DurableWorkflowBackend } from "../../../packages/workflows/src/durable/backend.js";
import {
	availableRunDurableBackend,
	durableBackendForRun,
} from "../../../packages/workflows/src/durable/run-owner-backend.js";
import {
	createStagePathPatternIndex,
	createWorkflowBoundaryHopsResolver,
	stageMatchesPathPattern,
} from "../../../packages/workflows/src/shared/pending-stage-status.js";
import type { Store } from "../../../packages/workflows/src/shared/store.js";
import { isTerminalRunStatus } from "../../../packages/workflows/src/shared/store-internal.js";
import type {
	PendingStageMessage,
	PendingStageMessageDelivery,
	RunSnapshot,
} from "../../../packages/workflows/src/shared/store-types.js";
import { reciprocalWorkflowRootRunId } from "../../../packages/workflows/src/shared/workflow-run-ownership.js";
import {
	matchStagePathSegments,
	splitStagePathSegments,
} from "../../../packages/workflows/src/shared/workflow-stage-path-matching.js";
import {
	formatWorkflowStageTarget,
	parseWorkflowStageTarget,
} from "../../../packages/workflows/src/shared/workflow-stage-target.js";

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

/**
 * D7 (slice 4): possible-future rows for `intercom list`, derived from the persisted
 * scan (D10) plus the root run's sticky queue. Glob-free scan entries that already
 * name a route-eligible materialized stage are suppressed (they are announced as
 * materialized roster rows); pattern entries stay listed because future occurrences
 * still match them (D2/D3). The run-wide `workflow:<root>/**` broadcast row (D6) is
 * present whenever the root run is non-terminal, even with an empty scan; a terminal
 * root yields `[]` so the broker drops every future row.
 */
export function possibleStageRows(
	runs: ReturnType<Store["runs"]>,
	rootRunId: string,
	rootRun: ReturnType<Store["runs"]>[number],
	backend?: DurableWorkflowBackend,
): {
	readonly target: string;
	readonly queuedCount: number;
	readonly deliveryOnly?: true;
	readonly deliveryStates?: readonly StickyStageDeliveryStatus[];
}[] {
	if (isTerminalRunStatus(rootRun.status)) return [];
	const stickyQueued = (rootRun.pendingStageMessages ?? []).filter(
		(entry) => entry.sticky === true && entry.status === "queued",
	);
	// Parse each distinct sticky target once per publication, not once per row and entry.
	const segmentsByTarget = new Map<string, readonly string[] | undefined>();
	const stickySegments = (entry: PendingStageMessage): readonly string[] | undefined => {
		const target = entry.targetPath ?? entry.stageKey;
		if (segmentsByTarget.has(target)) return segmentsByTarget.get(target);
		const parsed = parseWorkflowStageTarget(target);
		const segments = parsed?.rootRunId === rootRunId ? parsed.segments : undefined;
		segmentsByTarget.set(target, segments);
		return segments;
	};
	// The run-wide broadcast bucket (`workflow:<root>/**`) is its own target (D6): its
	// entries are counted on the broadcast row only, never on the scan rows below — a
	// bidirectional glob match would otherwise inflate every row with the same count.
	const scanEntries = stickyQueued.filter((entry) => {
		const segments = stickySegments(entry);
		return !(segments !== undefined && segments.length === 1 && segments[0] === "**");
	});
	const liveStageMatches = materializedStageMatcher(runs, rootRunId);
	const rows: {
		readonly target: string;
		readonly queuedCount: number;
		readonly deliveryOnly?: true;
		readonly deliveryStates?: readonly StickyStageDeliveryStatus[];
	}[] = [];
	for (const scanEntry of rootRun.possibleStages ?? []) {
		const rowSegments = splitStagePathSegments(scanEntry);
		if (rowSegments.length === 0 || rowSegments.some((segment) => segment.length === 0)) continue;
		if (!rowSegments.some((segment) => segment.includes("*")) && liveStageMatches(rowSegments)) {
			continue;
		}
		rows.push({
			target: formatWorkflowStageTarget(rootRunId, ...rowSegments),
			queuedCount: scanEntries.filter((entry) => {
				const segments = stickySegments(entry);
				if (segments === undefined) return false;
				return matchStagePathSegments(rowSegments, segments) || matchStagePathSegments(segments, rowSegments);
			}).length,
		});
	}
	rows.push({
		target: formatWorkflowStageTarget(rootRunId, "**"),
		queuedCount: stickyQueued.filter((entry) => {
			const segments = stickySegments(entry);
			return segments !== undefined && segments.length === 1 && segments[0] === "**";
		}).length,
	});
	const statuses = stickyStageDeliveryStatuses(runs, rootRunId, backend);
	const statusesByTarget = new Map<string, StickyStageDeliveryStatus[]>();
	for (const status of statuses) {
		const forTarget = statusesByTarget.get(status.target);
		if (forTarget === undefined) statusesByTarget.set(status.target, [status]);
		else forTarget.push(status);
	}
	const queuedByTarget = new Map<string, number>();
	for (const entry of stickyQueued) {
		const target = entry.targetPath ?? entry.stageKey;
		queuedByTarget.set(target, (queuedByTarget.get(target) ?? 0) + 1);
	}
	const rowTargets = new Set(rows.map((row) => row.target));
	for (const target of statusesByTarget.keys()) {
		if (rowTargets.has(target)) continue;
		rowTargets.add(target);
		rows.push({ target, queuedCount: queuedByTarget.get(target) ?? 0, deliveryOnly: true });
	}
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index]!;
		const deliveryStates = statusesByTarget.get(row.target);
		if (deliveryStates !== undefined) rows[index] = { ...row, deliveryStates };
	}
	return rows;
}

/** Whether a glob-free scan entry names a route-eligible materialized stage of the invocation. */
function materializedStageMatcher(
	runs: ReturnType<Store["runs"]>,
	rootRunId: string,
): (entrySegments: readonly string[]) => boolean {
	const runById = new Map(runs.map((run) => [run.id, run]));
	const hopsFor = createWorkflowBoundaryHopsResolver(runs);
	const invocationRuns = runs.filter((run) => reciprocalWorkflowRootRunId(runById, run.id) === rootRunId);
	return (entrySegments) => materializedStageMatches(invocationRuns, hopsFor, entrySegments);
}

function materializedStageMatches(
	invocationRuns: ReturnType<Store["runs"]>,
	hopsFor: ReturnType<typeof createWorkflowBoundaryHopsResolver>,
	entrySegments: readonly string[],
): boolean {
	for (const run of invocationRuns) {
		const hops = hopsFor(run.id);
		if (hops === undefined) continue;
		for (const stage of run.stages) {
			if (stage.pendingStageDeliveryAvailable !== true) continue;
			if (
				stage.status !== "pending" &&
				stage.status !== "running" &&
				stage.status !== "awaiting_input" &&
				stage.status !== "paused" &&
				stage.status !== "blocked"
			) {
				continue;
			}
			if (stageMatchesPathPattern(entrySegments, hops, [stage.id, stage.name])) return true;
		}
	}
	return false;
}
