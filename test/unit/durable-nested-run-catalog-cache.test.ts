import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { STAGE_REPLAY_METADATA_CHECKPOINT_PREFIX } from "../../packages/workflows/src/durable/backend.js";
import { durableNestedRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { durableCompletedNestedRunSubtree } from "../../packages/workflows/src/durable/completed-subtree.js";
import type { DurableCheckpoint, DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition, WorkflowExitStatus } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { durableNestedRunSnapshots as referenceNestedRunSnapshots } from "../helpers/reference-nested-run-snapshots/completed-catalog.js";
import { durableCompletedNestedRunSubtree as referenceCompletedNestedRunSubtree } from "../helpers/reference-nested-run-snapshots/completed-subtree.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

afterEach(closeMemoryTestBackends);

/** Deterministic PRNG so a failing history reproduces from its seed. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface NodePlan {
	readonly stages: number;
	readonly tools: number;
	readonly children: readonly NodePlan[];
	readonly parallel: boolean;
	readonly ending: "complete" | "exit-early" | "exit-late" | "fail";
	readonly exitStatus: WorkflowExitStatus;
}

function randomPlan(random: () => number, depth: number): NodePlan {
	const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
	const childCount = depth >= 2 ? 0 : Math.floor(random() * (depth === 0 ? 5 : 3));
	return {
		stages: Math.floor(random() * 3),
		tools: Math.floor(random() * 3),
		children: Array.from({ length: childCount }, () => randomPlan(random, depth + 1)),
		parallel: random() < 0.5,
		ending: depth === 0 ? "complete" : pick(["complete", "complete", "exit-early", "exit-late", "fail"] as const),
		exitStatus: pick(["completed", "cancelled", "blocked"] as const),
	};
}

const node: WorkflowDefinition = workflow({
	name: "random-node",
	description: "",
	inputs: { plan: Type.String() },
	outputs: {},
	run: async (ctx) => {
		const plan = JSON.parse(ctx.inputs.plan) as NodePlan;
		if (plan.ending === "exit-early") ctx.exit({ status: plan.exitStatus, reason: "early" });
		for (let index = 0; index < plan.stages; index++) await ctx.stage(`s${index}`).complete(`stage-${index}`);
		for (let index = 0; index < plan.tools; index++) {
			await ctx.tool(`t${index}`, { index, stages: plan.stages }, async () => `tool-${index}`);
		}
		const invoke = (child: NodePlan) => ctx.workflow(node, { inputs: { plan: JSON.stringify(child) } });
		if (plan.parallel) await Promise.allSettled(plan.children.map(invoke));
		else for (const child of plan.children) await invoke(child).catch(() => undefined);
		if (plan.ending === "exit-late") ctx.exit({ status: plan.exitStatus, reason: "late" });
		if (plan.ending === "fail") throw new Error("planned failure");
		return {};
	},
}) as WorkflowDefinition;

async function recordedHistory(seed: number): Promise<{ rootId: string; checkpoints: readonly DurableCheckpoint[] }> {
	const backend = await createMemoryTestBackend();
	const rootId = `nested-catalog-${seed}`;
	await run(
		node,
		{ plan: JSON.stringify(randomPlan(mulberry32(seed), 0)) },
		{
			runId: rootId,
			registry: createRegistry([node]),
			store: createStore(),
			durableBackend: backend,
			adapters: { complete: { complete: async (text: string) => text } },
		},
	);
	return { rootId, checkpoints: backend.listCheckpoints(rootId) };
}

const DRIFTS = ["renamed", "earlier", "output", "parents", "stage-id", "occurrence", "child-owned"] as const;
type Drift = (typeof DRIFTS)[number];

/**
 * A record shaped like the metadata replay writes for a recorded stage. Without
 * `drift` it copies the stage's identity as replay does; each drift changes
 * one thing the cache must notice.
 */
function metadataRecord(
	stage: DurableStageCheckpoint,
	sequence: number,
	completedAt: number,
	drift?: Drift,
	childRun?: NonNullable<DurableStageCheckpoint["topology"]>["run"],
): DurableStageCheckpoint {
	const { boundary: _boundary, occurrenceKey: _occurrenceKey, ...topology } = stage.topology!;
	return {
		kind: "stage",
		workflowId: stage.workflowId,
		checkpointId: `${STAGE_REPLAY_METADATA_CHECKPOINT_PREFIX}${sequence}`,
		name: drift === "renamed" ? `${stage.name}-renamed` : stage.name,
		replayKey: stage.replayKey,
		completedAt: drift === "earlier" ? stage.completedAt - 1 : completedAt,
		startedAt: completedAt - 5,
		endedAt: completedAt,
		...(drift === "output" ? { output: "drifted output" } : {}),
		topology: {
			...topology,
			...(drift === "parents" ? { parentIds: ["missing-parent"] } : {}),
			...(drift === "stage-id" ? { stageId: `${topology.stageId}-drift` } : {}),
			...(drift === "occurrence" ? { occurrenceKey: "drift" } : {}),
			...(drift === "child-owned" && childRun !== undefined ? { run: childRun } : {}),
			status: "completed",
		},
	};
}

function candidateRunIds(checkpoints: readonly DurableCheckpoint[]): readonly string[] {
	const ids = new Set<string>();
	for (const checkpoint of checkpoints) {
		if (checkpoint.kind === "ui") continue;
		const runId = checkpoint.topology?.run?.runId;
		if (runId !== undefined) ids.add(runId);
		if (checkpoint.kind === "stage" && checkpoint.topology?.boundary !== undefined) {
			ids.add(checkpoint.topology.boundary.child.runId);
		}
	}
	ids.add("unknown-run");
	return [...ids];
}

function assertMatchesReference(
	backend: MemoryJournalBackend,
	rootId: string,
	runIds: readonly string[],
	step: string,
): number {
	const nested = durableNestedRunSnapshots(backend, rootId);
	assert.deepStrictEqual(nested, referenceNestedRunSnapshots(backend, rootId), `nested runs diverged at ${step}`);
	let completeSubtrees = 0;
	for (const runId of runIds) {
		const subtree = durableCompletedNestedRunSubtree(backend, rootId, runId);
		assert.deepStrictEqual(
			subtree,
			referenceCompletedNestedRunSubtree(backend, rootId, runId),
			`subtree of ${runId} diverged at ${step}`,
		);
		if (subtree === undefined) continue;
		completeSubtrees += 1;
		// Callers own what they receive: mutating it must not leak into later lookups.
		const first = subtree[0] as { status: string; stages: unknown[] };
		first.status = "running";
		first.stages.length = 0;
	}
	const firstNested = nested[0] as { status: string; stages: unknown[] } | undefined;
	if (firstNested !== undefined) {
		firstNested.status = "running";
		firstNested.stages.length = 0;
	}
	return completeSubtrees;
}

async function replayedBackend(
	rootId: string,
	createdAt: number,
	checkpoints: readonly DurableCheckpoint[],
): Promise<MemoryJournalBackend> {
	const backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: rootId,
		name: "random-node",
		inputs: {},
		createdAt,
		status: "running",
	});
	for (const checkpoint of checkpoints) await backend.commitCheckpoint(checkpoint);
	return backend;
}

const HISTORIES = 60;

/** Structural: dozens of full workflow runs, each replayed checkpoint by checkpoint against the reference. */
const RANDOMIZED_HISTORIES_TIMEOUT_MS = 120_000;

describe("cached nested run reconstruction", () => {
	test(
		"matches the uncached reconstruction for every child across randomized interleaved histories",
		async () => {
			let keptMetadata = 0;
			let completeSubtrees = 0;
			const invalidatingDrifts = new Set<Drift>();
			for (let seed = 1; seed <= HISTORIES; seed++) {
				const { rootId, checkpoints } = await recordedHistory(seed);
				const random = mulberry32(seed * 7919);
				const runIds = candidateRunIds(checkpoints);
				const createdAt = checkpoints[0]?.completedAt ?? 0;
				const backend = await replayedBackend(rootId, createdAt, []);
				const recordedStages: DurableStageCheckpoint[] = [];
				let completedAt = 0;
				let sequence = 0;
				for (const [index, checkpoint] of checkpoints.entries()) {
					await backend.commitCheckpoint(checkpoint);
					completedAt = Math.max(completedAt, checkpoint.completedAt);
					if (checkpoint.kind === "stage" && checkpoint.topology !== undefined) recordedStages.push(checkpoint);
					completeSubtrees += assertMatchesReference(backend, rootId, runIds, `seed ${seed} checkpoint ${index}`);
					if (recordedStages.length === 0 || random() < 0.3) continue;

					// Replay writes metadata for root stages after hydrating them, so favor those.
					const rootStages = recordedStages.filter((stage) => (stage.topology?.run?.runId ?? rootId) === rootId);
					const pool = rootStages.length > 0 && random() < 0.8 ? rootStages : recordedStages;
					const stage = pool[Math.floor(random() * pool.length)]!;
					completedAt += 1;
					sequence += 1;
					const before = backend.nestedSnapshotVersion(rootId);
					await backend.commitCheckpoint(metadataRecord(stage, sequence, completedAt));
					if (backend.nestedSnapshotVersion(rootId) === before) keptMetadata += 1;
					assertMatchesReference(backend, rootId, runIds, `seed ${seed} metadata ${sequence}`);
					if (random() < 0.85) continue;

					// Drift would poison the rest of this history, so probe it on a copy.
					const drift = DRIFTS[Math.floor(random() * DRIFTS.length)]!;
					const childRun = recordedStages.find(
						(candidate) => (candidate.topology?.run?.runId ?? rootId) !== rootId,
					)?.topology?.run;
					if (drift === "child-owned" && childRun === undefined) continue;
					const probe = await replayedBackend(rootId, createdAt, backend.listCheckpoints(rootId));
					const probeBefore = probe.nestedSnapshotVersion(rootId);
					assertMatchesReference(probe, rootId, runIds, `seed ${seed} before ${drift} drift`);
					completedAt += 1;
					sequence += 1;
					await probe.commitCheckpoint(metadataRecord(stage, sequence, completedAt, drift, childRun));
					if (probe.nestedSnapshotVersion(rootId) !== probeBefore) invalidatingDrifts.add(drift);
					assertMatchesReference(probe, rootId, runIds, `seed ${seed} ${drift} drift`);
				}
			}
			assert.ok(keptMetadata > 0, "histories exercise metadata the cache keeps");
			assert.ok(completeSubtrees > 0, "histories reconstruct complete cached subtrees");
			assert.deepEqual([...invalidatingDrifts].sort(), [...DRIFTS].sort(), "every drift kind invalidates the cache");
		},
		RANDOMIZED_HISTORIES_TIMEOUT_MS,
	);
});
