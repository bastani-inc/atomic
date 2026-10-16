import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

describe("durable workflow origin", () => {
	test("registered user and agent origins round-trip through the handle and catalog", async () => {
		const backend = await createMemoryTestBackend();
		for (const origin of ["user", "agent"] as const) {
			const workflowId = `origin-${origin}`;
			await backend.commitWorkflowRegistration({
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

	test("a handle registered without origin keeps origin absent rather than guessing", async () => {
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
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

	test("re-registering without origin preserves the previously recorded origin", async () => {
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: "origin-preserved",
			name: "preserved-workflow",
			inputs: {},
			createdAt: 10,
			status: "running",
			origin: "agent",
		});
		await backend.commitWorkflowRegistration({
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
