import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, vi } from "vitest";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { StorageProvider } from "../../packages/coding-agent/src/core/storage/provider.js";
import {
	completedWorkflowRunSnapshots,
	listCompletedFromBackend,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { forkDurableWorkflow } from "../../packages/workflows/src/durable/fork-workflow.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

for (const scenario of ["success", "failure", "borrowed destination"] as const) {
	test(`workflow fork releases only its own stores on ${scenario}`, async () => {
		const cwd = makeTempDirectory("fork-store-lifetime-");
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(cwd, "agent"));
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: "source",
			name: "source",
			inputs: {},
			status: "paused",
			createdAt: 1,
			invocationCwd: cwd,
		});
		const borrowed = scenario === "borrowed destination" ? await resolveSessionStore(cwd) : undefined;
		const acquisitions = vi.spyOn(StorageProvider.prototype, "openSessionStore");
		const databaseClose = vi.spyOn(DatabaseSync.prototype, "close");
		const registration = vi.spyOn(backend, "commitWorkflowRegistration");
		if (scenario === "failure") registration.mockRejectedValue(new Error("commit failed"));
		try {
			const result = forkDurableWorkflow(backend, backend.getWorkflow("source")!, cwd, undefined, borrowed);
			if (scenario === "failure") await assert.rejects(result, /commit failed/);
			else assert.ok(await result);
			assert.equal(acquisitions.mock.results.length, borrowed ? 1 : 2);
			for (const acquisition of acquisitions.mock.results) {
				const store = await acquisition.value;
				await assert.rejects(store.load("source"), { name: "StoreClosedError" });
			}
			if (borrowed) assert.equal(await borrowed.readHeader("source"), undefined);
			assert.equal(databaseClose.mock.calls.length, borrowed ? 0 : 1);
		} finally {
			for (const acquisition of acquisitions.mock.results) await (await acquisition.value).close();
			await borrowed?.close();
			databaseClose.mockRestore();
			acquisitions.mockRestore();
			registration.mockRestore();
			vi.unstubAllEnvs();
			removeTempDirectory(cwd);
		}
	});
}

test("completed workflow inspection releases its temporary session store", async () => {
	const cwd = makeTempDirectory("completed-store-lifetime-");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(cwd, "agent"));
	const backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: "completed",
		name: "completed",
		inputs: {},
		status: "completed",
		createdAt: 1,
		invocationCwd: cwd,
	});
	await backend.commitCheckpoint({
		kind: "tool",
		workflowId: "completed",
		checkpointId: "tool",
		name: "tool",
		argsHash: "hash",
		output: "done",
		completedAt: 2,
	});
	const acquisitions = vi.spyOn(StorageProvider.prototype, "openSessionStore");
	const databaseClose = vi.spyOn(DatabaseSync.prototype, "close");
	try {
		await completedWorkflowRunSnapshots(backend, listCompletedFromBackend(backend)[0]!);
		assert.equal(acquisitions.mock.results.length, 1);
		const store = await acquisitions.mock.results[0]!.value;
		await assert.rejects(store.load("completed"), { name: "StoreClosedError" });
		assert.equal(databaseClose.mock.calls.length, 1);
	} finally {
		for (const acquisition of acquisitions.mock.results) await (await acquisition.value).close();
		databaseClose.mockRestore();
		acquisitions.mockRestore();
		vi.unstubAllEnvs();
		removeTempDirectory(cwd);
	}
});
