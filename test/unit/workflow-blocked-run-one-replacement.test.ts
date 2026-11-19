import { describe } from "vitest";
import type { RuntimeDispatchOptions } from "../../packages/workflows/src/extension/runtime.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	createJobTracker,
	type JobEntry,
	type JobTracker,
} from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createMemoryTestBackend, type MemoryJournalBackend } from "../helpers/workflow-journal.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";

/**
 * Exactly one replacement per block (#5534): a block, or a failure, is resumed once, however many resume requests
 * reach it. A request that saw a block another request already resumed is told so and starts nothing.
 */

type Outcome = "blocked" | "failed";

/**
 * A root whose child's tool fails on its first `failing` attempts and succeeds after: on an undeliverable queued
 * instruction, a recoverable failure the engine blocks the run on, or on a plain error, which fails it.
 */
function failingTwice(outcome: Outcome) {
	const attempts = { count: 0 };
	/** The replacement's tool waits for this before it fails: the replacement runs until the test releases it. */
	const replacementRuns = Promise.withResolvers<void>();
	replacementRuns.resolve();
	const hold = { replacement: replacementRuns.promise };
	const child = workflow({
		name: "deliver-child",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("check", {}, async () => {
				attempts.count++;
				if (attempts.count === 2) await hold.replacement;
				if (attempts.count < 3)
					throw outcome === "blocked"
						? Object.assign(new Error("the queued instruction could not be delivered"), {
								code: "pending_stage_delivery_failed",
							})
						: new Error("the check failed");
				return "ok";
			});
			return {};
		},
	});
	const root = workflow({
		name: "deliver-root",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.workflow(child);
			return {};
		},
	});
	return { attempts, child, root, hold };
}

/** Registers a run started outside the runtime as the runtime's own job, as a detached launch does. */
function track(jobs: JobTracker, runId: string, attempt: Promise<RunResult>): void {
	const job: JobEntry = {
		runId,
		controller: new AbortController(),
		promise: attempt.then(
			() => {
				jobs.unregister(runId, job);
			},
			() => {
				jobs.unregister(runId, job);
			},
		),
	};
	jobs.register(job);
}

function turns(count: number): Promise<void> {
	let chain = Promise.resolve();
	for (let turn = 0; turn < count; turn++)
		chain = chain.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
	return chain;
}

/**
 * A journal whose first attempt's final status write is held (the write a slow store makes after the live run already
 * reads blocked or failed), and whose `hydrateWorkflow` calls after `holdHydrate` is set are held from the second on.
 */
function slowJournal(memory: MemoryJournalBackend, runId: string, outcome: Outcome) {
	const recordFirst = Promise.withResolvers<void>();
	const recording = Promise.withResolvers<void>();
	const releaseHydrate = Promise.withResolvers<void>();
	const hydrateHeld = Promise.withResolvers<void>();
	const state = { finalWrites: 0, hydrates: 0, holdHydrate: false };
	const backend = new Proxy(memory, {
		get(target, key) {
			const value = Reflect.get(target, key, target) as unknown;
			if (typeof value !== "function") return value;
			if (key === "commitWorkflowStatus")
				return async (...args: Parameters<MemoryJournalBackend["commitWorkflowStatus"]>) => {
					if (args[0] === runId && args[1] === outcome && ++state.finalWrites === 1) {
						recording.resolve();
						await recordFirst.promise;
					}
					return memory.commitWorkflowStatus(...args);
				};
			if (key === "hydrateWorkflow")
				return async (...args: Parameters<MemoryJournalBackend["hydrateWorkflow"]>) => {
					if (state.holdHydrate && args[0] === runId && ++state.hydrates === 2) {
						hydrateHeld.resolve();
						await releaseHydrate.promise;
					}
					return memory.hydrateWorkflow(...args);
				};
			return value.bind(target);
		},
	});
	return { backend, state, recordFirst, recording, releaseHydrate, hydrateHeld };
}

describe("two resumes of the same block start one replacement (#5534)", () => {
	for (const outcome of ["blocked", "failed"] as const) {
		test(`two requests waiting for one ${outcome} attempt's record admit one replacement, even when one reads the journal after the replacement ended`, async () => {
			const { attempts, child, root } = failingTwice(outcome);
			const memory = await createMemoryTestBackend();
			const runId =
				outcome === "blocked" ? "55340000-0000-4000-8000-00000000000b" : "55340000-0000-4000-8000-00000000000f";
			const journal = slowJournal(memory, runId, outcome);
			const store = createStore();
			const jobs = createJobTracker();
			track(jobs, runId, run(root, {}, { runId, store, durableBackend: journal.backend }));
			await journal.recording.promise;
			assert.equal(effectiveRunStatus(store.run(runId)!), outcome, "the graph already offers r");
			assert.equal(memory.getWorkflow(runId)?.status, "running", "the journal has not recorded it yet");

			const runtime = createExtensionRuntime({ registry: createRegistry([root, child]), jobs, store });
			const settled: string[] = [];
			const request = (name: string) =>
				runtime.resumeFailedRun(runId).then((result) => {
					settled.push(name);
					return result;
				});
			const first = request("first");
			const second = request("second");
			await turns(20);
			assert.deepEqual(settled, [], "both requests wait for the attempt to record its end");

			// One request reads the journal at once; the other's read is held until the replacement it would race has ended.
			journal.state.holdHydrate = true;
			journal.recordFirst.resolve();
			await journal.hydrateHeld.promise;
			const admitted = await Promise.race([first, second]);
			assert.ok(admitted.ok, admitted.message);
			await jobs.get(runId)?.promise;
			assert.equal(attempts.count, 2, "the one replacement ran");
			assert.equal(effectiveRunStatus(store.run(runId)!), outcome, `the replacement ${outcome} again`);
			journal.releaseHydrate.resolve();

			const results = await Promise.all([first, second]);
			await jobs.get(runId)?.promise;
			assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
			const refused = results.find((result) => !result.ok);
			assert.match(refused?.message ?? "", /already resumed/);
			assert.equal(attempts.count, 2, "the late request started no third attempt");
			assert.equal(
				effectiveRunStatus(store.run(runId)!),
				outcome,
				"the replacement's block stays for its own resume",
			);
		});
	}

	test("a request made while another request's replacement starts is answered at once, without waiting for that replacement or resuming it", async () => {
		const { attempts, child, root, hold } = failingTwice("blocked");
		const backend = await createMemoryTestBackend();
		const store = createStore();
		const jobs = createJobTracker();
		const blocked = await run(root, {}, { store, durableBackend: backend });
		const runId = blocked.runId;
		assert.equal(effectiveRunStatus(store.run(runId)!), "blocked");
		const runtime = createExtensionRuntime({ registry: createRegistry([root, child]), jobs, store });
		// The replacement runs until the second request was answered.
		const replacementRuns = Promise.withResolvers<void>();
		hold.replacement = replacementRuns.promise;

		// The second request is made, from the caller's side, as soon as the first one's replacement is accepted: the
		// replacement is the run's job then, and the run still reads as the block it replaces.
		const accepted = Promise.withResolvers<void>();
		const seen: string[] = [];
		const second = accepted.promise.then(() => runtime.resumeFailedRun(runId));
		const options: RuntimeDispatchOptions = {
			onRunAccepted() {
				seen.push(`${jobs.has(runId)} ${effectiveRunStatus(store.run(runId)!)}`);
				accepted.resolve();
			},
		};
		const first = await runtime.resumeFailedRun(runId, undefined, options);
		assert.ok(first.ok, first.message);
		assert.deepEqual(seen, ["true blocked"]);
		const late = await second;
		assert.equal(late.ok, false, "the block is being resumed already");
		assert.match(late.message, /pending resume admission/, "its resume is admitted, not over yet");
		assert.ok(jobs.has(runId), "answered while the replacement still runs");
		replacementRuns.resolve();
		await jobs.get(runId)?.promise;
		assert.equal(attempts.count, 2, "one replacement ran");
		assert.equal(
			effectiveRunStatus(store.run(runId)!),
			"blocked",
			"the replacement's block waits for its own resume",
		);
	});

	/** A run blocked with its journal recorded, and a runtime whose journal reads of it can be held, one at a time. */
	async function recordedBlock(id?: string) {
		const { attempts, child, root } = failingTwice("blocked");
		const memory = await createMemoryTestBackend();
		const store = createStore();
		const jobs = createJobTracker();
		const blocked = await run(
			root,
			{},
			{ store, durableBackend: memory, ...(id === undefined ? {} : { runId: id }) },
		);
		const runId = blocked.runId;
		assert.equal(memory.getWorkflow(runId)?.status, "blocked");
		const held: { reading: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }[] = [];
		const hydrate = memory.hydrateWorkflow.bind(memory);
		memory.hydrateWorkflow = async (id: string) => {
			const hold = held.shift();
			if (hold !== undefined) {
				hold.reading.resolve();
				await hold.release.promise;
			}
			return hydrate(id);
		};
		const holdNextRead = () => {
			const hold = { reading: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
			held.push(hold);
			return hold;
		};
		const runtime = createExtensionRuntime({ registry: createRegistry([root, child]), jobs, store });
		return { attempts, store, jobs, runId, runtime, holdNextRead };
	}

	test("the graph's resume of a block, its journal read held until another resume's replacement blocked again, resumes nothing", async () => {
		const { attempts, store, jobs, runId, runtime, holdNextRead } = await recordedBlock();
		const read = holdNextRead();
		const delayed = runtime.resumeDurableWorkflow(runId, { actor: "user" });
		await read.reading.promise;
		const first = await runtime.resumeDurableWorkflow(runId, { actor: "user" });
		assert.ok(first.ok, first.message);
		await jobs.get(runId)?.promise;
		assert.equal(attempts.count, 2);
		assert.equal(effectiveRunStatus(store.run(runId)!), "blocked", "the replacement blocked again");
		read.release.resolve();

		const late = await delayed;
		await jobs.get(runId)?.promise;
		assert.equal(late.ok, false, JSON.stringify(late));
		assert.match(late.message, /already resumed/);
		assert.equal(attempts.count, 2, "no third attempt");
	});

	test("a request made while another request's replacement starts, whose own reads end after that replacement blocked again, resumes nothing", async () => {
		const { attempts, store, jobs, runId, runtime, holdNextRead } = await recordedBlock();
		const accepted = Promise.withResolvers<{ hold: ReturnType<typeof holdNextRead> }>();
		// From the caller's side, as soon as the first request's replacement is accepted: the run still reads as its
		// block, and the second request's own journal read is held.
		const second = accepted.promise.then(() => runtime.resumeDurableWorkflow(runId, { actor: "user" }));
		const first = await runtime.resumeFailedRun(runId, undefined, {
			onRunAccepted() {
				assert.equal(effectiveRunStatus(store.run(runId)!), "blocked");
				accepted.resolve({ hold: holdNextRead() });
			},
		});
		assert.ok(first.ok, first.message);
		const { hold } = await accepted.promise;
		await hold.reading.promise;
		await jobs.get(runId)?.promise;
		assert.equal(attempts.count, 2);
		assert.equal(effectiveRunStatus(store.run(runId)!), "blocked", "the replacement blocked again");
		hold.release.resolve();

		const late = await second;
		await jobs.get(runId)?.promise;
		assert.equal(late.ok, false, JSON.stringify(late));
		assert.match(late.message, /already resumed/);
		assert.equal(attempts.count, 2, "no third attempt");
	});

	test("a run that blocks again after its resume is resumed again by a request made after that block", async () => {
		const { attempts, store, jobs, runId, runtime } = await recordedBlock();
		const first = await runtime.resumeFailedRun(runId);
		assert.ok(first.ok, first.message);
		await jobs.get(runId)?.promise;
		assert.equal(attempts.count, 2);
		assert.equal(effectiveRunStatus(store.run(runId)!), "blocked", "the replacement blocked again");

		const second = await runtime.resumeDurableWorkflow(runId, { actor: "user" });
		assert.ok(second.ok, second.ok ? undefined : second.message);
		await jobs.get(runId)?.promise;
		assert.equal(attempts.count, 3, "the new block was resumed");
		assert.equal(effectiveRunStatus(store.run(runId)!), "completed");
	});

	test("a resume that started nothing leaves the block to a request that saw it", async () => {
		const { attempts, store, jobs, runId, runtime, holdNextRead } = await recordedBlock();
		const read = holdNextRead();
		const delayed = runtime.resumeDurableWorkflow(runId, { actor: "user" });
		await read.reading.promise;
		const refused = await runtime
			.resumeDurableWorkflow(runId, {
				actor: "user",
				onBeforeResume: async () => {
					throw new Error("the session refused the resume");
				},
			})
			.catch((error: unknown) => error);
		assert.match(String(refused), /the session refused the resume/);
		assert.equal(attempts.count, 1, "nothing started");
		read.release.resolve();

		const resumed = await delayed;
		assert.ok(resumed.ok, resumed.ok ? undefined : resumed.message);
		await jobs.get(runId)?.promise;
		assert.equal(attempts.count, 2, "the request that saw the block resumed it");
		assert.equal(effectiveRunStatus(store.run(runId)!), "blocked");
	});
	test("resumes of the same run id in two independent journals each resume their own block (#5534)", async () => {
		const runId = "abcdef01-2222-4333-8444-abcdefabcdef";
		const left = await recordedBlock(runId);
		const right = await recordedBlock(runId);
		// One journal's resume reads its run while the other journal's run of the same id is resumed and blocks again.
		const read = left.holdNextRead();
		const leftResume = left.runtime.resumeDurableWorkflow(runId, { actor: "user" });
		await read.reading.promise;
		const rightResume = await right.runtime.resumeFailedRun(runId);
		assert.ok(rightResume.ok, rightResume.message);
		await right.jobs.get(runId)?.promise;
		read.release.resolve();
		const leftResult = await leftResume;
		await left.jobs.get(runId)?.promise;
		assert.ok(leftResult.ok, JSON.stringify(leftResult));
		assert.deepEqual([left.attempts.count, right.attempts.count], [2, 2], "each journal's block resumed once");
	});
});
