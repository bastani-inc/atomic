import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { StorageUnavailableError } from "../../packages/workflows/src/durable/journal/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

test("resume retries journal persistence after a failed pause (#3647)", async () => {
	const directory = makeTempDirectory("journal-control-");
	const path = join(directory, "journal.sqlite");
	const journal = await openSqlRunJournal(path);
	let failure: StorageUnavailableError | undefined;
	const append = journal.append.bind(journal);
	journal.append = async (...args) => {
		if (failure) {
			const rejected = failure;
			failure = undefined;
			throw rejected;
		}
		return append(...args);
	};
	const backend = await JournalDurableBackend.open(journal);
	const controls = createToolControlRegistry();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const store = createStore();
	const definition = workflow({
		name: "journal-control-recovery",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("first", {}, async () => {
				started.resolve();
				await release.promise;
				return "saved";
			});
			await ctx.tool("second", {}, async () => "resumed");
			return {};
		},
	});
	const running = run(definition, {}, { runId: "run", store, durableBackend: backend, toolControlRegistry: controls });
	try {
		await started.promise;
		const control = controls.runControl("run");
		assert.ok(control);
		const rejected = new StorageUnavailableError(
			{ adapter: "node-sqlite", location: path },
			new Error("injected write failure"),
		);
		failure = rejected;
		await assert.rejects(control.pause(), (error: Error) => error === rejected);
		assert.equal(control.paused, true);
		await control.resume();
		assert.equal(backend.getWorkflow("run")?.status, "running");
		assert.equal(control.paused, false);
		release.resolve();
		assert.equal((await running).status, "completed");
	} finally {
		release.resolve();
		await controls.runControl("run")?.quit();
		await running;
		await backend.close();
		removeTempDirectory(directory);
	}
});
