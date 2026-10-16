import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "vitest";
import { registerRunJournalConformance } from "../../packages/workflows/src/durable/journal/conformance.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import { run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

const ForeignPromise = runInNewContext("Promise") as PromiseConstructor;

function crossRealmJournal(memory: MemoryRunJournal): RunJournal {
	return {
		createRun: (header) => ForeignPromise.resolve(memory.createRun(header)),
		listRuns: (filter) => ForeignPromise.resolve(memory.listRuns(filter)),
		acquire: (runId, holderId) => ForeignPromise.resolve(memory.acquire(runId, holderId)),
		takeover: (runId, holderId, expectedHolder) =>
			ForeignPromise.resolve(memory.takeover(runId, holderId, expectedHolder)),
		renew: (lease) => ForeignPromise.resolve(memory.renew(lease)),
		release: (lease) => ForeignPromise.resolve(memory.release(lease)),
		append: (lease, event, options) => ForeignPromise.resolve(memory.append(lease, event, options)),
		read: (runId, fromSeq) => memory.read(runId, fromSeq),
		readKey: (runId, key) => ForeignPromise.resolve(memory.readKey(runId, key)),
		deleteOwnedRun: (lease) => ForeignPromise.resolve(memory.deleteOwnedRun(lease)),
		deleteRun: (runId) => ForeignPromise.resolve(memory.deleteRun(runId)),
		close: () => ForeignPromise.resolve(memory.close()),
	};
}

registerRunJournalConformance(test, "cross-realm Promise journal", () => crossRealmJournal(new MemoryRunJournal()));

test("cross-realm journal registration persists before success and replays completed work", async () => {
	const memory = new MemoryRunJournal();
	const journal = crossRealmJournal(memory);
	const listed = journal.listRuns();
	assert.ok(listed instanceof ForeignPromise);
	assert.equal(listed instanceof Promise, false);
	await listed;
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	let toolCalls = 0;
	let stageCalls = 0;
	const definition = workflow({
		name: "cross-realm-journal",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("effect", {}, async () => {
				toolCalls++;
				return "saved";
			});
			assert.equal(await ctx.stage("finish").prompt("finish"), "finished");
			return {};
		},
	});
	try {
		await backend.registerWorkflow({
			workflowId: "registration",
			name: "registered",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		const entries = [];
		for await (const entry of journal.read("registration")) entries.push(entry);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].event.type, "RunStarted");
		assert.equal(backend.getWorkflow("registration")?.status, "running");
		const options = {
			runId: "cross-realm-replay",
			durableBackend: backend,
			adapters: {
				prompt: {
					prompt: async () => {
						stageCalls++;
						return "finished";
					},
				},
			},
		};
		assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
		assert.ok(backend.listCheckpoints(options.runId).some((entry) => entry.kind === "tool"));
		assert.ok(backend.listCheckpoints(options.runId).some((entry) => entry.kind === "stage"));
		assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
		assert.equal(toolCalls, 1);
		assert.equal(stageCalls, 1);
	} finally {
		await backend.close();
		await memory.close();
	}
});
