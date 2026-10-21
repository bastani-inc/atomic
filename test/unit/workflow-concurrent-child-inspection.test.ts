import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
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
