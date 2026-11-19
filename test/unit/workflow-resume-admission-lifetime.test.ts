import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { releaseDurableBackendsHeldBy } from "../../packages/workflows/src/durable/backend-process-owner.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { type ResumeAdmissionMark, withResumeAdmissionMark } from "../../packages/workflows/src/durable/run-claims.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createDurableResumeRuntime } from "../../packages/workflows/src/extension/runtime-durable-resume.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
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

test("a runtime reusing an older journal backend acknowledges the retry it started (#5534)", async () => {
	const directory = makeTempDirectory("resume-reload-");
	const store = createStore();
	const jobs = createJobTracker();
	let attempts = 0;
	const retry = workflow({
		name: "reload-retry",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("retry", {}, async () => {
				if (++attempts === 1) throw new Error("first attempt failed");
				return true;
			});
			return {};
		},
	});
	const options = { definitions: [retry], store, jobs, journal: { path: join(directory, "journal.sqlite") } };
	try {
		const first = createExtensionRuntime(options);
		const started = await first.dispatch({ action: "run", workflow: retry.name, inputs: {} });
		assert.ok("runId" in started && typeof started.runId === "string");
		const id = started.runId;
		await jobs.get(id)?.promise;
		const backend = first.durableBackend();
		assert.equal(backend.getWorkflow(id)?.status, "failed");
		// The process cache can outlive the bundle that opened this SQLite journal.
		Object.defineProperty(backend, "resumeObservationKey", { value: undefined });
		const second = createExtensionRuntime(options);
		await second.prepareDurableCatalog!();
		assert.equal(second.durableBackend(), backend);
		try {
			const reply = await second.resumeDurableWorkflow!(id);
			assert.ok(reply.ok, reply.message);
		} finally {
			await jobs.get(id)?.promise;
		}
		assert.equal(backend.getWorkflow(id)?.status, "completed");
		assert.equal(attempts, 2);
	} finally {
		await releaseDurableBackendsHeldBy(store);
		removeTempDirectory(directory);
	}
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

const sharedId = "55340000-0000-4000-8000-ffffffffffff";

/** Each pause holds the acknowledgement of one completed, file-backed lookup. */
async function pausedLookups(target: string) {
	const journal = await JournalTestBackend.create();
	await register(journal, sharedId);
	configureCurrentTestStoreBackend(journal);
	const runtime = createExtensionRuntime({ definitions: [definition] });
	const execute = makeExecuteWorkflowTool(runtime, () => undefined);
	let next: { reading: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
	async function pause<T>(read: Promise<T>): Promise<T> {
		const hold = next;
		next = undefined;
		const result = await read;
		hold?.reading.resolve();
		await hold?.release.promise;
		return result;
	}
	const exact = runtime.prepareDurableResumableForIds!.bind(runtime);
	const prefix = runtime.prepareDurableCatalog!.bind(runtime);
	runtime.prepareDurableResumableForIds = (...args) => pause(exact(...args));
	runtime.prepareDurableCatalog = (...args) => pause(prefix(...args));
	const pending = new Set<() => Promise<void>>();
	return {
		async enter() {
			const hold = { reading: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
			next = hold;
			const controller = new AbortController();
			const call = execute(
				{ action: "resume", runId: target },
				{ sessionId: "admission", hasUI: false },
				controller.signal,
			);
			await hold.reading.promise;
			const cancel = async () => {
				controller.abort(new Error("cancelled resume"));
				try {
					await assert.rejects(call, /cancelled resume/);
				} finally {
					hold.release.resolve();
					pending.delete(cancel);
				}
			};
			pending.add(cancel);
			return cancel;
		},
		async close() {
			await Promise.all([...pending].map((cancel) => cancel()));
			configureCurrentTestStoreBackend(undefined);
		},
	};
}

async function finish(journal: JournalTestBackend, id: string) {
	await register(journal, id);
	const jobs = createJobTracker();
	const result = await resumeDurableWorkflow(id, {
		registry: createRegistry([definition]),
		durableBackend: journal,
		baseRunOpts: { store: createStore() },
		jobs,
	});
	assert.ok(result.ok, result.message);
	await jobs.get(id)?.promise;
	assert.equal(journal.getWorkflow(id)?.status, "completed");
}

test.each([sharedId, sharedId.slice(0, 8)])(
	"a lookup for %s still choosing its journal retains no journal entries for retired runs (#5534)",
	async (target) => {
		const selected = await JournalTestBackend.create();
		const store = createStore();
		const choosing = Promise.withResolvers<void>();
		const ready = Promise.withResolvers<void>();
		const runtime = createDurableResumeRuntime({
			registry: createRegistry([definition]),
			store,
			jobs: createJobTracker(),
			runtimeCwd: process.cwd(),
			baseRunOpts: () => ({ store }),
			ensureReady: async () => {
				choosing.resolve();
				await ready.promise;
				return selected;
			},
		});
		const controller = new AbortController();
		const pending = runtime.resumeDurableWorkflow(target, { signal: controller.signal });
		try {
			await Promise.race([choosing.promise, pending.then(() => assert.fail("lookup did not wait for its journal"))]);
			const matched = await JournalTestBackend.create();
			const control = await JournalTestBackend.create();
			const otherId = sharedId.replace("55340000", "deadbeef");
			await finish(matched, sharedId);
			await matched.deleteWorkflow(sharedId);
			await finish(control, otherId);
			await control.deleteWorkflow(otherId);
			assert.equal(matched.getWorkflow(sharedId), undefined);
			assert.equal(control.getWorkflow(otherId), undefined);

			// Inspect only tables used by the next real start, keeping neither a table nor a row alive.
			// A journal-wide cache common to both retired runs is not a lookup receipt.
			const probe = await JournalTestBackend.create();
			const set = WeakMap.prototype.set;
			let extra = 0;
			try {
				WeakMap.prototype.set = function (key, value) {
					if (key === probe && this.has(matched) && !this.has(control)) extra++;
					return set.call(this, key, value);
				};
				await finish(probe, target === sharedId ? sharedId : `${target}-0000-4000-8000-000000000001`);
			} finally {
				WeakMap.prototype.set = set;
			}
			assert.equal(extra, 0);
		} finally {
			controller.abort(new Error("cancelled resume"));
			ready.resolve();
			await assert.rejects(pending, /cancelled resume/);
		}
	},
);

test("an overlapping resume retains no stamps for runs removed from other open journals (#5534)", async () => {
	const held = await pausedLookups(sharedId);
	const retired: JournalTestBackend[] = [];
	let cancel = await held.enter();
	try {
		for (let i = 0; i < 64; i++) {
			const next = await held.enter();
			const journal = await JournalTestBackend.create();
			await finish(journal, sharedId);
			await journal.deleteWorkflow(sharedId);
			assert.equal(journal.getWorkflow(sharedId), undefined);
			retired.push(journal);
			await cancel();
			cancel = next;
		}
		// Check the table the next start actually uses, not an old table kept alive by the test.
		const probe = await JournalTestBackend.create();
		const set = WeakMap.prototype.set;
		let retained = 0;
		try {
			WeakMap.prototype.set = function (key, value) {
				if (key === probe && typeof value === "bigint")
					retained += retired.slice(0, -1).filter((db) => this.has(db)).length;
				return set.call(this, key, value);
			};
			await finish(probe, sharedId);
		} finally {
			WeakMap.prototype.set = set;
		}
		assert.equal(retained, 0);
	} finally {
		await held.close();
	}
}, 120_000);

test("cancelling one short-id lookup visits no other run before abort returns (#5534)", async () => {
	const prefix = sharedId.slice(0, 8);
	const held = await pausedLookups(prefix);
	const journal = await JournalTestBackend.create();
	const ids = new Set<string>();
	try {
		const cancel = await held.enter();
		for (let i = 0; i < 64; i++) {
			const id = `${prefix}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
			ids.add(id);
			await finish(journal, id);
		}
		await held.enter();
		const iterate = Map.prototype[Symbol.iterator];
		let visits = 0;
		let cancelled: Promise<void>;
		try {
			Map.prototype[Symbol.iterator] = function () {
				const entries = iterate.call(this);
				const next = entries.next.bind(entries);
				entries.next = () => {
					const entry = next();
					if (!entry.done && ids.has(entry.value[0])) visits++;
					return entry;
				};
				return entries;
			};
			cancelled = cancel();
		} finally {
			Map.prototype[Symbol.iterator] = iterate;
		}
		await cancelled;
		assert.equal(visits, 0);
	} finally {
		await held.close();
	}
}, 120_000);

test("an exact start reaches one of 64 cold lookups; completion and cancellation do not walk the others (#5534)", async () => {
	const journal = await JournalTestBackend.create();
	const ids = Array.from({ length: 64 }, (_, n) => `55340000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`);
	const id = ids[0]!;
	const running = Promise.withResolvers<void>();
	const finishRun = Promise.withResolvers<void>();
	const returnReads = Promise.withResolvers<void>();
	const marks: ResumeAdmissionMark[] = [];
	const controllers = ids.map(() => new AbortController());
	const buckets: Set<unknown>[] = [];
	const retained: (() => boolean)[] = [];
	let visits = 0;
	const pending = ids.map((target, i) => {
		const add = Set.prototype.add;
		try {
			Set.prototype.add = function (observer) {
				if (typeof observer === "function" || typeof observer === "bigint") {
					buckets.push(this);
					retained.push(() => this.has(observer));
				}
				return add.call(this, observer);
			};
			return withResumeAdmissionMark(
				target,
				undefined,
				async (mark) => {
					marks.push(mark);
					await returnReads.promise;
				},
				controllers[i]!.signal,
			);
		} finally {
			Set.prototype.add = add;
		}
	});
	try {
		assert.equal(retained.filter((f) => f()).length, 64);
		for (const bucket of new Set(buckets)) {
			const iterate = bucket[Symbol.iterator].bind(bucket);
			Object.defineProperty(bucket, Symbol.iterator, {
				configurable: true,
				value: function* () {
					for (const observer of iterate()) {
						visits++;
						yield observer;
					}
				},
			});
		}
		await register(journal, id);
		const jobs = createJobTracker();
		const held = workflow({
			name: definition.name,
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.tool("hold", {}, async () => {
					running.resolve();
					await finishRun.promise;
					return true;
				});
				return {};
			},
		});
		const accepted = await resumeDurableWorkflow(id, {
			registry: createRegistry([held]),
			durableBackend: journal,
			baseRunOpts: { store: createStore() },
			jobs,
		});
		assert.ok(accepted.ok, accepted.message);
		await running.promise;
		assert.equal(visits, 1);
		assert.deepEqual(
			marks.map((mark) => mark(journal, id)),
			ids.map((target) => target === id),
		);
		finishRun.resolve();
		await jobs.get(id)?.promise;
		assert.equal(journal.getWorkflow(id)?.status, "completed");
		assert.ok(
			marks.every((mark) => !mark(journal, id)),
			"a completed run owns no start receipts",
		);
		assert.equal(visits, 1, "completion did not walk any lookup");
		for (const controller of controllers) controller.abort();
		assert.equal(retained.filter((f) => f()).length, 0);
		assert.equal(visits, 1);
	} finally {
		for (const bucket of buckets) Reflect.deleteProperty(bucket, Symbol.iterator);
		for (const controller of controllers) controller.abort();
		finishRun.resolve();
		returnReads.resolve();
		await Promise.all(pending);
	}
});

test("a prefix lookup that resolves during another request's start admits just one replacement (#5534)", async () => {
	const journal = await JournalTestBackend.create();
	await register(journal, sharedId);
	configureCurrentTestStoreBackend(journal);
	let attempts = 0;
	const retry = workflow({
		name: definition.name,
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("retry", {}, async () => {
				if (++attempts === 1) throw new Error("failed again");
				return true;
			});
			return {};
		},
	});
	const runtime = createExtensionRuntime({ definitions: [retry] });
	const execute = makeExecuteWorkflowTool(runtime, () => undefined);
	const lookup = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const catalog = runtime.prepareDurableCatalog!.bind(runtime);
	runtime.prepareDurableCatalog = async (...args) => {
		const result = await catalog(...args);
		lookup.resolve();
		await release.promise;
		return result;
	};
	const slow = execute({ action: "resume", runId: sharedId.slice(0, 8) }, { sessionId: "admission", hasUI: false });
	try {
		await lookup.promise;
		const jobs = createJobTracker();
		const started = await resumeDurableWorkflow(sharedId, {
			registry: createRegistry([retry]),
			durableBackend: journal,
			baseRunOpts: { store: createStore() },
			jobs,
		});
		assert.ok(started.ok, started.message);
		await jobs.get(sharedId)?.promise;
		assert.equal(journal.getWorkflow(sharedId)?.status, "failed");
		release.resolve();
		const result = await slow;
		assert.match("message" in result ? (result.message ?? "") : "", /already resumed/);
		assert.equal(attempts, 1);
	} finally {
		release.resolve();
		await slow;
		configureCurrentTestStoreBackend(undefined);
	}
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
