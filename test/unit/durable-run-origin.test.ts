import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import type { DbosStepRecord } from "../../packages/workflows/src/durable/dbos-backend.js";
import { parseCurrentMetadataRecord } from "../../packages/workflows/src/durable/dbos-metadata.js";

describe("durable workflow origin", () => {
	test("registered user and agent origins round-trip through the handle and catalog", () => {
		const backend = new InMemoryDurableBackend();
		for (const origin of ["user", "agent"] as const) {
			const workflowId = `origin-${origin}`;
			backend.registerWorkflow({
				workflowId,
				name: `workflow-${origin}`,
				inputs: {},
				createdAt: 10,
				status: "paused",
				completedCheckpoints: 1,
				resumable: true,
				origin,
			});

			assert.equal(backend.getWorkflow(workflowId)?.origin, origin);
			assert.equal(
				backend.listResumableWorkflows().find((entry) => entry.workflowId === workflowId)?.origin,
				origin,
			);
			assert.equal(backend.toMetadata(workflowId)?.origin, origin);
		}
	});

	test("a handle registered without origin keeps origin absent rather than guessing", () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: "origin-omitted",
			name: "legacy-workflow",
			inputs: {},
			createdAt: 10,
			status: "paused",
		});

		assert.equal(backend.getWorkflow("origin-omitted")?.origin, undefined);
		assert.equal(
			backend.listResumableWorkflows().find((entry) => entry.workflowId === "origin-omitted")?.origin,
			undefined,
		);
		assert.equal(backend.toMetadata("origin-omitted")?.origin, undefined);
	});

	test("DBOS metadata omits a bogus origin value while retaining the valid record", () => {
		const record: DbosStepRecord = {
			stepName: "__atomic_metadata:20:bogus-origin",
			output: {
				__atomicDurableMetadata: true,
				version: 3,
				metadata: {
					workflowId: "origin-bogus",
					name: "bogus-origin",
					inputs: {},
					status: "paused",
					createdAt: 10,
					completedCheckpoints: 1,
					pendingPrompts: 0,
					promptReservationEpoch: "epoch-1",
					updatedAt: 20,
					origin: "not-a-real-actor",
				},
			},
		};

		const parsed = parseCurrentMetadataRecord(record, "origin-bogus");
		assert.ok(parsed);
		assert.equal(parsed.origin, undefined);
	});

	test("re-registering without origin preserves the previously recorded origin", () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: "origin-preserved",
			name: "preserved-workflow",
			inputs: {},
			createdAt: 10,
			status: "running",
			origin: "agent",
		});
		backend.registerWorkflow({
			workflowId: "origin-preserved",
			name: "preserved-workflow",
			inputs: {},
			createdAt: 10,
			status: "paused",
		});

		assert.equal(backend.getWorkflow("origin-preserved")?.origin, "agent");
		assert.equal(backend.toMetadata("origin-preserved")?.origin, "agent");
	});
});
