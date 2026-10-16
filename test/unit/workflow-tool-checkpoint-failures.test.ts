import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { StorageUnavailableError } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableCheckpoint, DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

describe("tool checkpoint failures", () => {
	test("journal best-effort storage rejection leaves checkpoints unchanged and permits a later write", async () => {
		async function createRejectAdditiveBackend(...args: Parameters<typeof JournalTestBackend.create>) {
			const backend = Object.assign(await JournalTestBackend.create(...args), { rejectWrite: false });
			const baserecordCheckpointAsync = backend.recordCheckpointAsync.bind(backend);
			return Object.assign(backend, {
				async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
					if (backend.rejectWrite)
						throw new StorageUnavailableError(
							{ adapter: "node-sqlite", location: backend.databasePath },
							new Error("write rejected"),
						);
					await baserecordCheckpointAsync(checkpoint);
				},
			});
		}
		const backend = await createRejectAdditiveBackend();
		await backend.registerWorkflow({
			workflowId: "journal-best-effort",
			name: "journal",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		const checkpoint: DurableToolCheckpoint = {
			kind: "tool",
			workflowId: "journal-best-effort",
			checkpointId: "tool-checkpoint:test",
			name: "tool",
			argsHash: "tool-hash",
			output: "cached",
			completedAt: 2,
			topology: { version: 1, nodeId: "tool:tool", ordinal: 1, order: 1, parentIds: [], endedAt: 2 },
		};
		backend.rejectWrite = true;
		assert.equal(await backend.recordAdditiveCheckpointBestEffort(checkpoint), false);
		assert.equal(backend.getToolCheckpoint("journal-best-effort", "tool-hash"), undefined);
		backend.rejectWrite = false;
		assert.equal(await backend.recordAdditiveCheckpointBestEffort(checkpoint), true);
		assert.equal(backend.getToolCheckpoint("journal-best-effort", "tool-hash")?.output, "cached");
		const reopened = await backend.reopen();
		assert.equal(reopened.getToolCheckpoint("journal-best-effort", "tool-hash")?.output, "cached");
	});

	test("authoritative fresh checkpoint failures still fail the run", async () => {
		async function createRejectAuthoritativeBackend() {
			const backend = Object.assign(await createMemoryTestBackend(), {});
			const baserecordCheckpointAsync = backend.recordCheckpointAsync.bind(backend);
			return Object.assign(backend, {
				async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
					if (checkpoint.kind === "tool")
						throw new StorageUnavailableError(
							{ adapter: "node-sqlite", location: "authoritative write rejected" },
							new Error("fixture storage failure"),
						);
					await baserecordCheckpointAsync(checkpoint);
				},
			});
		}
		let callbackCalls = 0;
		const result = await run(
			workflow({
				name: "authoritative-failure",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.tool("fresh", {}, async () => {
						callbackCalls += 1;
						return "done";
					});
					return {};
				},
			}),
			{},
			{ store: createStore(), durableBackend: await createRejectAuthoritativeBackend() },
		);
		assert.equal(result.status, "failed");
		assert.equal(callbackCalls, 1);
		assert.match(result.error ?? "", /authoritative write rejected/);
		assert.equal(result.toolNodes?.[0]?.status, "failed");
	});

	test("cached checkpoint lookup failures surface before callbacks or migration", async () => {
		async function createRejectLookupBackend() {
			const backend = Object.assign(await createMemoryTestBackend(), {});
			return Object.assign(backend, {
				getToolCheckpoint(): DurableToolCheckpoint | undefined {
					throw new Error("lookup rejected");
				},
			});
		}
		let callbackCalls = 0;
		const result = await run(
			workflow({
				name: "lookup-failure",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					await ctx.tool("lookup", {}, async () => {
						callbackCalls += 1;
						return "no";
					});
					return {};
				},
			}),
			{},
			{ store: createStore(), durableBackend: await createRejectLookupBackend() },
		);
		assert.equal(result.status, "failed");
		assert.equal(callbackCalls, 0);
		assert.match(result.error ?? "", /lookup rejected/);
		assert.deepEqual(result.toolNodes, []);
	});
});
