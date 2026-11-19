import assert from "node:assert/strict";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { configureCurrentTestStoreBackend } from "../helpers/store-backend.js";

const definition = workflow({
	name: "retry",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("check", {}, async () => true);
		return {};
	},
});

async function register(journal: JournalTestBackend, workflowId: string): Promise<void> {
	await journal.commitWorkflowRegistration({
		workflowId,
		name: definition.name,
		inputs: {},
		createdAt: 1,
		status: "failed",
		resumable: true,
		completedCheckpoints: 0,
	});
}

/** Hold the acknowledgement of each real journal read, independently of the caller's lifetime. */
async function withHeldResumes(
	check: (held: { cancel(): Promise<void>; retained(): number; visits(): number }) => Promise<void>,
) {
	const journal = await JournalTestBackend.create();
	const ids = Array.from({ length: 64 }, (_, n) => `55340000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`);
	for (const id of ids) await register(journal, id);
	const release = Promise.withResolvers<void>();
	const allReading = Promise.withResolvers<void>();
	const allReleased = Promise.withResolvers<void>();
	let reading = 0;
	let released = 0;
	const hydrate = journal.hydrateWorkflow.bind(journal);
	journal.hydrateWorkflow = async (id) => {
		await hydrate(id);
		if (++reading === ids.length) allReading.resolve();
		await release.promise;
		if (++released === ids.length) allReleased.resolve();
	};
	configureCurrentTestStoreBackend(journal);
	const execute = makeExecuteWorkflowTool(createExtensionRuntime({ definitions: [definition] }), () => undefined);
	const controllers = ids.map(() => new AbortController());
	const retained: (() => boolean)[] = [];
	const listeners = new Set<unknown>();
	const collections = new Set<Set<unknown>>();
	let visits = 0;
	const calls = ids.map((runId, i) => {
		// Capture the registrations made on entry, before the first read, without depending on GC or a timer.
		const add = Set.prototype.add;
		try {
			Set.prototype.add = function (listener) {
				if (typeof listener === "function" || typeof listener === "bigint") {
					retained.push(() => this.has(listener));
					add.call(listeners, listener);
					add.call(collections, this);
				}
				return add.call(this, listener);
			};
			return execute({ action: "resume", runId }, { sessionId: "admission", hasUI: false }, controllers[i]!.signal);
		} finally {
			Set.prototype.add = add;
		}
	});
	const cancel = async () => {
		for (const controller of controllers) controller.abort(new Error("cancelled resume"));
		for (const result of await Promise.allSettled(calls)) {
			assert.equal(result.status, "rejected");
			assert.match(String(result.reason), /cancelled resume/);
		}
	};
	try {
		await allReading.promise;
		// Count visits to these callers, not the healthy request's own registration or its journal work.
		for (const collection of collections) {
			const iterate = collection[Symbol.iterator].bind(collection);
			Object.defineProperty(collection, Symbol.iterator, {
				configurable: true,
				value: function* () {
					for (const item of iterate()) {
						if (listeners.has(item)) visits++;
						yield item;
					}
				},
			});
		}
		await check({
			cancel,
			retained: () => retained.filter((registered) => registered()).length,
			visits: () => visits,
		});
	} finally {
		for (const collection of collections) Reflect.deleteProperty(collection, Symbol.iterator);
		await cancel();
		release.resolve();
		await allReleased.promise;
		configureCurrentTestStoreBackend(undefined);
	}
}

test("cancelled resume callers release their admission listeners before held journal reads return (#5534)", async () => {
	await withHeldResumes(async ({ cancel, retained }) => {
		assert.equal(retained(), 64);
		await cancel();
		assert.equal(retained(), 0);
	});
});

test("starting a different workflow does not visit unrelated resume callers (#5534)", async () => {
	const journal = await JournalTestBackend.create();
	const id = "55340000-0000-4000-8000-ffffffffffff";
	await register(journal, id);
	const jobs = createJobTracker();
	await withHeldResumes(async ({ visits }) => {
		const result = await resumeDurableWorkflow(id, {
			registry: createRegistry([definition]),
			durableBackend: journal,
			baseRunOpts: { store: createStore() },
			jobs,
		});
		assert.ok(result.ok, result.message);
		await jobs.get(id)?.promise;
		assert.equal(journal.getWorkflow(id)?.status, "completed");
		assert.equal(visits(), 0);
	});
});
