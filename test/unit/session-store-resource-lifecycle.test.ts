import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, vi } from "vitest";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { StorageProvider } from "../../packages/coding-agent/src/core/storage/provider.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	completedWorkflowRunSnapshots,
	listCompletedFromBackend,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { ForkCopyFailedError } from "../../packages/workflows/src/durable/fork-errors.js";
import { forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

for (const scenario of ["success", "failure", "borrowed destination"] as const) {
	test(`workflow fork releases only its own stores on ${scenario} (#4321)`, async () => {
		const cwd = makeTempDirectory("fork-store-lifetime-");
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(cwd, "agent"));
		const backend = await createMemoryTestBackend();
		const sourceStore = await resolveSessionStore(cwd);
		const sourceSession = (await sourceStore.list({ cwd, includeInternal: true })[Symbol.asyncIterator]().next())
			.value;
		assert.equal(sourceSession, undefined);
		const { SessionManager } = await import("../../packages/coding-agent/src/core/session-manager.js");
		const session = await SessionManager.create(sourceStore, cwd);
		await session.appendMessage({ role: "user", content: "saved", timestamp: 1 });
		await sourceStore.close();
		const runId = testRunId(`fork-store-lifetime-${scenario}`);
		const definition = workflow({ name: "source", description: "", inputs: {}, outputs: {}, run: async () => ({}) });
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "source",
			inputs: {},
			status: "paused",
			createdAt: 1,
			invocationCwd: cwd,
		});
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: "stage:saved",
			name: "saved",
			replayKey: "saved",
			sessionId: session.getSessionId(),
			output: "saved",
			completedAt: 2,
		});
		const borrowed = scenario === "borrowed destination" ? await resolveSessionStore(cwd) : undefined;
		const acquisitions = vi.spyOn(StorageProvider.prototype, "openSessionStore");
		const databaseClose = vi.spyOn(DatabaseSync.prototype, "close");
		const copy = vi.spyOn(backend.journal, "createRunWithEvents");
		if (scenario === "failure") copy.mockRejectedValue(new Error("commit failed"));
		try {
			const result = forkDurableRun(backend, {
				source: "sdk",
				runId,
				cwd,
				carryMessages: "before",
				definition,
				...(borrowed === undefined ? {} : { sessionStore: borrowed }),
			});
			if (scenario === "failure") await assert.rejects(result, ForkCopyFailedError);
			else assert.ok((await result).runId);
			assert.equal(acquisitions.mock.results.length, borrowed ? 1 : 2);
			for (const acquisition of acquisitions.mock.results) {
				const store = await acquisition.value;
				await assert.rejects(store.load(session.getSessionId()), { name: "StoreClosedError" });
			}
			if (borrowed) assert.ok(await borrowed.readHeader(session.getSessionId()));
			assert.equal(
				databaseClose.mock.calls.length,
				borrowed ? 0 : 1,
				"the source store stays open while the copy runs, so both stores share one database, closed once",
			);
		} finally {
			for (const acquisition of acquisitions.mock.results) await (await acquisition.value).close();
			await borrowed?.close();
			databaseClose.mockRestore();
			acquisitions.mockRestore();
			copy.mockRestore();
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
