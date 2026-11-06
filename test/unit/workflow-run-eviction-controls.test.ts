import { describe } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { ScopedDurableBackend } from "../../packages/workflows/src/durable/scoped-backend.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { run as sdkRun } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { deliverStageWake } from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";
import { rehydrateError } from "../../packages/workflows/src/shared/error-codec.js";
import {
	DEFAULT_EVICT_WHEN_WAITING_AFTER_MS,
	parseEvictWhenWaiting,
} from "../../packages/workflows/src/shared/run-eviction.js";
import {
	isRunEvictedError,
	isRunEvictionConfigError,
	isRunEvictionError,
	isRunReplayError,
	RunEvictionConfigError,
	RunReplayError,
} from "../../packages/workflows/src/shared/run-eviction-errors.js";
import { MAX_RELEASE_WHEN_WAITING_AFTER_MS } from "../../packages/workflows/src/shared/stage-wait.js";
import { isStageWakeError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { registerStageWakeKind, type StageWakeHandlerContext } from "../../packages/workflows/src/shared/stage-wake.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert, createCancellationRegistry, run, test, workflow } from "./executor-shared.js";
import { entriesOf, stagesWaiting, start, until } from "./run-eviction-helpers.js";

useTemporaryAgentDir();

declare module "@bastani/atomic/workflows" {
	interface StageWakeKinds {
		/** Sent to a stage of an evicted run; its handler records what reached the stage. */
		"test-eviction-ping": { readonly note: string };
	}
}

/** Journal calls that change it: none may happen when `evictWhenWaiting` is refused. */
const JOURNAL_WRITES = [
	"createRun",
	"acquire",
	"takeover",
	"takeoverExpired",
	"renew",
	"release",
	"append",
	"deleteRun",
	"deleteOwnedRun",
] as const;

async function countedJournal(): Promise<{ readonly backend: JournalDurableBackend; readonly writes: () => number }> {
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal);
	let writes = 0;
	for (const method of JOURNAL_WRITES) {
		const original = (journal[method] as (...args: never[]) => unknown).bind(journal);
		Object.assign(journal, {
			[method]: (...args: never[]) => {
				writes += 1;
				return original(...args);
			},
		});
	}
	return { backend, writes: () => writes };
}

function bodyThatRuns(): { readonly definition: ReturnType<typeof workflow>; readonly ran: () => boolean } {
	let ran = false;
	return {
		definition: workflow({
			name: "evict-refused",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				ran = true;
				await ctx.stage("plain").prompt("go");
				return {};
			},
		}),
		ran: () => ran,
	};
}

describe("an evicted run answers its owner (#4373)", () => {
	test("the caller's signal kills an evicted run: its stages' calls are aborted and the run ends killed (#4373)", async () => {
		const controller = new AbortController();
		const started = start(stagesWaiting(["alpha", "beta"]), { signal: controller.signal });
		await until(() => entriesOf(started.runId).length === 2);

		controller.abort(new Error("stop the run"));
		const result = await started.result;

		assert.equal(result.status, "killed");
		assert.equal(started.service.aborted, 2);
		assert.equal(started.service.dispatches, 2);
		assert.deepEqual(entriesOf(started.runId), []);
	});

	test("a kill through the cancellation registry reaches the rebuilt run (#4373)", async () => {
		const cancellation = createCancellationRegistry();
		const started = start(stagesWaiting(["alpha"]), { cancellation });
		await until(() => entriesOf(started.runId).length === 1);

		assert.equal(cancellation.abort(started.runId, new Error("killed from the host")), true);
		const result = await started.result;

		assert.equal(result.status, "killed");
		assert.equal(started.starts(), 2);
		assert.equal(started.service.aborted, 1);
	});

	test("a kill through a registration the caller made reaches an evicted run given its signal, and a run rebuilt once (#4373)", async () => {
		const cancellation = createCancellationRegistry();
		const controller = new AbortController();
		const started = start(stagesWaiting(["alpha", "beta"]), { cancellation, signal: controller.signal });
		cancellation.register(started.runId, controller);
		await until(() => entriesOf(started.runId).length === 2);

		started.service.finish("call-alpha");
		await until(() => entriesOf(started.runId).length === 1);
		assert.equal(cancellation.isAborted(started.runId), false);
		assert.equal(cancellation.abort(started.runId, new Error("killed from the host")), true);
		const result = await started.result;

		assert.equal(result.status, "killed");
		assert.equal(started.service.aborted, 1);
		assert.deepEqual(entriesOf(started.runId), []);
	});

	test("a kill through the cancellation registry reaches a run rebuilt once and evicted again (#4373)", async () => {
		const cancellation = createCancellationRegistry();
		const started = start(stagesWaiting(["alpha", "beta"]), { cancellation });
		await until(() => entriesOf(started.runId).length === 2);

		started.service.finish("call-alpha");
		await until(() => entriesOf(started.runId).length === 1);
		assert.equal(cancellation.abort(started.runId, new Error("killed from the host")), true);
		const result = await started.result;

		assert.equal(result.status, "killed");
		assert.equal(started.service.aborted, 1);
		assert.deepEqual(entriesOf(started.runId), []);
	});

	test("a quit sent to an evicted run rebuilds it and quits it: the run pauses resumably and its calls are aborted (#4373)", async () => {
		const toolControlRegistry = createToolControlRegistry();
		const started = start(stagesWaiting(["alpha", "beta"]), { toolControlRegistry });
		await until(() => entriesOf(started.runId).length === 2);

		await toolControlRegistry.runControl(started.runId)!.quit();
		const result = await started.result;

		assert.equal(result.status, "paused");
		assert.equal(started.starts(), 2);
		assert.equal(started.service.aborted, 2);
		assert.deepEqual(entriesOf(started.runId), []);
	});

	test("a pause sent to an evicted run rebuilds it paused; resumed, its stages wait on the same calls again (#4373)", async () => {
		const toolControlRegistry = createToolControlRegistry();
		const started = start(stagesWaiting(["alpha", "beta"]), { toolControlRegistry });
		await until(() => entriesOf(started.runId).length === 2);
		const control = toolControlRegistry.runControl(started.runId)!;
		assert.equal(control.paused, false);

		await control.pause();
		assert.equal(toolControlRegistry.runControl(started.runId)?.paused, true);
		assert.deepEqual(entriesOf(started.runId), []);
		await toolControlRegistry.runControl(started.runId)!.resume();
		await until(() => started.starts() === 2 && entriesOf(started.runId).length === 2);

		started.service.finishAll();
		const result = await started.result;
		assert.equal(result.status, "completed", result.error);
		assert.equal(started.starts(), 3);
		assert.equal(started.service.dispatches, 2);
		assert.equal(started.service.aborted, 0);
	});

	test("a quit through the public quitRun rebuilds the evicted run, waits for its final writes and retires its execution: the journal lease is released (#4373)", async () => {
		const backend = await createMemoryTestBackend();
		const started = start(stagesWaiting(["alpha", "beta"]), { durableBackend: backend });
		await until(() => entriesOf(started.runId).length === 2);
		assert.equal(await backend.workflowOwnership(started.runId), "local");

		const quit = await quitRun(started.runId, { store: started.store });
		const result = await started.result;

		assert.equal(quit.ok, true);
		assert.notEqual(result.status, "completed");
		assert.deepEqual(entriesOf(started.runId), []);
		assert.equal(await backend.workflowOwnership(started.runId), "available");
		assert.equal(started.service.aborted, 2);
	});

	test("persistence an owner still has to write keeps the rebuilt run's execution until it settles (#4373)", async () => {
		const toolControlRegistry = createToolControlRegistry();
		const started = start(stagesWaiting(["alpha"]), { toolControlRegistry });
		await until(() => entriesOf(started.runId).length === 1);
		const finalWrites = Promise.withResolvers<void>();
		let ended = false;
		void started.result.then(() => {
			ended = true;
		});

		const control = toolControlRegistry.runControl(started.runId)!;
		control.settlePersistence?.(finalWrites.promise);
		await control.quit();
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(ended, false, "the run's execution ended before the owner's writes settled");

		finalWrites.resolve();
		const result = await started.result;
		assert.notEqual(result.status, "completed");
	});

	test("an owner that retires an evicted run's control rebuilds the run and retires it: it ends suspended without a terminal result and its lease is released (#4373)", async () => {
		const backend = await createMemoryTestBackend();
		const toolControlRegistry = createToolControlRegistry();
		const started = start(stagesWaiting(["alpha"]), { durableBackend: backend, toolControlRegistry });
		await until(() => entriesOf(started.runId).length === 1);

		await toolControlRegistry.runControl(started.runId)!.retire?.();
		const result = await started.result;

		assert.notEqual(result.status, "completed");
		assert.equal(toolControlRegistry.runControl(started.runId), undefined);
		assert.equal(await backend.workflowOwnership(started.runId), "available");
		assert.equal(started.starts(), 2);
	});

	test("a message sent to an evicted stage rebuilds the run and reaches the stage; one sent to any other stage is refused (#4373)", async () => {
		const received: { readonly note: string; readonly context: StageWakeHandlerContext }[] = [];
		const unregister = registerStageWakeKind("test-eviction-ping", (wake, context) => {
			received.push({ note: wake.note, context });
		});
		try {
			const started = start(stagesWaiting(["alpha"]));
			await until(() => entriesOf(started.runId).length === 1);
			const [entry] = entriesOf(started.runId);

			assert.deepEqual(deliverStageWake(started.runId, "no-such-stage", { kind: "test-eviction-ping", note: "x" }), {
				status: "stage-not-open",
			});
			assert.throws(
				() => deliverStageWake(started.runId, entry!.stageId, { kind: "test-unregistered" as never, note: "x" }),
				(error: unknown) => isStageWakeError(error) && error.code === "unknown-wake-kind",
			);
			assert.equal(started.starts(), 1, "a refused message wakes nothing");
			assert.deepEqual(
				deliverStageWake(started.runId, entry!.stageId, { kind: "test-eviction-ping", note: "hello" }),
				{ status: "queued" },
			);
			await until(() => received.length === 1 && entriesOf(started.runId).length === 1);

			assert.equal(started.starts(), 2);
			assert.equal(received[0]!.note, "hello");
			assert.equal(received[0]!.context.runId, started.runId);
			assert.equal(received[0]!.context.stageId, entry!.stageId);
			started.service.finishAll();
			const result = await started.result;
			assert.equal(result.status, "completed", result.error);
			assert.equal(started.service.dispatches, 1);
		} finally {
			unregister();
		}
	});

	test("a run is not evicted while a waiting stage handles a message, and is checked again once the handler is done (#4373)", async () => {
		const gate = Promise.withResolvers<void>();
		const handled: string[] = [];
		const unregister = registerStageWakeKind("test-eviction-ping", async (wake) => {
			handled.push(wake.note);
			await gate.promise;
		});
		try {
			const started = start(stagesWaiting(["alpha"]), { evictWhenWaiting: { afterMs: 100 } });
			await until(() => started.store.run(started.runId)?.stages[0]?.status === "waiting");
			const stageId = started.store.run(started.runId)!.stages[0]!.id;
			assert.deepEqual(deliverStageWake(started.runId, stageId, { kind: "test-eviction-ping", note: "busy" }), {
				status: "handled",
			});

			await new Promise((resolve) => setTimeout(resolve, 250));
			assert.deepEqual(handled, ["busy"]);
			assert.deepEqual(entriesOf(started.runId), [], "evicted while a handler ran");

			gate.resolve();
			await until(() => entriesOf(started.runId).length === 1);
			assert.equal(started.starts(), 1);
			started.service.finishAll();
			const result = await started.result;
			assert.equal(result.status, "completed", result.error);
			assert.equal(started.starts(), 2);
		} finally {
			unregister();
		}
	});

	test("code the evicted execution still runs outside ctx calls gets RunEvictedError from its next ctx call, and the rebuilt run carries on (#4373)", async () => {
		let executions = 0;
		const late = Promise.withResolvers<void>();
		const thrown = Promise.withResolvers<unknown>();
		const definition = workflow({
			name: "evict-late-code",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				executions += 1;
				if (executions === 1)
					void late.promise.then(() => {
						try {
							ctx.stage("late");
							thrown.resolve(undefined);
						} catch (error) {
							thrown.resolve(error);
						}
					});
				await ctx.stage("alpha").prompt("ship alpha");
				return {};
			},
		});
		const started = start(definition);
		await until(() => entriesOf(started.runId).length === 1);

		late.resolve();
		const error = await thrown.promise;
		assert.ok(isRunEvictedError(error));
		assert.equal(error.code, "run-evicted");
		assert.deepEqual(error.fields, { runId: started.runId });
		assert.ok(isRunEvictionError(error));

		started.service.finishAll();
		const result = await started.result;
		assert.equal(result.status, "completed", result.error);
		assert.equal(executions, 2);
	});

	test("a replayed body that never waits on an evicted stage's calls again fails the run with a typed RunReplayError and aborts the calls (#4373)", async () => {
		let executions = 0;
		const definition = workflow({
			name: "evict-diverging",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				executions += 1;
				if (executions === 1) await ctx.stage("alpha").prompt("ship alpha");
				else await ctx.tool("other", {}, async () => "done");
				return {};
			},
		});
		const started = start(definition);
		await until(() => entriesOf(started.runId).length === 1);

		started.service.finishAll();
		const result = await started.result;

		assert.equal(result.status, "failed");
		assert.equal(started.service.aborted, 1);
		const rebuilt = rehydrateError(JSON.parse(JSON.stringify(result.failureDetail)));
		assert.ok(rebuilt instanceof RunReplayError);
		assert.ok(isRunReplayError(rebuilt));
		assert.equal(rebuilt.code, "replay-diverged");
		assert.deepEqual(rebuilt.fields, {
			runId: started.runId,
			replayKeys: ["stage:alpha:1"],
			toolCallIds: ["call-alpha"],
		});
		assert.equal(rebuilt.retryable, false);
	});
});

describe("evictWhenWaiting is checked where it enters, before anything is written (#4373)", () => {
	test("parseEvictWhenWaiting keeps a run resident by default, evicts after the default quiet period for true, and takes afterMs from 0 to the timer limit (#4373)", () => {
		assert.equal(parseEvictWhenWaiting(undefined), undefined);
		assert.equal(parseEvictWhenWaiting(false), undefined);
		assert.deepEqual(parseEvictWhenWaiting(true), { afterMs: DEFAULT_EVICT_WHEN_WAITING_AFTER_MS });
		assert.equal(DEFAULT_EVICT_WHEN_WAITING_AFTER_MS, 60_000);
		assert.deepEqual(parseEvictWhenWaiting({ afterMs: 0 }), { afterMs: 0 });
		assert.deepEqual(parseEvictWhenWaiting({ afterMs: MAX_RELEASE_WHEN_WAITING_AFTER_MS }), {
			afterMs: MAX_RELEASE_WHEN_WAITING_AFTER_MS,
		});
	});

	for (const [value, field, shown] of [
		[{ afterMs: -1 }, "evictWhenWaiting.afterMs", "-1"],
		[{ afterMs: MAX_RELEASE_WHEN_WAITING_AFTER_MS + 1 }, "evictWhenWaiting.afterMs", "2147483648"],
		[{ afterMs: Number.NaN }, "evictWhenWaiting.afterMs", "NaN"],
		[{ afterMs: Number.POSITIVE_INFINITY }, "evictWhenWaiting.afterMs", "Infinity"],
		[{ afterMs: "5" }, "evictWhenWaiting.afterMs", '"5"'],
		[{}, "evictWhenWaiting.afterMs", "undefined"],
		["soon", "evictWhenWaiting", '"soon"'],
		[null, "evictWhenWaiting", "null"],
		[7, "evictWhenWaiting", "7"],
	] as const)
		test(`run() refuses evictWhenWaiting ${JSON.stringify(value) ?? String(value)} with a typed config error naming ${field}, before writing anything (#4373)`, async () => {
			const { backend, writes } = await countedJournal();
			const body = bodyThatRuns();
			for (const entry of [run, sdkRun])
				await assert.rejects(
					entry(body.definition, {}, { durableBackend: backend, evictWhenWaiting: value as never }),
					(error: unknown) =>
						error instanceof RunEvictionConfigError &&
						isRunEvictionConfigError(error) &&
						isRunEvictionError(error) &&
						error.code === "invalid-evict-when-waiting" &&
						error.retryable === false &&
						JSON.stringify(error.fields) ===
							JSON.stringify({ source: "sdk", field, value: shown, reason: "value" }),
				);
			assert.equal(writes(), 0);
			assert.equal(body.ran(), false);
		});

	test("the refusal reads as what failed, its code and what to do (#4373)", () => {
		assert.throws(
			() => parseEvictWhenWaiting({ afterMs: -1 }),
			(error: unknown) =>
				error instanceof Error &&
				error.message ===
					"Invalid evictWhenWaiting.afterMs: -1 (invalid-evict-when-waiting). Set evictWhenWaiting to true, false, or { afterMs } with a number of milliseconds from 0 to 2147483647; leave it unset to keep the run resident.",
		);
	});

	test("a run that continues another run cannot be evicted: refused before its journal is touched (#4373)", async () => {
		const { backend, writes } = await countedJournal();
		const body = bodyThatRuns();
		const source: RunSnapshot = {
			id: crypto.randomUUID(),
			name: "evict-refused",
			inputs: {},
			startedAt: 1,
			status: "failed",
			stages: [],
			toolNodes: [],
			resumable: true,
		};
		const runId = crypto.randomUUID();
		await assert.rejects(
			run(
				body.definition,
				{},
				{
					runId,
					durableBackend: backend,
					evictWhenWaiting: true,
					continuation: { source, resumeFromStageId: "missing" },
				},
			),
			(error: unknown) =>
				isRunEvictionConfigError(error) &&
				JSON.stringify(error.fields) ===
					JSON.stringify({
						source: "sdk",
						field: "evictWhenWaiting",
						value: "true",
						reason: "continuation",
						runId,
					}) &&
				error.hint === "Leave evictWhenWaiting unset when the run continues another run.",
		);
		assert.equal(writes(), 0);
		assert.equal(body.ran(), false);
	});

	test("a run whose durable backend is not a run journal cannot be evicted: refused before anything is written (#4373)", async () => {
		const { backend, writes } = await countedJournal();
		const body = bodyThatRuns();
		const runId = crypto.randomUUID();
		await assert.rejects(
			run(
				body.definition,
				{},
				{
					runId,
					durableBackend: new ScopedDurableBackend(backend, {
						rootWorkflowId: runId,
						scopePrefix: "workflow:x:1",
					}),
					evictWhenWaiting: { afterMs: 5 },
				},
			),
			(error: unknown) =>
				isRunEvictionConfigError(error) &&
				JSON.stringify(error.fields) ===
					JSON.stringify({
						source: "sdk",
						field: "evictWhenWaiting",
						value: '{"afterMs":5}',
						reason: "backend",
						runId,
					}) &&
				error.message.startsWith(
					`Cannot evict run ${runId} while it waits: its durable backend is not a run journal`,
				),
		);
		assert.equal(writes(), 0);
		assert.equal(body.ran(), false);
	});
});
