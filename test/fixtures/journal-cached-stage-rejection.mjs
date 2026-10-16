import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createStore, MemoryRunJournal, run, StorageUnavailableError, workflow } from "@bastani/atomic/workflows";

const operation = process.argv[2];
assert.ok(["prompt", "complete", "unused", "exit"].includes(operation));
const memory = new MemoryRunJournal();
let rejectMetadata = false;
let stageCallbacks = 0;
let metadataWrites = 0;
let observedFailure;
const cause = new Error("metadata unavailable");
const failure = new StorageUnavailableError("cached-stage-journal", cause);
const journal = Object.fromEntries(
	[
		"createRun",
		"listRuns",
		"acquire",
		"takeover",
		"renew",
		"release",
		"readKey",
		"deleteOwnedRun",
		"deleteRun",
		"close",
	].map((name) => [name, memory[name].bind(memory)]),
);
journal.read = memory.read.bind(memory);
journal.append = async (lease, event, options) => {
	if (
		rejectMetadata &&
		event.type === "CheckpointRecorded" &&
		event.payload.checkpointId?.startsWith("stage-replay-meta:")
	) {
		metadataWrites++;
		throw failure;
	}
	return await memory.append(lease, event, options);
};
const definition = workflow({
	name: "cached-stage-rejection",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		const stage = ctx.stage("cached");
		await setImmediate();
		await setImmediate();
		if (rejectMetadata && operation === "unused") return {};
		if (rejectMetadata && operation === "exit") return ctx.exit({});
		try {
			const method = rejectMetadata && operation === "complete" ? "complete" : "prompt";
			assert.equal(await stage[method]("later"), "saved");
		} catch (error) {
			observedFailure = error;
			throw error;
		}
		return {};
	},
});
const options = {
	journal,
	runId: `cached-stage-${operation}`,
	adapters: {
		prompt: {
			prompt: async () => {
				stageCallbacks++;
				return "saved";
			},
		},
	},
};
try {
	assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
	const unhandled = [];
	const onUnhandled = (error) => unhandled.push(error);
	process.on("unhandledRejection", onUnhandled);
	rejectMetadata = true;
	const result = await run(definition, {}, { ...options, store: createStore() });
	await setImmediate();
	assert.equal(result.status, "failed");
	assert.equal(result.error, failure.message);
	assert.equal(unhandled.length, 0);
	assert.equal(stageCallbacks, 1);
	assert.equal(metadataWrites, 1);
	if (operation === "prompt" || operation === "complete") assert.equal(observedFailure, failure);
	assert.equal(failure.cause, cause);
	process.off("unhandledRejection", onUnhandled);
	console.log(JSON.stringify({ operation, status: result.status, unhandled: 0, stageCallbacks, metadataWrites }));
} finally {
	await memory.close();
}
