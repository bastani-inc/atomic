import assert from "node:assert/strict";
import { JsonlSessionStore } from "@bastani/atomic";
import { describe, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import {
	createStageReplayKeyGenerator,
	durableWaitingStages,
	recordStageCheckpoint,
	recordStageSessionCheckpoint,
	stageCheckpointWithOutput,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import {
	createCheckpointIdGenerator,
	recordCheckpointDurably,
} from "../../packages/workflows/src/durable/tool-primitive.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import {
	assertStageOwnedSessionExists,
	assertWaitingStageSessionsExist,
} from "../../packages/workflows/src/engine/run-resume-preflight.js";
import {
	isStageRehydrationError,
	type StageRehydrationError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { StageContext } from "../../packages/workflows/src/shared/types.js";
import { decisionChatModel } from "../helpers/structured-output.js";
import { createStore, run, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

const WORKFLOW_NAME = "resume-stage-owned-store";

async function savedSession(store: MemorySessionStore): Promise<string> {
	const manager = await SessionManager.create(store, "/");
	await manager.appendMessage({ role: "user", content: "plan alpha", timestamp: 1 });
	await manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "planned alpha" }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	return manager.getSessionId();
}

async function seedStoppedRun(sessionId: string, waiting = true) {
	const runId = crypto.randomUUID();
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: WORKFLOW_NAME,
		inputs: {},
		createdAt: 1_000,
		status: "running",
	});
	const deps = (now: number) => ({
		workflowId: runId,
		backend,
		nextCheckpointId: createCheckpointIdGenerator(),
		nextReplayKey: createStageReplayKeyGenerator(runId),
		now: () => now,
	});
	const stage: StageSnapshot = {
		id: "stage-alpha",
		name: "alpha",
		replayKey: "stage:alpha:1",
		status: "completed",
		parentIds: [],
		toolEvents: [],
		startedAt: 1_000,
		endedAt: 2_000,
		durationMs: 1_000,
		result: "planned alpha",
		sessionId,
		sessionStorage: "stage",
	};
	await recordStageCheckpoint(deps(2_000), stage);
	if (waiting)
		await recordStageSessionCheckpoint(
			deps(3_000),
			{ ...stage, status: "waiting", wait: { kind: "release", since: 3_000, promptsCompleted: 1 } },
			{ force: true },
		);
	return { runId, backend };
}

async function resumeWith(
	seeded: { runId: string; backend: JournalDurableBackend },
	ownStore?: MemorySessionStore,
	runStore = new MemorySessionStore(),
) {
	const service = new FakeCiService();
	const seen = counters();
	const runStoreReads = vi.spyOn(runStore, "readHeader");
	const answers: string[] = [];
	let failure: Error | undefined;
	const result = await run(
		workflow({
			name: WORKFLOW_NAME,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const alpha = ctx.stage("alpha", ownStore === undefined ? {} : { sessionStore: ownStore });
				try {
					answers.push(await alpha.prompt("plan alpha"));
					await alpha.sendUserMessage("report alpha");
				} catch (error) {
					failure = error as Error;
				}
				return {};
			},
		}),
		{},
		{
			runId: seeded.runId,
			store: createStore(),
			durableBackend: seeded.backend,
			adapters: { ...detachingAdapters(service, seen, { detach: false }), sessionStore: runStore },
			releaseWhenWaiting: { afterMs: 600_000 },
		},
	);
	return { result, seen, service, answers, failure, runStoreReads };
}

function rehydrationFailure(failure: Error | undefined): StageRehydrationError {
	assert.ok(isStageRehydrationError(failure), `expected a StageRehydrationError, got ${String(failure)}`);
	return failure;
}

const SESSION_CALLS: readonly [string, (stage: StageContext) => Promise<unknown>][] = [
	["rehydrate", (stage) => stage.rehydrate()],
	["sendUserMessage", (stage) => stage.sendUserMessage("report alpha")],
	["steer", (stage) => stage.steer("steer alpha")],
	["followUp", (stage) => stage.followUp("follow alpha")],
	["readMessages", (stage) => stage.readMessages()],
	["setModel", (stage) => stage.setModel(decisionChatModel)],
	["setThinkingLevel", async (stage) => stage.setThinkingLevel("high")],
	["cycleModel", (stage) => stage.cycleModel()],
	["cycleThinkingLevel", async (stage) => stage.cycleThinkingLevel()],
	["navigateTree", (stage) => stage.navigateTree("entry")],
	["compact", (stage) => stage.compact()],
	["complete", (stage) => stage.complete("complete alpha")],
	["prompt", (stage) => stage.prompt("plan alpha")],
];

async function callWithoutOwnStore(
	seeded: { runId: string; backend: JournalDurableBackend },
	runStore: MemorySessionStore,
	calls: readonly [string, (stage: StageContext) => Promise<unknown>][],
) {
	const seen = counters();
	const runStoreUse = [vi.spyOn(runStore, "readHeader"), vi.spyOn(runStore, "load")];
	const failures = new Map<string, Error | undefined>();
	const result = await run(
		workflow({
			name: WORKFLOW_NAME,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const alpha = ctx.stage("alpha");
				for (const [name, call] of calls)
					failures.set(
						name,
						await call(alpha).then(
							() => undefined,
							(error: Error) => error,
						),
					);
				return {};
			},
		}),
		{},
		{
			runId: seeded.runId,
			store: createStore(),
			durableBackend: seeded.backend,
			adapters: { ...detachingAdapters(new FakeCiService(), seen, { detach: false }), sessionStore: runStore },
			releaseWhenWaiting: { afterMs: 600_000 },
		},
	);
	return {
		result,
		seen,
		failures,
		runStoreUses: () => runStoreUse.reduce((total, spy) => total + spy.mock.calls.length, 0),
	};
}

describe("waiting stages that keep their session in their own sessionStore (#4309)", () => {
	test("a stage released with its own sessionStore or sessionManager records that its session is in that store (#4309)", async () => {
		const backend = await JournalDurableBackend.open(new MemoryRunJournal());
		const runId = crypto.randomUUID();
		let recorded: ReturnType<typeof durableWaitingStages> = [];
		const service = new FakeCiService();
		const ownStore = new MemorySessionStore();
		const managedStore = new MemorySessionStore();
		const manager = await SessionManager.create(managedStore, "/");
		const result = await run(
			workflow({
				name: WORKFLOW_NAME,
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const own = ctx.stage("own", { sessionStore: ownStore });
					await own.prompt("plan own");
					const shared = ctx.stage("shared");
					await shared.prompt("plan shared");
					const managed = ctx.stage("managed", { sessionManager: manager });
					await managed.prompt("plan managed");
					await own.release();
					await shared.release();
					await managed.release();
					recorded = durableWaitingStages(backend, runId);
					return {};
				},
			}),
			{},
			{
				runId,
				store: createStore(),
				durableBackend: backend,
				adapters: detachingAdapters(service, counters(), { detach: false }),
				releaseWhenWaiting: { afterMs: 600_000 },
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(
			recorded.map((stage) => [stage.stageName, stage.sessionStorage]),
			[
				["own", "stage"],
				["shared", undefined],
				["managed", "stage"],
			],
		);
		const own = recorded.find((stage) => stage.stageName === "own");
		assert.ok(own !== undefined && (await ownStore.readHeader(own.sessionId)) !== undefined);
		const managed = recorded.find((stage) => stage.stageName === "managed");
		assert.ok(managed !== undefined && (await managedStore.readHeader(managed.sessionId)) !== undefined);
		await backend.close();
	});

	test("a resume skips the run store for it and continues it from the store the stage passes again (#4309)", async () => {
		const ownStore = new MemorySessionStore();
		const sessionId = await savedSession(ownStore);
		const seeded = await seedStoppedRun(sessionId);

		const resumed = await resumeWith(seeded, ownStore);

		assert.equal(resumed.result.status, "completed", resumed.result.error);
		assert.equal(resumed.failure, undefined);
		assert.deepEqual(resumed.answers, ["planned alpha"]);
		assert.deepEqual(Object.fromEntries(resumed.seen.userPrompts), { alpha: 1 });
		assert.equal(resumed.seen.created, 1);
		assert.equal(resumed.runStoreReads.mock.calls.length, 0);
		const transcript = await ownStore.load(sessionId);
		assert.deepEqual(
			transcript.entries.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
			),
			["plan alpha", "report alpha"],
		);
		await seeded.backend.close();
	});

	test("a stage whose own store no longer holds its session fails typed before it does any work (#4309)", async () => {
		const sessionId = await savedSession(new MemorySessionStore());
		const seeded = await seedStoppedRun(sessionId);
		const emptyOwnStore = new MemorySessionStore();
		const reads = vi.spyOn(emptyOwnStore, "readHeader");

		const resumed = await resumeWith(seeded, emptyOwnStore);

		const failure = rehydrationFailure(resumed.failure);
		assert.equal(failure.code, "session-not-found");
		assert.equal(failure.retryable, false);
		assert.equal(failure.fields.runId, seeded.runId);
		assert.equal(failure.fields.stageName, "alpha");
		assert.deepEqual(failure.fields.sessionIds, [sessionId]);
		assert.equal(failure.fields.storage, "stage sessionStore option: memory");
		assert.equal(
			failure.message,
			`Cannot rehydrate stage "alpha": session ${sessionId} is not in the session store (session-not-found). ${failure.hint}`,
		);
		assert.equal(reads.mock.calls.length, 1);
		assert.deepEqual(resumed.answers, []);
		assert.equal(resumed.seen.created, 0);
		assert.equal(resumed.seen.userPrompts.size, 0);
		assert.equal(resumed.service.dispatches, 0);
		assert.equal(resumed.runStoreReads.mock.calls.length, 0);
		await seeded.backend.close();
	});

	test("a stage called again without its own store fails typed, and never falls back to the run store that holds the same session (#4309)", async () => {
		const runStore = new MemorySessionStore();
		const sessionId = await savedSession(runStore);
		const seeded = await seedStoppedRun(sessionId);

		const resumed = await resumeWith(seeded, undefined, runStore);

		const failure = rehydrationFailure(resumed.failure);
		assert.equal(failure.code, "session-not-found");
		assert.equal(failure.fields.stageName, "alpha");
		assert.deepEqual(failure.fields.sessionIds, [sessionId]);
		assert.equal(failure.fields.storage, "stage sessionStore option: not passed to the resumed stage");
		assert.ok(failure.hint.includes("stage sessionStore option: not passed to the resumed stage"), failure.hint);
		assert.deepEqual(resumed.answers, []);
		assert.equal(resumed.seen.created, 0);
		assert.equal(resumed.seen.userPrompts.size, 0);
		assert.equal(resumed.service.dispatches, 0);
		assert.equal(resumed.runStoreReads.mock.calls.length, 0);
		const transcript = await runStore.load(sessionId);
		assert.equal(transcript.entries.length, 2);
		await seeded.backend.close();
	});

	test("rehydrate() first, without its own store, fails typed and never touches the run store that holds the same session (#4309)", async () => {
		const runStore = new MemorySessionStore();
		const sessionId = await savedSession(runStore);
		const seeded = await seedStoppedRun(sessionId);

		const called = await callWithoutOwnStore(seeded, runStore, [["rehydrate", (stage) => stage.rehydrate()]]);

		const failure = rehydrationFailure(called.failures.get("rehydrate"));
		assert.equal(failure.code, "session-not-found");
		assert.equal(failure.fields.stageName, "alpha");
		assert.deepEqual(failure.fields.sessionIds, [sessionId]);
		assert.equal(failure.fields.storage, "stage sessionStore option: not passed to the resumed stage");
		assert.equal(called.runStoreUses(), 0);
		assert.equal(called.seen.created, 0);
		assert.equal(called.seen.userPrompts.size, 0);
		await seeded.backend.close();
	});

	test("every call that opens, reopens or reads the session fails typed without its own store (#4309)", async () => {
		const runStore = new MemorySessionStore();
		const sessionId = await savedSession(runStore);
		const seeded = await seedStoppedRun(sessionId);

		const called = await callWithoutOwnStore(seeded, runStore, SESSION_CALLS);

		for (const [name] of SESSION_CALLS) {
			const failure = rehydrationFailure(called.failures.get(name));
			assert.equal(failure.code, "session-not-found", name);
			assert.deepEqual(failure.fields.sessionIds, [sessionId], name);
		}
		assert.equal(called.runStoreUses(), 0);
		assert.equal(called.seen.created, 0);
		assert.equal(called.seen.userPrompts.size, 0);
		await seeded.backend.close();
	});

	test("a completed stage keeps the marker, and its readMessages() without its own store fails typed instead of reading the run store (#4309)", async () => {
		const runStore = new MemorySessionStore();
		const sessionId = await savedSession(runStore);
		const seeded = await seedStoppedRun(sessionId, false);

		const called = await callWithoutOwnStore(seeded, runStore, [["readMessages", (stage) => stage.readMessages()]]);

		const failure = rehydrationFailure(called.failures.get("readMessages"));
		assert.equal(failure.code, "session-not-found");
		assert.equal(failure.fields.stageName, "alpha");
		assert.equal(failure.fields.stageId, "stage-alpha");
		assert.deepEqual(failure.fields.sessionIds, [sessionId]);
		assert.equal(called.runStoreUses(), 0);
		assert.equal(called.seen.created, 0);
		await seeded.backend.close();
	});

	test("the preflight checks only run-store stages, and opens no store when every waiting stage has its own (#4309)", async () => {
		const runStore = new MemorySessionStore();
		const present = await savedSession(runStore);
		const reads = vi.spyOn(runStore, "readHeader");
		const wait = { kind: "release" as const, since: 1, promptsCompleted: 1 };

		await assertWaitingStageSessionsExist(
			[{ replayKey: "stage:own:1", stageName: "own", sessionId: "elsewhere", sessionStorage: "stage", wait }],
			"run-own",
			{ adapters: { sessionStore: runStore } },
		);
		assert.equal(reads.mock.calls.length, 0);
		const opens = vi.spyOn(JsonlSessionStore, "open");
		await assertWaitingStageSessionsExist(
			[{ replayKey: "stage:own:1", stageName: "own", sessionId: "elsewhere", sessionStorage: "stage", wait }],
			"run-own",
			{ defaultSessionDir: "/never-opened" },
		);
		assert.equal(opens.mock.calls.length, 0);
		opens.mockRestore();

		const failure = await assertWaitingStageSessionsExist(
			[
				{ replayKey: "stage:own:1", stageName: "own", sessionId: "elsewhere", sessionStorage: "stage", wait },
				{ replayKey: "stage:shared:1", stageName: "shared", sessionId: present, wait },
				{ replayKey: "stage:gone:1", stageName: "gone", sessionId: "gone", wait },
			],
			"run-own",
			{ adapters: { sessionStore: runStore } },
		).then(
			() => undefined,
			(error: Error) => error,
		);
		assert.deepEqual(rehydrationFailure(failure).fields.sessionIds, ["gone"]);
		assert.deepEqual(
			reads.mock.calls.map((call) => call[0]),
			[present, "gone"],
		);
	});

	test("a resumed stage reads its own store's header once across all its calls (#4309)", async () => {
		const ownStore = new MemorySessionStore();
		const sessionId = await savedSession(ownStore);
		const seeded = await seedStoppedRun(sessionId);
		const reads = vi.spyOn(ownStore, "readHeader");

		const resumed = await resumeWith(seeded, ownStore);

		assert.equal(resumed.result.status, "completed", resumed.result.error);
		assert.equal(resumed.failure, undefined);
		assert.equal(reads.mock.calls.filter((call) => call[0] === sessionId).length, 1);
		await seeded.backend.close();
	});

	test("a failed check is made again on the next call, which goes on once the store holds the session (#4309)", async () => {
		const ownStore = new MemorySessionStore();
		const sessionId = await savedSession(ownStore);
		const seeded = await seedStoppedRun(sessionId);
		const reads = vi.spyOn(ownStore, "readHeader").mockResolvedValueOnce(undefined);
		let first: Error | undefined;
		let second: string | undefined;
		const result = await run(
			workflow({
				name: WORKFLOW_NAME,
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const alpha = ctx.stage("alpha", { sessionStore: ownStore });
					first = await alpha.prompt("plan alpha").then(
						() => undefined,
						(error: Error) => error,
					);
					second = await alpha.prompt("plan alpha");
					return {};
				},
			}),
			{},
			{
				runId: seeded.runId,
				store: createStore(),
				durableBackend: seeded.backend,
				adapters: { ...detachingAdapters(new FakeCiService(), counters(), { detach: false }) },
				releaseWhenWaiting: { afterMs: 600_000 },
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(rehydrationFailure(first).code, "session-not-found");
		assert.equal(rehydrationFailure(first).fields.stageId, "stage-alpha");
		assert.equal(second, "planned alpha");
		assert.equal(reads.mock.calls.filter((call) => call[0] === sessionId).length, 2);
		await seeded.backend.close();
	});

	test("the check of a stage without a stage id names no stage id (#4309)", async () => {
		const failure = await assertStageOwnedSessionExists(undefined, {
			runId: "run-own",
			stageName: "alpha",
			sessionId: "s-1",
		}).then(
			() => undefined,
			(error: Error) => error,
		);
		assert.deepEqual(rehydrationFailure(failure).fields, {
			runId: "run-own",
			stageName: "alpha",
			sessionIds: ["s-1"],
			storage: "stage sessionStore option: not passed to the resumed stage",
		});
	});

	test("a stage's completed record keeps the own-store marker of its other records (#4309)", async () => {
		const backend = await JournalDurableBackend.open(new MemoryRunJournal());
		const runId = crypto.randomUUID();
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: WORKFLOW_NAME,
			inputs: {},
			createdAt: 1_000,
			status: "running",
		});
		const record = (checkpointId: string, replayKey: string, fields: Partial<DurableStageCheckpoint>) =>
			recordCheckpointDurably(backend, {
				kind: "stage",
				workflowId: runId,
				checkpointId,
				name: replayKey,
				replayKey,
				completedAt: 1_000,
				...fields,
			});
		// The session record says the session is in the stage's own store; the output record, as a schema stage
		// writes it, carries the output alone.
		await record("own-session", "stage:own:1", { sessionId: "s-own", sessionStorage: "stage" });
		await record("own-output", "stage:own:1", { output: "done", completedAt: 2_000 });
		await record("shared-session", "stage:shared:1", { sessionId: "s-shared" });
		await record("shared-output", "stage:shared:1", { output: "done", completedAt: 2_000 });

		assert.equal(stageCheckpointWithOutput(backend, runId, "stage:own:1")?.sessionStorage, "stage");
		const shared = stageCheckpointWithOutput(backend, runId, "stage:shared:1");
		assert.ok(shared !== undefined);
		assert.equal("sessionStorage" in shared, false);
		await backend.close();
	});
});
