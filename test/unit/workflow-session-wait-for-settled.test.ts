import assert from "node:assert/strict";
import { WorkflowRunStorageError } from "@bastani/atomic";
import { afterEach, describe, test } from "vitest";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { createSessionRunControl } from "../../packages/workflows/src/extension/workflow-session-run-control.js";
import {
	isCompletedStatusAppend,
	journalInterceptingAppend,
	journalWithAppendLatency,
	workflowHostOverJournal,
} from "../helpers/workflow-ended-run-host.js";

const JOURNAL_ROUND_TRIP_MS = 50;
const REMOTE_STORE_UNAVAILABLE = "remote store unavailable";

afterEach(() => {
	setDurableBackend(undefined);
});

function controlFor(host: ReturnType<typeof workflowHostOverJournal>) {
	return createSessionRunControl({
		execute: async () => {
			throw new Error("waitForSettled does not run workflow tool actions");
		},
		context: () => undefined,
		store: host.store,
		jobs: host.runState.jobs,
	});
}

async function startRun(host: ReturnType<typeof workflowHostOverJournal>) {
	const ended = host.reportsEnded();
	const accepted = await host.runtime.dispatch({ action: "run", workflow: "quick" });
	assert.ok("runId" in accepted && accepted.runId, JSON.stringify(accepted));
	return { runId: accepted.runId, ended };
}

describe("session.workflows.waitForSettled", () => {
	test("resolves once the ended run's terminal status is in the journal (#3811)", async () => {
		const memory = new MemoryRunJournal();
		const host = workflowHostOverJournal(journalWithAppendLatency(memory, JOURNAL_ROUND_TRIP_MS));
		const control = controlFor(host);
		const { runId, ended } = await startRun(host);
		await ended;
		assert.equal(
			(await memory.getRun(runId))?.status,
			"running",
			"the ending is still being written when the run reports it",
		);

		await control.waitForSettled(runId);

		assert.equal((await memory.getRun(runId))?.status, "completed");
		assert.equal((await memory.leaseState(runId))?.holderId ?? null, null);
		await host.shutdown();
	});

	test("rejects with a storage error when the journal never accepts the ending (#3811)", async () => {
		const memory = new MemoryRunJournal();
		const host = workflowHostOverJournal(
			journalInterceptingAppend(memory, async (event) => {
				if (isCompletedStatusAppend(event)) throw new Error(REMOTE_STORE_UNAVAILABLE);
			}),
		);
		const control = controlFor(host);
		const { runId, ended } = await startRun(host);
		await ended;

		await assert.rejects(control.waitForSettled(runId), (error: Error) => {
			assert.ok(error instanceof WorkflowRunStorageError);
			assert.equal(error.runId, runId);
			assert.match(error.message, new RegExp(REMOTE_STORE_UNAVAILABLE));
			return true;
		});
		await host.shutdown();
	});

	test("resolves at once for a run this session is not executing (#3811)", async () => {
		const host = workflowHostOverJournal(new MemoryRunJournal());
		const control = controlFor(host);

		await control.waitForSettled("00000000-0000-4000-8000-000000000000");
		await host.shutdown();
	});

	test("resolves for a run that already settled (#3811)", async () => {
		const memory = new MemoryRunJournal();
		const host = workflowHostOverJournal(memory);
		const control = controlFor(host);
		const { runId } = await startRun(host);
		await control.waitForSettled(runId);

		await control.waitForSettled(runId);
		assert.equal((await memory.getRun(runId))?.status, "completed");
		await host.shutdown();
	});
});
