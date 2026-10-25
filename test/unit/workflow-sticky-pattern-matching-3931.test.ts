/**
 * Indexed sticky pattern matching returns what a full scan returns (#3931).
 *
 * Sticky delivery statuses used to match every sticky entry against every stage, parsing each
 * entry's target again for every stage. The indexed matcher and the indexed status computation
 * must give the same matches and the same statuses, in the same order, as the full scan. These
 * tests compare them on seeded random run graphs, sticky targets and delivery receipts.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { durableRootRunIdForRun } from "../../packages/workflows/src/durable/run-owner-backend.js";
import {
	createStagePathPatternIndex,
	stageMatchesPathPattern,
	type WorkflowBoundaryHop,
	workflowBoundaryHops,
} from "../../packages/workflows/src/shared/pending-stage-status.js";
import {
	type StickyStageDeliveryStatus,
	stickyStageDeliveryStatuses,
} from "../../packages/workflows/src/shared/sticky-stage-delivery-status.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { parseWorkflowStageTarget } from "../../packages/workflows/src/shared/workflow-stage-target.js";

const ROOT_RUN_ID = "0b9b6c1e-5d2a-4c3b-9a8f-1e2d3c4b5a69";
const OTHER_ROOT_RUN_ID = "7f3e2d1c-0b9a-4876-a543-210fedcba987";
const SEGMENTS = ["a", "b", "child", "child-c001", "child-c002", "s1", "s2", "run-x", "run-y", "review"];
const GLOBS = ["*", "**", "child-*", "*-c00*", "s*", "*1"];
const STATUSES = ["pending", "running", "completed", "failed", "skipped", "awaiting_input", "paused"] as const;

/** Deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(next: () => number, values: readonly T[]): T {
	return values[Math.floor(next() * values.length)]!;
}

function randomPattern(next: () => number): string[] {
	return Array.from({ length: 1 + Math.floor(next() * 4) }, () =>
		next() < 0.35 ? pick(next, GLOBS) : pick(next, SEGMENTS),
	);
}

function randomHops(next: () => number): WorkflowBoundaryHop[] {
	return Array.from({ length: Math.floor(next() * 4) }, () => {
		const name = pick(next, SEGMENTS);
		return { name, runId: next() < 0.3 ? name : pick(next, SEGMENTS) };
	});
}

test("the indexed stage path matcher matches exactly the patterns a full scan matches (#3931)", () => {
	for (let seed = 1; seed <= 400; seed++) {
		const next = random(seed);
		const patterns = Array.from({ length: Math.floor(next() * 30) }, () => randomPattern(next));
		const index = createStagePathPatternIndex(patterns);
		for (let trial = 0; trial < 20; trial++) {
			const hops = randomHops(next);
			const stageSegments = [pick(next, SEGMENTS), pick(next, SEGMENTS)];
			const expected = patterns.flatMap((pattern, position) =>
				stageMatchesPathPattern(pattern, hops, stageSegments) ? [position] : [],
			);
			assert.deepEqual(
				index.matching(hops, stageSegments),
				expected,
				`seed ${seed}: ${JSON.stringify({ hops, stageSegments })}`,
			);
		}
	}
});

/** The full-scan status computation before #3931, kept verbatim as the reference. */
function fullScanStatuses(
	runs: readonly RunSnapshot[],
	rootRunId: string,
	backend: DurableWorkflowBackend | undefined,
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
				const delivered =
					backend?.hasCachedPendingStageDeliveryReceipt?.(
						rootRunId,
						entry.id,
						{ runId: run.id, stageId: stage.id, sessionId: stage.sessionId, admission: "context" },
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

interface StageShape {
	id: string;
	name: string;
	status: (typeof STATUSES)[number];
	sessionId?: string;
	pendingStageDeliveryAvailable?: boolean;
	error?: string;
	nodeKind?: "tool";
	replayKey?: string;
	workflowChildRun?: { runId: string };
}

/** A random invocation: a root run, nested child runs behind boundary stages, some links broken. */
function randomRuns(next: () => number): RunSnapshot[] {
	const runs: {
		id: string;
		parentRunId?: string;
		parentStageId?: string;
		rootRunId?: string;
		stages: StageShape[];
	}[] = [];
	const randomStage = (index: number): StageShape => {
		const id = next() < 0.2 ? pick(next, SEGMENTS) : `stage-${index}`;
		return {
			id,
			name: next() < 0.3 ? id : pick(next, SEGMENTS),
			status: pick(next, STATUSES),
			...(next() < 0.5 ? { sessionId: `session-${Math.floor(next() * 4)}` } : {}),
			...(next() < 0.7 ? { pendingStageDeliveryAvailable: true } : {}),
			...(next() < 0.1 ? { error: "boom" } : {}),
			...(next() < 0.05 ? { nodeKind: "tool" as const } : {}),
			...(next() < 0.05 ? { replayKey: "prompt:1" } : {}),
		};
	};
	const addRun = (id: string, depth: number, parent?: { runId: string; stage: StageShape }) => {
		const stages = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, index) => randomStage(index));
		runs.push({
			id,
			...(parent === undefined
				? {}
				: {
						parentRunId: next() < 0.95 ? parent.runId : "missing-run",
						parentStageId: parent.stage.id,
						...(next() < 0.8 ? { rootRunId: next() < 0.95 ? ROOT_RUN_ID : OTHER_ROOT_RUN_ID } : {}),
					}),
			stages,
		});
		if (depth >= 2) return;
		const children = Math.floor(next() * 3);
		for (let child = 0; child < children; child++) {
			const childId = next() < 0.4 ? pick(next, SEGMENTS) : `${id}.c${child}`;
			const boundary: StageShape = {
				id: `boundary-${child}`,
				name: next() < 0.6 ? `child-c00${child + 1}` : pick(next, SEGMENTS),
				status: next() < 0.8 ? "running" : "completed",
				...(next() < 0.9 ? { workflowChildRun: { runId: childId } } : {}),
			};
			stages.push(boundary);
			addRun(childId, depth + 1, { runId: id, stage: boundary });
		}
	};
	addRun(ROOT_RUN_ID, 0);
	const allStages = runs.flatMap((run) => run.stages.map((stage) => ({ runId: run.id, stage })));
	const targets = [
		...Array.from({ length: 6 }, () => `workflow:${ROOT_RUN_ID}/${randomPattern(next).join("/")}`),
		`workflow:${OTHER_ROOT_RUN_ID}/**`,
		"not-a-target",
	];
	const pendingStageMessages = Array.from({ length: Math.floor(next() * 40) }, (_, index) => {
		const deliveries = Array.from({ length: Math.floor(next() * 4) }, () => {
			const { runId, stage } = pick(next, allStages);
			return {
				runId,
				stageId: stage.id,
				...(next() < 0.7 ? { sessionId: `session-${Math.floor(next() * 4)}` } : {}),
				...(next() < 0.8 ? { admission: next() < 0.5 ? ("context" as const) : ("transport" as const) } : {}),
				deliveredAt: "2026-10-24T00:00:00.000Z",
			};
		});
		const target = pick(next, targets);
		return {
			id: `entry-${index}`,
			runId: ROOT_RUN_ID,
			stageKey: target,
			...(next() < 0.8 ? { targetPath: target } : {}),
			...(next() < 0.9 ? { sticky: true as const } : {}),
			message: { id: `message-${index}` },
			deliveries,
		};
	});
	const root = runs[0]!;
	return runs.map((run) =>
		run === root ? ({ ...run, pendingStageMessages } as unknown as RunSnapshot) : (run as unknown as RunSnapshot),
	);
}

/** A backend whose cached receipt lookup answers deterministically per entry, stage and session. */
const cachedReceiptBackend = {
	hasCachedPendingStageDeliveryReceipt(
		_rootRunId: string,
		entryId: string,
		record: { stageId: string; sessionId?: string },
	): boolean {
		return `${entryId}|${record.stageId}|${record.sessionId ?? ""}`.length % 3 === 0;
	},
} as unknown as DurableWorkflowBackend;

test("indexed sticky delivery statuses equal the full-scan statuses on random invocations (#3931)", () => {
	let compared = 0;
	for (let seed = 1; seed <= 300; seed++) {
		const runs = randomRuns(random(seed));
		for (const backend of [undefined, cachedReceiptBackend]) {
			const expected = fullScanStatuses(runs, ROOT_RUN_ID, backend);
			assert.deepEqual(stickyStageDeliveryStatuses(runs, ROOT_RUN_ID, backend), expected, `seed ${seed}`);
			compared += expected.length;
		}
	}
	// The random invocations must actually produce statuses, or the comparison proves nothing.
	assert.ok(compared > 1_000, `only ${compared} statuses compared`);
});
