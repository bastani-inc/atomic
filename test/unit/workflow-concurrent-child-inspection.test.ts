import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableNestedRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { testRunId } from "../helpers/run-id.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const POOL_SIZE = 5;
const ITEMS = 8;

function startedCounter(target: number): { readonly note: () => void; readonly reached: Promise<void> } {
	const reached = Promise.withResolvers<void>();
	let count = 0;
	return {
		note: () => {
			count += 1;
			if (count === target) reached.resolve();
		},
		reached: reached.promise,
	};
}

function untilAborted(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		const fail = (): void => reject(signal.reason);
		if (signal.aborted) fail();
		else signal.addEventListener("abort", fail, { once: true });
	});
}

describe("inspecting a run with concurrent branches in flight", () => {
	test("a running pool whose child workflows have not checkpointed yet stays inspectable (#3846)", async () => {
		const backend = await createMemoryTestBackend();
		const childGate = Promise.withResolvers<void>();
		const started = startedCounter(POOL_SIZE);
		const child = workflow({
			name: "child",
			description: "",
			inputs: { topic: Type.String() },
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("child-work", { topic: ctx.inputs.topic }, async () => {
					started.note();
					await childGate.promise;
					return "done";
				});
				return {};
			},
		});
		const rootId = testRunId("concurrent-child-pool");
		const parent = workflow({
			name: "rolling-pool",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const inFlight = new Map<number, Promise<void>>();
				let next = 0;
				while (next < ITEMS || inFlight.size > 0) {
					while (next < ITEMS && inFlight.size < POOL_SIZE) {
						const index = next++;
						inFlight.set(
							index,
							ctx.workflow(child, { inputs: { topic: `topic-${index}` } }).then(() => {
								inFlight.delete(index);
							}),
						);
					}
					await Promise.race(inFlight.values());
				}
				return {};
			},
		});
		const pending = run(
			parent,
			{},
			{
				runId: rootId,
				registry: createRegistry([parent, child] as WorkflowDefinition[]),
				store: createStore(),
				durableBackend: backend,
			},
		);
		try {
			await started.reached;
			const inspected = await inspectTargetedDurableWorkflow(backend, rootId);
			assert.equal(inspected.kind, "found", inspected.kind === "found" ? "" : inspected.message);
			if (inspected.kind !== "found") return;
			assert.equal(inspected.detail.status, "running");
			const children = inspected.runs.filter((candidate) => candidate.parentRunId === rootId);
			assert.equal(children.length, POOL_SIZE);
			assert.ok(children.every((candidate) => candidate.status === "running" && candidate.endedAt === undefined));
			const root = inspected.runs.find((candidate) => candidate.id === rootId);
			assert.equal(root?.stages.length, POOL_SIZE);
			assert.ok(root?.stages.every((stage) => stage.workflowChildRun !== undefined));
		} finally {
			childGate.resolve();
		}
		assert.equal((await pending).status, "completed");
	});

	test("overlapping in-flight ctx.tool checkpoints never make the topology malformed (#3846)", async () => {
		const backend = await createMemoryTestBackend();
		const gates = Array.from({ length: POOL_SIZE }, () => Promise.withResolvers<void>());
		const started = startedCounter(POOL_SIZE);
		const rootId = testRunId("concurrent-tool-pool");
		const parent = workflow({
			name: "overlapping-tools",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await Promise.all(
					gates.map((gate, index) =>
						ctx.tool(`save-${index}`, { index }, async () => {
							started.note();
							await gate.promise;
							return "saved";
						}),
					),
				);
				return {};
			},
		});
		const pending = run(parent, {}, { runId: rootId, store: createStore(), durableBackend: backend });
		const verdicts: string[] = [];
		try {
			await started.reached;
			for (const gate of gates) {
				const inspected = await inspectTargetedDurableWorkflow(backend, rootId);
				verdicts.push(inspected.kind === "found" ? "found" : inspected.message);
				gate.resolve();
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		} finally {
			for (const gate of gates) gate.resolve();
		}
		assert.equal((await pending).status, "completed");
		assert.deepEqual(verdicts, Array(POOL_SIZE).fill("found"));
	});

	test("a pool failed by a rejected ctx.tool releases its lease and stays inspectable (#3846)", async () => {
		const backend = await JournalTestBackend.create();
		const child = workflow({
			name: "child",
			description: "",
			inputs: { topic: Type.String() },
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("child-work", { topic: ctx.inputs.topic }, async ({ signal }) => {
					if (ctx.inputs.topic !== "topic-0") await untilAborted(signal);
					return "done";
				});
				return {};
			},
		});
		const parent = workflow({
			name: "rolling-pool",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const inFlight = new Map<number, Promise<void>>();
				for (let index = 0; index < POOL_SIZE; index++) {
					const branch = async (): Promise<void> => {
						await ctx.workflow(child, { inputs: { topic: `topic-${index}` } });
						await ctx.tool(`save-${index}`, { index }, async () => {
							throw Object.assign(new Error("ENOENT: no such file or directory, rename"), { code: "ENOENT" });
						});
					};
					inFlight.set(
						index,
						branch().finally(() => inFlight.delete(index)),
					);
				}
				while (inFlight.size > 0) await Promise.race(inFlight.values());
				return {};
			},
		});
		const result = await run(
			parent,
			{},
			{
				registry: createRegistry([parent, child] as WorkflowDefinition[]),
				store: createStore(),
				durableBackend: backend,
			},
		);

		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /ENOENT/);
		assert.equal(backend.getWorkflow(result.runId)?.status, "failed");
		assert.equal(await backend.workflowOwnership(result.runId), "available");
		const inspected = await inspectTargetedDurableWorkflow(backend, result.runId);
		assert.equal(inspected.kind, "found", inspected.kind === "found" ? "" : inspected.message);
		if (inspected.kind === "found") assert.equal(inspected.detail.status, "failed");
	});

	test("a run that fails while its child workflows have not checkpointed yet cancels them and stays inspectable (#3846)", async () => {
		const backend = await createMemoryTestBackend();
		const started = startedCounter(POOL_SIZE);
		const child = workflow({
			name: "child",
			description: "",
			inputs: { topic: Type.String() },
			outputs: {},
			run: async () => {
				started.note();
				return await new Promise<never>(() => {});
			},
		});
		const parent = workflow({
			name: "rolling-pool",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				for (let index = 0; index < POOL_SIZE; index++) {
					ctx.workflow(child, { inputs: { topic: `topic-${index}` } }).catch(() => {});
				}
				await started.reached;
				throw new Error("pool failed before its children checkpointed");
			},
		});
		const result = await run(
			parent,
			{},
			{
				registry: createRegistry([parent, child] as WorkflowDefinition[]),
				store: createStore(),
				durableBackend: backend,
			},
		);

		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /pool failed before its children checkpointed/);
		const inspected = await inspectTargetedDurableWorkflow(backend, result.runId);
		assert.equal(inspected.kind, "found", inspected.kind === "found" ? "" : inspected.message);
		if (inspected.kind !== "found") return;
		assert.equal(inspected.detail.status, "failed");
		assert.ok(inspected.runs.every((candidate) => candidate.status !== "running"));
	});

	test("a terminal root whose child boundary never reached a terminal record stays malformed (#3846)", async () => {
		const rootId = testRunId("concurrent-child-terminal-strict");
		const childId = testRunId("concurrent-child-terminal-strict-child");
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: rootId,
			name: "root",
			inputs: {},
			createdAt: 1,
			status: "failed",
		});
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: rootId,
			checkpointId: "boundary-start",
			name: "workflow:child",
			replayKey: "workflow:child:1",
			completedAt: 2,
			topology: {
				version: 1,
				stageId: "boundary",
				parentIds: [],
				sourceOrder: 0,
				status: "running",
				run: { runId: rootId, runName: "root" },
				boundary: {
					version: 1,
					event: "start",
					status: "running",
					replayScope: "workflow:child:1",
					alias: "child",
					workflow: "child",
					invocationFingerprint: "child-fingerprint",
					child: {
						runId: childId,
						runName: "child",
						parentRunId: rootId,
						parentStageId: "boundary",
						rootRunId: rootId,
					},
				},
			},
		});

		const inspected = await inspectTargetedDurableWorkflow(backend, rootId);
		assert.equal(inspected.kind, "malformed");
	});
});

describe("inspecting a running root after one of its children settled unsuccessfully", () => {
	async function rootWithSettledChild() {
		const backend = await createMemoryTestBackend();
		const gate = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		const settled = startedCounter(2);
		const child = workflow({
			name: "child",
			description: "",
			inputs: { outcome: Type.String() },
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("child-work", { outcome: ctx.inputs.outcome }, async () => {
					if (ctx.inputs.outcome !== "hold") return "done";
					held.resolve();
					await gate.promise;
					return "done";
				});
				if (ctx.inputs.outcome === "fail") throw new Error("child failed after checkpointing");
				return {};
			},
		});
		const rootId = testRunId("settled-child-inspection");
		const parent = workflow({
			name: "tolerant-root",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await Promise.allSettled(
					["fail", "finish", "hold"].map((outcome) =>
						ctx.workflow(child, { inputs: { outcome } }).finally(() => {
							if (outcome !== "hold") settled.note();
						}),
					),
				);
				return {};
			},
		});
		const pending = run(
			parent,
			{},
			{
				runId: rootId,
				registry: createRegistry([parent, child] as WorkflowDefinition[]),
				store: createStore(),
				durableBackend: backend,
			},
		);
		await Promise.all([held.promise, settled.reached]);
		return { backend, rootId, pending, release: () => gate.resolve() };
	}

	function assertSettledChildPruned(
		inspected: Awaited<ReturnType<typeof inspectTargetedDurableWorkflow>>,
		rootId: string,
		status: string,
	): void {
		assert.equal(inspected.kind, "found", inspected.kind === "found" ? "" : inspected.message);
		if (inspected.kind !== "found") return;
		const root = inspected.runs.find((candidate) => candidate.id === rootId);
		assert.deepEqual(root?.stages.map((stage) => stage.status).sort(), ["completed", "running", status].sort());
		assert.deepEqual(
			inspected.runs
				.filter((candidate) => candidate.parentRunId === rootId)
				.map((candidate) => candidate.status)
				.sort(),
			["completed", "running"],
		);
	}

	test("a failed child that checkpointed keeps a running root inspectable and its completed sibling replayable (#3903)", async () => {
		const { backend, rootId, pending, release } = await rootWithSettledChild();
		try {
			assertSettledChildPruned(await inspectTargetedDurableWorkflow(backend, rootId), rootId, "failed");
			assert.deepEqual(
				durableNestedRunSnapshots(backend, rootId)
					.map((candidate) => candidate.status)
					.sort(),
				["completed", "running"],
				"resume replays the completed sibling from these snapshots",
			);
		} finally {
			release();
		}
		assert.equal((await pending).status, "completed");
	});

	test("a skipped child that checkpointed keeps a running root inspectable (#3903)", async () => {
		const { backend, rootId, pending, release } = await rootWithSettledChild();
		const skipped = await createMemoryTestBackend();
		try {
			const handle = backend.getWorkflow(rootId)!;
			await skipped.commitWorkflowRegistration({
				workflowId: rootId,
				name: handle.name,
				inputs: {},
				createdAt: handle.createdAt,
				status: "running",
			});
			for (const checkpoint of backend.listCheckpoints(rootId)) {
				const boundary = checkpoint.kind === "stage" ? checkpoint.topology?.boundary : undefined;
				if (checkpoint.kind !== "stage" || boundary?.event !== "terminal" || boundary.status !== "failed") {
					await skipped.commitCheckpoint(checkpoint);
					continue;
				}
				const rewritten: DurableCheckpoint = {
					...checkpoint,
					topology: { ...checkpoint.topology!, status: "skipped", boundary: { ...boundary, status: "skipped" } },
				};
				await skipped.commitCheckpoint(rewritten);
			}
			assertSettledChildPruned(await inspectTargetedDurableWorkflow(skipped, rootId), rootId, "skipped");
		} finally {
			release();
		}
		assert.equal((await pending).status, "completed");
	});
});
