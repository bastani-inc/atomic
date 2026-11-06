import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createStore, workflow } from "../../packages/workflows/src/index.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { isLocalWorkerOptionsError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const definition = workflow({
	name: "pooled-settings-root",
	description: "",
	inputs: {},
	outputs: {},
	async run() {
		return {};
	},
});

/** Host settings whose heartbeat is above half of their lease. */
const invalidSettings = {
	workflows: { localWorkers: { count: 1, definitions: [], leaseMs: 2_000, heartbeatMs: 5_000 } },
};

test("out-of-range local worker settings refuse runs and resumes, not the rest of the workflow tool (#4313)", async () => {
	const directory = makeTempDirectory("local-worker-settings-dispatch-");
	const journal = await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } });
	const store = createStore();
	const runtime = createExtensionRuntime({
		definitions: [definition],
		journal,
		store,
		jobs: createJobTracker(),
		cwd: directory,
		adapters: {},
		resolveJournalSettings: () => invalidSettings,
	});
	try {
		const listed = await runtime.dispatch({ action: "list" });
		assert.equal(listed.action, "list", JSON.stringify(listed));
		const inputs = await runtime.dispatch({ action: "inputs", workflow: definition.name });
		assert.equal(inputs.action, "inputs", JSON.stringify(inputs));
		let accepted = 0;
		const started = await runtime.dispatch(
			{ action: "run", workflow: definition.name },
			{
				onRunAccepted: () => {
					accepted++;
				},
			},
		);
		assert.equal(started.action, "run");
		if (started.action !== "run") assert.fail(JSON.stringify(started));
		assert.equal(started.status, "failed");
		assert.equal(started.runId, "", "no run id was given out");
		assert.match(started.error ?? "", /workflows\.localWorkers\.heartbeatMs is 5000, above the maximum 1000 ms/);
		assert.match(started.error ?? "", /\(invalid-heartbeat\)/);
		assert.equal(accepted, 0, "no run was accepted");
		assert.deepEqual(store.runs(), [], "no run reached the store");
		assert.deepEqual(await journal.listRuns(), [], "nothing was written for it");
		await assert.rejects(
			runtime.resumeDurableWorkflow("pooled-settings-root-run"),
			(error: unknown) =>
				isLocalWorkerOptionsError(error) &&
				error.source === "settings" &&
				error.code === "invalid-heartbeat" &&
				error.field === "workflows.localWorkers.heartbeatMs",
		);
	} finally {
		await journal.close();
		removeTempDirectory(directory);
	}
});

test("a host without local worker settings runs and resumes as before (#4313)", async () => {
	const directory = makeTempDirectory("local-worker-settings-absent-");
	const journal = await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } });
	const store = createStore();
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({
		definitions: [definition],
		journal,
		store,
		jobs,
		cwd: directory,
		adapters: {},
		resolveJournalSettings: () => ({ workflows: {} }),
	});
	try {
		const started = await runtime.dispatch({ action: "run", workflow: definition.name });
		if (started.action !== "run") assert.fail(JSON.stringify(started));
		assert.notEqual(started.status, "failed", started.error);
		assert.ok(started.runId);
		await jobs.get(started.runId)?.outcome;
		const resumed = await runtime.resumeDurableWorkflow("no-such-run");
		assert.equal(isLocalWorkerOptionsError(resumed), false);
	} finally {
		await journal.close();
		removeTempDirectory(directory);
	}
});
