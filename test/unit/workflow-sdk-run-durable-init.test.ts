import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { getDurableBackendProcessOwner } from "../../packages/workflows/src/durable/backend-process-owner.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { StorageUnavailableError } from "../../packages/workflows/src/durable/journal/types.js";
import { requireStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

let directory: string;
const previousPath = process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
beforeEach(() => {
	directory = makeTempDirectory("sdk-journal-");
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = join(directory, "journal.sqlite");
	setDurableBackend(undefined);
});
afterEach(async () => {
	for (const entry of getDurableBackendProcessOwner().selectedBackends?.values() ?? []) {
		await entry.ready.catch(() => undefined);
		await entry.close?.();
	}
	setDurableBackend(undefined);
	if (previousPath === undefined) delete process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
	else process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = previousPath;
	removeTempDirectory(directory);
});

const definition = workflow({
	name: "sdk-journal-initialization",
	description: "SDK initialization regression",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("effect", {}, async () => "saved");
		return {};
	},
});

test("standalone SDK shares the selected journal across independent stores", async () => {
	const firstStore = createStore();
	const secondStore = createStore();
	assert.equal((await run(definition, {}, { runId: "first", store: firstStore })).status, "completed");
	const backend = requireStoreDurableBackend(firstStore);
	assert.ok(backend instanceof JournalDurableBackend);
	assert.equal((await run(definition, {}, { runId: "second", store: secondStore })).status, "completed");
	assert.equal(requireStoreDurableBackend(secondStore), backend);
	assert.ok(backend.getWorkflow("first"));
	assert.ok(backend.getWorkflow("second"));
	await backend.close();
	setDurableBackend(undefined);
	const reopened = await JournalDurableBackend.open(await openSqlRunJournal(process.env.ATOMIC_WORKFLOW_JOURNAL_PATH));
	try {
		assert.equal(reopened.getWorkflow("first")?.status, "completed");
		assert.equal(reopened.getWorkflow("second")?.status, "completed");
	} finally {
		await reopened.close();
	}
});

test("standalone SDK surfaces the configured journal open failure", async () => {
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = directory;
	await assert.rejects(run(definition, {}, { store: createStore() }), (error: Error) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error.location, directory);
		assert.ok(error.cause instanceof Error);
		return true;
	});
	assert.equal(getDurableBackendProcessOwner().selectedBackends?.size, 0);
});

test("explicit memory SDK runs do not initialize a persistent journal", async () => {
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = directory;
	const store = createStore();
	const result = await run(definition, {}, { store, journal: { memory: true } });
	assert.equal(result.status, "completed");
	assert.equal(requireStoreDurableBackend(store, result.runId).persistent, false);
});

for (const outcome of ["success", "failure", "stop", "quit"] as const) {
	test(`standalone SDK releases only its settled ${outcome} run lease (#3647)`, async () => {
		const controls = createToolControlRegistry();
		const controller = new AbortController();
		const store = createStore();
		const started = Promise.withResolvers<void>();
		const settledDefinition = workflow({
			name: "sdk-lease-release",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.tool("effect", {}, async ({ signal }) => {
					started.resolve();
					if (outcome === "failure") throw new Error("expected failure");
					if (outcome === "stop" || outcome === "quit") {
						await new Promise<void>((_resolve, reject) => {
							signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
						});
					}
					return "saved";
				});
				return {};
			},
		});
		const running = run(
			settledDefinition,
			{},
			{
				runId: "settled",
				store,
				signal: controller.signal,
				toolControlRegistry: controls,
			},
		);
		await started.promise;
		const backend = requireStoreDurableBackend(store);
		assert.ok(backend instanceof JournalDurableBackend);
		await backend.registerWorkflow({
			workflowId: "unrelated",
			name: "active",
			inputs: {},
			createdAt: 1,
			updatedAt: 1,
			status: "running",
		});
		if (outcome === "stop") controller.abort(new Error("stop requested"));
		if (outcome === "quit") {
			assert.equal((await quitRun("settled", { store, toolControlRegistry: controls })).ok, true);
		}
		const result = await running;
		assert.equal(
			result.status,
			outcome === "success" ? "completed" : outcome === "quit" ? "paused" : outcome === "stop" ? "killed" : "failed",
		);
		const contender = await JournalDurableBackend.open(
			await openSqlRunJournal(process.env.ATOMIC_WORKFLOW_JOURNAL_PATH),
		);
		try {
			assert.equal(await contender.workflowOwnership("settled"), "available");
			assert.equal(
				await contender.transitionWorkflowStatus(
					"settled",
					[result.status === "killed" ? "cancelled" : result.status],
					"paused",
				),
				true,
			);
			assert.equal(await contender.workflowOwnership("settled"), "local");
			assert.equal(await backend.workflowOwnership("unrelated"), "local");
			assert.equal(requireStoreDurableBackend(store), backend);
		} finally {
			await contender.close();
		}
	});
}
