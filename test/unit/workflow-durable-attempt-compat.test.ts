import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { latestWorkflowAttempt } from "../../packages/workflows/src/durable/attempt-identity.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { durableWorkflowRunSnapshots as olderDurableWorkflowRunSnapshots } from "../helpers/reference-nested-run-snapshots/completed-catalog.js";
import { legacyBoundaryRecord } from "../helpers/reference-nested-run-snapshots/legacy-boundary-record.js";
import { testRunId } from "../helpers/run-id.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

afterEach(closeMemoryTestBackends);

/**
 * Runs start outside any Git checkout. A run started on a branch records it, and the reference catalog predates that
 * field, so the ambient checkout's branch must not reach the comparison.
 */
let invocationCwd = "";
beforeAll(async () => {
	invocationCwd = await mkdtemp(join(tmpdir(), "atomic-attempt-compat-"));
});
afterAll(async () => {
	await rm(invocationCwd, { recursive: true, force: true });
});

type Point = "s1" | "t1" | "s2" | "child";
type Ending =
	| { readonly kind: "complete" }
	| { readonly kind: "exit"; readonly after: "s1" | "t1" | "s2" }
	| { readonly kind: "fail"; readonly at: Point }
	| { readonly kind: "caught" };

const ENDINGS: readonly Ending[] = [
	{ kind: "complete" },
	{ kind: "exit", after: "s1" },
	{ kind: "exit", after: "t1" },
	{ kind: "exit", after: "s2" },
	{ kind: "fail", at: "s1" },
	{ kind: "fail", at: "t1" },
	{ kind: "fail", at: "s2" },
	{ kind: "fail", at: "child" },
	{ kind: "caught" },
];

/** A small seeded generator, so a failing history can be replayed from its seed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), state | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function definitions(current: { ending: Ending }): { parent: WorkflowDefinition; child: WorkflowDefinition } {
	const fails = (point: Point) => current.ending.kind === "fail" && current.ending.at === point;
	const child = workflow({
		name: "compat-child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("c1").prompt("c1");
			await ctx.tool("ct", {}, async () => {
				if (fails("child")) throw new Error("planned child failure");
				return "ct";
			});
			return {};
		},
	}) as WorkflowDefinition;
	const exitAfter = (node: "s1" | "t1" | "s2", ctx: { exit(options: { reason: string }): never }) => {
		if (current.ending.kind === "exit" && current.ending.after === node) ctx.exit({ reason: `after ${node}` });
	};
	const parent = workflow({
		name: "compat-parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("s1").prompt("s1");
			exitAfter("s1", ctx);
			await ctx.tool("t1", {}, async () => {
				if (fails("t1")) throw new Error("planned tool failure");
				return "t1";
			});
			exitAfter("t1", ctx);
			try {
				await ctx.stage("s2").prompt("s2");
			} catch (error) {
				if (current.ending.kind !== "caught") throw error;
			}
			exitAfter("s2", ctx);
			await ctx.workflow(child);
			return {};
		},
	}) as WorkflowDefinition;
	return { parent, child };
}

/**
 * A backend as an Atomic release before #4874 writes through: it records no attempt, so it stamps nothing and scopes
 * no id by attempt.
 */
function olderWriter(backend: DurableWorkflowBackend): DurableWorkflowBackend {
	return new Proxy(backend, {
		get(target, key) {
			if (key === "workflowAttempt") return undefined;
			if (key === "commitCheckpoint")
				return (...[record, options]: Parameters<DurableWorkflowBackend["commitCheckpoint"]>) =>
					target.commitCheckpoint(legacyBoundaryRecord(record), options);
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** Graph names and statuses of the root and the runs reached through its boundary stages. */
function graph(runs: readonly RunSnapshot[], rootId: string): readonly string[] {
	const lines: string[] = [];
	const visit = (snapshot: RunSnapshot, depth: number) => {
		lines.push(
			`${depth}:${snapshot.name} [${snapshot.stages.map((stage) => `${stage.name}:${stage.status}`)}] [${snapshot.toolNodes.map(
				(tool) => `${tool.name}:${tool.status === "completed" ? "cached" : tool.status}`,
			)}]`,
		);
		const boundaries = new Set(
			snapshot.stages
				.filter(
					(stage) =>
						stage.startedChildRunId !== undefined || (stage.status !== "failed" && stage.status !== "skipped"),
				)
				.map((stage) => stage.id),
		);
		for (const childRun of runs)
			if (childRun.parentRunId === snapshot.id && boundaries.has(childRun.parentStageId ?? ""))
				visit(childRun, depth + 1);
	};
	const root = runs.find((candidate) => candidate.id === rootId);
	if (root !== undefined) visit(root, 0);
	return lines;
}

interface Attempt {
	readonly ending: Ending;
	readonly status: string;
	/** The live graph the attempt ended with. */
	readonly live: readonly string[];
	/** The durable graph after it, as this release and as a release before #4874 rebuild it. */
	readonly durable: readonly string[];
	readonly older: readonly string[];
	readonly durableSnapshots: readonly RunSnapshot[];
	readonly olderSnapshots: readonly RunSnapshot[];
}

/** Run the sequence's attempts under one id until one completes; `older` writes as a release before #4874. */
async function runSequence(endings: readonly Ending[], label: string, older: boolean): Promise<readonly Attempt[]> {
	const backend = await createMemoryTestBackend();
	const durableBackend = older ? olderWriter(backend) : backend;
	const current = { ending: endings[0]! };
	const { parent, child } = definitions(current);
	const runId = testRunId(label);
	const attempts: Attempt[] = [];
	for (const ending of endings) {
		current.ending = ending;
		const store = createStore();
		const result = await run(
			parent,
			{},
			{
				runId,
				cwd: invocationCwd,
				store,
				registry: createRegistry([parent, child]),
				durableBackend,
				adapters: {
					prompt: {
						prompt: async (text: string) => {
							if ((ending.kind === "fail" && ending.at === text) || (ending.kind === "caught" && text === "s2"))
								throw new Error(`planned ${text}`);
							return text;
						},
					},
				},
			},
		);
		const handle = backend.getWorkflow(runId);
		assert.ok(handle);
		const durableSnapshots = durableWorkflowRunSnapshots(backend, handle);
		const olderSnapshots = olderDurableWorkflowRunSnapshots(backend, handle);
		attempts.push({
			ending,
			status: result.status,
			live: graph(store.runs(), runId),
			durable: graph(durableSnapshots, runId),
			older: graph(olderSnapshots, runId),
			durableSnapshots,
			olderSnapshots,
		});
		if (result.status !== "failed") break;
	}
	if (older) {
		// A run without attempt records is written as before #4874: nothing is stamped, and no record exists only to
		// say an attempt reached a node.
		const checkpoints = backend.listCheckpoints(runId);
		assert.equal(latestWorkflowAttempt(checkpoints), 0, `${label}: no attempt records`);
		assert.deepEqual(
			checkpoints.filter(
				(checkpoint) =>
					(checkpoint.kind !== "ui" && checkpoint.attempt !== undefined) ||
					/(^|:)(boundary-attempt|tool-replay-meta):|:a\d+:/.test(checkpoint.checkpointId),
			),
			[],
			label,
		);
	}
	return attempts;
}

function sequence(next: () => number): readonly Ending[] {
	return Array.from({ length: 2 + Math.floor(next() * 3) }, () => ENDINGS[Math.floor(next() * ENDINGS.length)]!);
}

const SEEDS = 40;

describe("durable attempt identity and journals other releases read (#4874)", () => {
	test("a journal without attempt records rebuilds exactly as before (#4874)", async () => {
		for (let seed = 1; seed <= SEEDS; seed += 1) {
			const endings = sequence(random(seed));
			const label = `seed ${seed}: ${JSON.stringify(endings)}`;
			for (const attempt of await runSequence(endings, `compat-older-${seed}`, true)) {
				assert.deepEqual(attempt.durableSnapshots, attempt.olderSnapshots, label);
			}
		}
	});

	test("the durable view equals the live run after every attempt of a resumed run (#4874)", async () => {
		for (let seed = 1; seed <= SEEDS; seed += 1) {
			const endings = sequence(random(seed));
			const label = `seed ${seed}: ${JSON.stringify(endings)}`;
			const attempts = await runSequence(endings, `compat-newer-${seed}`, false);
			attempts.forEach((attempt, index) => {
				assert.deepEqual(attempt.durable, attempt.live, `${label} attempt ${index + 1}`);
			});
		}
	});

	test("a release before #4874 reads a journal with attempt records as it reads one without (#4874)", async () => {
		for (let seed = 1; seed <= SEEDS; seed += 1) {
			const endings = sequence(random(seed));
			const label = `seed ${seed}: ${JSON.stringify(endings)}`;
			const newer = await runSequence(endings, `compat-mixed-new-${seed}`, false);
			const older = await runSequence(endings, `compat-mixed-old-${seed}`, true);
			assert.deepEqual(
				newer.map((attempt) => attempt.status),
				older.map((attempt) => attempt.status),
				label,
			);
			newer.forEach((attempt, index) => {
				assert.ok(attempt.older.length > 0, `${label} attempt ${index + 1}: the older release rebuilds the run`);
				assert.deepEqual(attempt.older, older[index]!.older, `${label} attempt ${index + 1}`);
			});
		}
	});
});
