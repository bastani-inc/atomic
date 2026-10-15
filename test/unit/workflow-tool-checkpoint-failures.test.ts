import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableCheckpoint, DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

describe("tool checkpoint failures", () => {
	test("DBOS best-effort rejection updates neither mirror nor fatal flush state", async () => {
		const baseSdk = createMockSdk();
		const persist = baseSdk.recordStepOutput.bind(baseSdk);
		let rejectMigration = false;
		const sdk = {
			...baseSdk,
			async recordStepOutput(...args: Parameters<typeof baseSdk.recordStepOutput>) {
				const [, stepName] = args;
				if (rejectMigration && stepName.includes("tool-replay-meta:")) throw new Error("dbos additive rejected");
				await persist(...args);
			},
		};
		const backend = new DbosDurableBackend(sdk);
		backend.registerWorkflow({
			workflowId: "dbos-best-effort",
			name: "dbos",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		await backend.flush();
		const checkpoint: DurableToolCheckpoint = {
			kind: "tool",
			workflowId: "dbos-best-effort",
			checkpointId: "tool-replay-meta:test",
			name: "legacy",
			argsHash: "legacy-hash",
			output: "cached",
			completedAt: 2,
			topology: { version: 1, nodeId: "tool:legacy", ordinal: 1, order: 1, parentIds: [], endedAt: 2 },
		};

		rejectMigration = true;
		assert.equal(await backend.recordAdditiveCheckpointBestEffort(checkpoint), false);
		assert.equal(backend.getToolCheckpoint("dbos-best-effort", "legacy-hash"), undefined);
		await backend.flush();

		rejectMigration = false;
		assert.equal(await backend.recordAdditiveCheckpointBestEffort(checkpoint), true);
		assert.equal(backend.getToolCheckpoint("dbos-best-effort", "legacy-hash")?.output, "cached");
		await backend.flush();
	});

	test("authoritative fresh checkpoint failures still fail the run", async () => {
		class RejectAuthoritativeBackend extends InMemoryDurableBackend {
			override async recordCheckpointAsync(checkpoint: DurableCheckpoint): Promise<void> {
				if (checkpoint.kind === "tool") throw new Error("authoritative write rejected");
				await super.recordCheckpointAsync(checkpoint);
			}
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
			{ store: createStore(), durableBackend: new RejectAuthoritativeBackend() },
		);
		assert.equal(result.status, "failed");
		assert.equal(callbackCalls, 1);
		assert.match(result.error ?? "", /authoritative write rejected/);
		assert.equal(result.toolNodes?.[0]?.status, "failed");
	});

	test("cached checkpoint lookup failures surface before callbacks or migration", async () => {
		class RejectLookupBackend extends InMemoryDurableBackend {
			override getToolCheckpoint(): DurableToolCheckpoint | undefined {
				throw new Error("lookup rejected");
			}
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
			{ store: createStore(), durableBackend: new RejectLookupBackend() },
		);
		assert.equal(result.status, "failed");
		assert.equal(callbackCalls, 0);
		assert.match(result.error ?? "", /lookup rejected/);
		assert.deepEqual(result.toolNodes, []);
	});
});
