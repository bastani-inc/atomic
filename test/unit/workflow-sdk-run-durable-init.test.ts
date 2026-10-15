import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	getAvailableDurableBackend,
	getDurableBackend,
	setDurableBackend,
} from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { StorageUnavailableError } from "../../packages/workflows/src/durable/journal/types.js";
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
	const backend = getAvailableDurableBackend();
	if (backend instanceof JournalDurableBackend) await backend.close();
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

test("standalone SDK initializes and retains the process journal across runs", async () => {
	assert.equal((await run(definition, {}, { runId: "first", store: createStore() })).status, "completed");
	const backend = getDurableBackend();
	assert.ok(backend instanceof JournalDurableBackend);
	assert.equal((await run(definition, {}, { runId: "second", store: createStore() })).status, "completed");
	assert.equal(getDurableBackend(), backend);
	assert.ok(backend.getWorkflow("first"));
	assert.ok(backend.getWorkflow("second"));
	await backend.close();
	setDurableBackend(undefined);
	const reopened = await JournalDurableBackend.open(process.env.ATOMIC_WORKFLOW_JOURNAL_PATH);
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
		assert.equal(error.path, directory);
		assert.ok(error.cause instanceof Error);
		return true;
	});
	assert.equal(getAvailableDurableBackend(), undefined);
});

test("explicit memory SDK runs do not initialize a persistent journal", async () => {
	process.env.ATOMIC_WORKFLOW_JOURNAL_PATH = directory;
	assert.equal(
		(await run(definition, {}, { store: createStore(), durability: { mode: "memory" } })).status,
		"completed",
	);
	assert.equal(getAvailableDurableBackend(), undefined);
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
		const backend = getDurableBackend();
		assert.ok(backend instanceof JournalDurableBackend);
		backend.registerWorkflow({
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
		const contender = await JournalDurableBackend.open(process.env.ATOMIC_WORKFLOW_JOURNAL_PATH);
		try {
			assert.equal(contender.workflowOwnership("settled"), "available");
			assert.equal(
				await contender.transitionWorkflowStatus(
					"settled",
					[result.status === "killed" ? "cancelled" : result.status],
					"paused",
				),
				true,
			);
			assert.equal(contender.workflowOwnership("settled"), "local");
			assert.equal(backend.workflowOwnership("unrelated"), "local");
			assert.equal(getDurableBackend(), backend);
		} finally {
			await contender.close();
		}
	});
}
