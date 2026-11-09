import { describe } from "vitest";
import { SessionNotFoundError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import {
	deserializeStageWaitError,
	findStageWaitError,
	isStageRehydrationError,
	isStageReleaseError,
	isStageWaitConfigError,
	isStageWaitError,
	StageRehydrationError,
	StageReleaseError,
	StageWaitConfigError,
	StageWaitError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import {
	assert,
	createStageControlRegistry,
	createStore,
	mockSession,
	run,
	test,
	workflow,
} from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

function stageNamed(store: ReturnType<typeof createStore>, name: string): StageSnapshot | undefined {
	return store.runs()[0]?.stages.find((stage) => stage.name === name);
}

async function until(predicate: () => boolean): Promise<void> {
	for (let round = 0; round < 1_000 && !predicate(); round++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(predicate(), "condition never held");
}

describe("explicit stage.release() and stage.rehydrate() (#4309)", () => {
	test("a released stage waits with no session and comes back as it was", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const events: StageLifecycleEvent[] = [];
		const store = createStore();
		let duringRelease: { status?: string; kind?: string; live: number } | undefined;
		let afterRehydrate: string | undefined;
		const definition = workflow({
			name: "explicit-release",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement");
				await stage.prompt("write the change");
				await stage.release();
				await stage.release();
				const snapshot = stageNamed(store, "implement");
				duringRelease = {
					status: snapshot?.status,
					kind: snapshot?.wait?.kind,
					live: seen.created - seen.disposed,
				};
				await stage.rehydrate();
				afterRehydrate = stageNamed(store, "implement")?.status;
				await stage.rehydrate();
				await stage.release();
				await stage.sendUserMessage("address the review");
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				adapters: detachingAdapters(service, seen, { detach: false }),
				onStageLifecycleEvent: (_runId, event) => events.push(event),
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(duringRelease, { status: "suspended", kind: "release", live: 0 });
		assert.equal(afterRehydrate, "completed");
		assert.equal(seen.userPrompts.get("implement"), 2);
		assert.equal(seen.created, 3);
		assert.deepEqual(
			events.map((event) => [event.type, event.wait.kind]),
			[
				["stage_waiting", "release"],
				["stage_rehydrated", "release"],
				["stage_waiting", "release"],
				["stage_rehydrated", "release"],
			],
		);
	});

	test("release refuses while the stage's prompt runs", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const gate = Promise.withResolvers<void>();
		let refused: Error | undefined;
		const definition = workflow({
			name: "release-while-busy",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement");
				const turn = stage.prompt("write the change");
				await until(() => seen.userPrompts.get("implement") === 1);
				try {
					await stage.release();
				} catch (error) {
					refused = error as Error;
				}
				gate.resolve();
				await turn;
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				adapters: detachingAdapters(service, seen, { detach: false, promptGate: gate.promise }),
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.ok(refused instanceof StageReleaseError);
		assert.ok(isStageReleaseError(refused) && isStageWaitError(refused));
		assert.equal(refused.code, "stage-busy");
		assert.equal(refused.retryable, false);
		assert.equal(refused.fields.stageName, "implement");
		assert.equal(typeof refused.fields.sessionId, "string");
	});

	test("release refuses a session no store can reopen", async () => {
		let refused: Error | undefined;
		const definition = workflow({
			name: "release-not-reopenable",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement");
				await stage.prompt("write the change");
				try {
					await stage.release();
				} catch (error) {
					refused = error as Error;
				}
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{ store: createStore(), adapters: { agentSession: { create: async () => mockSession() } } },
		);

		assert.equal(result.status, "completed", result.error);
		assert.ok(isStageReleaseError(refused));
		assert.equal(refused.code, "not-reopenable");
		assert.deepEqual(
			{ stageName: refused.fields.stageName, sessionId: refused.fields.sessionId },
			{ stageName: "implement", sessionId: "sess-test-1" },
		);
		assert.equal(
			refused.message,
			'Cannot release stage "implement": its session cannot be reopened from a store (not-reopenable). Give the stage a persistent session store (the default store, sessionDir, or a caller-owned sessionStore) so it can be reopened.',
		);
	});

	test("a woken stage whose session the store no longer holds fails with a typed session-not-found error carrying the cause (#4309)", async () => {
		const service = new FakeCiService();
		const seen = counters();
		let failure: Error | undefined;
		const definition = workflow({
			name: "rehydration-failure",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const task = ctx.task("implement", { prompt: "write the change" });
				await until(() => service.pending.size === 1 && seen.disposed === 1);
				service.finishAll();
				try {
					await task;
				} catch (error) {
					failure = error as Error;
				}
				return {};
			},
		});

		await run(
			definition,
			{},
			{
				store: createStore(),
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, seen, {
					failCreationAfter: 1,
					creationFailure: () => new SessionNotFoundError("session-gone"),
				}),
			},
		);

		const rehydration = findStageWaitError(failure);
		assert.ok(rehydration instanceof StageRehydrationError);
		assert.ok(isStageRehydrationError(rehydration));
		assert.equal(rehydration.code, "session-not-found");
		assert.equal(rehydration.retryable, false);
		assert.equal(rehydration.fields.stageName, "implement");
		assert.ok(rehydration.cause instanceof SessionNotFoundError);
	});
});

describe("control of a waiting stage (#4309)", () => {
	test("text sent while a stage waits is held and reaches its reopened session before the turn continues", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const registry = createStageControlRegistry();
		const store = createStore();
		const definition = workflow({
			name: "steer-waiting",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const task = ctx.task("implement", { prompt: "write the change" });
				await until(() => stageNamed(store, "implement")?.status === "suspended");
				const [handle] = registry.forRun(store.runs()[0]!.id);
				await handle!.steer("also update the docs");
				await handle!.followUp("then summarize");
				assert.equal(seen.created - seen.disposed, 0);
				service.finishAll();
				await task;
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				stageControlRegistry: registry,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, seen),
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(seen.queued, ["implement: steer also update the docs", "implement: followUp then summarize"]);
		assert.equal(seen.userPrompts.get("implement"), 1);
		assert.equal(seen.continued.get("implement"), 1);
		await registry.clear();
	});

	test("a paused waiting stage is not reopened until it is resumed", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const registry = createStageControlRegistry();
		const store = createStore();
		const statuses: string[] = [];
		const definition = workflow({
			name: "pause-waiting",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const task = ctx.task("implement", { prompt: "write the change" });
				await until(() => stageNamed(store, "implement")?.status === "suspended");
				const [handle] = registry.forRun(store.runs()[0]!.id);
				await handle!.pause();
				statuses.push(stageNamed(store, "implement")!.status);
				service.finishAll();
				for (let round = 0; round < 20; round++) await new Promise((resolve) => setImmediate(resolve));
				statuses.push(`created:${seen.created}`);
				await handle!.resume();
				await task;
				statuses.push(stageNamed(store, "implement")!.status);
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				stageControlRegistry: registry,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, seen),
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(statuses, ["paused", "created:1", "completed"]);
		assert.equal(seen.created, 2);
		await registry.clear();
	});

	test("pausing the run holds its waiting stages, and resuming it returns them to their wait", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const registry = createStageControlRegistry();
		const store = createStore();
		const statuses: string[] = [];
		const definition = workflow({
			name: "pause-run-waiting",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const task = ctx.task("implement", { prompt: "write the change" });
				await until(() => stageNamed(store, "implement")?.status === "suspended");
				const runId = store.runs()[0]!.id;
				const paused = await pauseRun(runId, { store, stageControlRegistry: registry });
				statuses.push(`pause:${paused.ok}`, stageNamed(store, "implement")!.status);
				const resumed = await resumeRun(runId, { store, stageControlRegistry: registry });
				statuses.push(`resume:${resumed.ok}`, stageNamed(store, "implement")!.status);
				service.finishAll();
				await task;
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				stageControlRegistry: registry,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, seen),
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(statuses, ["pause:true", "paused", "resume:true", "suspended"]);
		assert.equal(seen.userPrompts.get("implement"), 1);
		await registry.clear();
	});

	test("quitting a run while its stage waits pauses it durably; a resume returns the stage to its wait", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const registry = createStageControlRegistry();
		const store = createStore();
		const backend = await createMemoryTestBackend();
		const waiting = Promise.withResolvers<void>();
		const definition = workflow({
			name: "quit-waiting",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("implement", { prompt: "write the change" });
				return {};
			},
		});

		const execution = run(
			definition,
			{},
			{
				store,
				stageControlRegistry: registry,
				durableBackend: backend,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, seen),
				onStageLifecycleEvent: (_runId, event) => {
					if (event.type === "stage_waiting") waiting.resolve();
				},
			},
		);
		await waiting.promise;
		const runId = store.runs()[0]!.id;
		const quit = await quitRun(runId, { store, stageControlRegistry: registry });

		assert.equal(quit.ok, true);
		assert.deepEqual(quit.ok ? quit.paused.map((stage) => [stage.name, stage.status, stage.wait?.kind]) : [], [
			["implement", "paused", "tool"],
		]);
		assert.equal(store.runs()[0]?.status, "paused");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
		assert.equal(seen.created - seen.disposed, 0);

		await resumeRun(runId, { store, stageControlRegistry: registry });
		assert.equal(stageNamed(store, "implement")?.status, "suspended");
		service.finishAll();
		assert.equal((await execution).status, "completed");
		assert.equal(seen.userPrompts.get("implement"), 1);
		assert.equal(service.aborted, 0);
		await registry.clear();
	});

	test("a stage that opts out stays resident for its whole wait", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const store = createStore();
		let live: number | undefined;
		const definition = workflow({
			name: "opt-out",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const task = ctx.task("implement", { prompt: "write the change", releaseWhenWaiting: false });
				await until(() => service.pending.size === 1);
				for (let round = 0; round < 20; round++) await new Promise((resolve) => setImmediate(resolve));
				live = seen.created - seen.disposed;
				service.finishAll();
				await task;
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{ store, releaseWhenWaiting: { afterMs: 0 }, adapters: detachingAdapters(service, seen) },
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(live, 1);
		assert.equal(seen.created, 1);
		assert.equal(stageNamed(store, "implement")?.wait, undefined);
	});
});

describe("StageWaitError family (#4309)", () => {
	test("an invalid run default is refused before the run starts", async () => {
		const store = createStore();
		let created = 0;
		await assert.rejects(
			run(
				workflow({ name: "invalid-default", description: "", inputs: {}, outputs: {}, run: async () => ({}) }),
				{},
				{
					store,
					releaseWhenWaiting: { afterMs: -5 },
					adapters: {
						agentSession: {
							create: async () => {
								created += 1;
								return mockSession();
							},
						},
					},
				},
			),
			(error: Error) => {
				assert.ok(error instanceof StageWaitConfigError);
				assert.ok(isStageWaitConfigError(error) && isStageWaitError(error));
				assert.equal(error.code, "invalid-release-when-waiting");
				assert.deepEqual(error.fields, { source: "sdk", field: "releaseWhenWaiting.afterMs", value: "-5" });
				assert.equal(
					error.message,
					"Invalid releaseWhenWaiting.afterMs for the run: -5 (invalid-release-when-waiting). Set releaseWhenWaiting to true, false, or { afterMs } with a number of milliseconds from 0 to 2147483647 (MAX_RELEASE_WHEN_WAITING_AFTER_MS, about 24.8 days); use false to keep the stage resident.",
				);
				assert.equal(error.hint.startsWith("Set releaseWhenWaiting"), true);
				return true;
			},
		);
		assert.equal(store.runs().length, 0);
		assert.equal(created, 0);
	});

	test("an invalid stage option names the stage and starts no session", async () => {
		let created = 0;
		let refused: Error | undefined;
		const definition = workflow({
			name: "invalid-stage-option",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				try {
					ctx.stage("implement", { releaseWhenWaiting: "soon" as never });
				} catch (error) {
					refused = error as Error;
				}
				return {};
			},
		});

		await run(
			definition,
			{},
			{
				store: createStore(),
				adapters: {
					sessionStore: new MemorySessionStore(),
					agentSession: {
						create: async () => {
							created += 1;
							return mockSession();
						},
					},
				},
			},
		);

		assert.ok(isStageWaitConfigError(refused));
		assert.deepEqual(refused.fields, {
			source: "sdk",
			field: "releaseWhenWaiting",
			value: '"soon"',
			stageName: "implement",
		});
		assert.equal(created, 0);
	});

	test("serializes across a process boundary and comes back as its own class", () => {
		const cause = Object.assign(new Error("store closed"), { code: "StoreClosed" });
		const original = new StageRehydrationError(
			{ runId: "run-1", stageId: "stage-1", stageName: "implement", sessionId: "session-1" },
			{ cause },
		);

		const wire = JSON.parse(JSON.stringify(original));
		const rehydrated = deserializeStageWaitError(wire);

		assert.ok(rehydrated instanceof StageRehydrationError);
		assert.ok(isStageRehydrationError(rehydrated));
		assert.equal(rehydrated.code, "session-unavailable");
		assert.equal(rehydrated.retryable, true);
		assert.equal(rehydrated.message, original.message);
		assert.deepEqual(rehydrated.fields, original.fields);
		assert.equal((rehydrated.cause as Error).message, "store closed");
		assert.equal((rehydrated.cause as Error & { code?: string }).code, "StoreClosed");

		for (const error of [
			new StageReleaseError("stage-busy", { stageName: "implement" }),
			new StageWaitConfigError({ source: "sdk", field: "releaseWhenWaiting", value: "1" }),
		]) {
			const back = deserializeStageWaitError(JSON.parse(JSON.stringify(error)));
			assert.equal(back.constructor, error.constructor);
			assert.equal(back.code, error.code);
			assert.deepEqual(back.fields, error.fields);
		}
		const unknown = deserializeStageWaitError({ ...original.toJSON(), name: "FutureStageWaitError" });
		assert.ok(unknown instanceof StageWaitError);
		assert.equal(unknown.name, "FutureStageWaitError");
		assert.equal(unknown.code, "session-unavailable");
	});

	test("guards recognize structural copies and walk a bounded cause chain", () => {
		const copy = { name: "StageReleaseError", code: "stage-busy", message: "copied" };
		assert.equal(isStageReleaseError(copy), true);
		assert.equal(isStageWaitError(copy), true);
		assert.equal(isStageRehydrationError(copy), false);
		assert.equal(isStageWaitError({ ...copy, code: "unknown-code" }), false);
		assert.equal(isStageWaitError(null), false);
		const wrapped = new Error("outer", { cause: new Error("middle", { cause: copy }) });
		assert.equal(findStageWaitError(wrapped), copy);
		let deep: Error = new Error("bottom", { cause: copy });
		for (let depth = 0; depth < 10; depth++) deep = new Error(`level ${depth}`, { cause: deep });
		assert.equal(findStageWaitError(deep), undefined);
	});
});
