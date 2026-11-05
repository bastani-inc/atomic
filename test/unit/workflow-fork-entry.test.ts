import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	ForkEntryNotFoundError,
	findForkError,
	isForkEntryNotFoundError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { stripWorkflowOnlyOptions } from "../../packages/workflows/src/runs/foreground/stage-runner-options.js";
import { forkStageSession } from "../../packages/workflows/src/shared/stage-session-store.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { type AgentSessionAdapter, makeMockSession, type StageSessionCreateOptions } from "./stage-runner-helpers.js";

afterEach(async () => {
	setDurableBackend(undefined);
	await closeMemoryTestBackends();
});

const meta = { runId: "run", stageId: "stage", stageName: "retry-impl" };

async function sourceSession(store: MemorySessionStore) {
	const writer = await SessionManager.create(store, process.cwd());
	await writer.appendMessage({ role: "user", content: "first", timestamp: 1 });
	await writer.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "bad turn" }],
		api: "openai-responses",
		provider: "test",
		model: "test",
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
	await writer.appendMessage({ role: "user", content: "after", timestamp: 3 });
	const snapshot = await store.load(writer.getSessionId());
	return { sessionId: writer.getSessionId(), entries: snapshot.entries };
}

test("forkFromEntryId starts the stage session at that exact entry of the source session (#4321)", async () => {
	const store = new MemorySessionStore();
	const source = await sourceSession(store);
	const beforeBadTurn = source.entries[0]!;
	for (const schema of [undefined, Type.Object({ answer: Type.String() })]) {
		const forked = await stripWorkflowOnlyOptions(
			{
				sessionStore: store,
				context: "fork",
				forkFromSessionId: source.sessionId,
				forkFromEntryId: beforeBadTurn.id,
				...(schema === undefined ? {} : { schema }),
			},
			undefined,
			meta,
		);
		assert.ok(forked.sessionManager);
		assert.equal("forkFromEntryId" in forked, false);
		assert.equal("schema" in forked, false);
		assert.notEqual(forked.sessionManager.getSessionId(), source.sessionId);
		assert.equal(forked.sessionManager.getHeader()?.parentSessionId, source.sessionId);
		assert.equal(forked.sessionManager.getLeafId(), beforeBadTurn.id);
		assert.deepEqual(
			forked.sessionManager.getEntries().map((entry) => entry.id),
			[beforeBadTurn.id],
		);
	}
	assert.equal((await store.load(source.sessionId)).entries.length, 3, "the source session is unchanged");
});

test("a forkFromEntryId missing from the source session fails stage setup with ForkEntryNotFoundError (#4321)", async () => {
	const store = new MemorySessionStore();
	const source = await sourceSession(store);
	const sessionsBefore = [];
	for await (const session of store.list({ cwd: process.cwd(), includeInternal: true }))
		sessionsBefore.push(session.id);
	const error = await stripWorkflowOnlyOptions(
		{ sessionStore: store, context: "fork", forkFromSessionId: source.sessionId, forkFromEntryId: "missing-entry" },
		undefined,
		meta,
	).catch((failure: Error) => failure);
	assert.ok(error instanceof ForkEntryNotFoundError);
	assert.ok(isForkEntryNotFoundError(error));
	assert.equal(error.code, "entry-not-found");
	assert.equal(error.sessionId, source.sessionId);
	assert.equal(error.entryId, "missing-entry");
	assert.equal(error.stageName, "retry-impl");
	assert.equal(error.retryable, false);
	const sessionsAfter = [];
	for await (const session of store.list({ cwd: process.cwd(), includeInternal: true }))
		sessionsAfter.push(session.id);
	assert.deepEqual(sessionsAfter, sessionsBefore, "nothing was written");
});

test("ctx.task, ctx.chain and ctx.parallel pass forkFromEntryId to their stage sessions (#4321)", async () => {
	const store = new MemorySessionStore();
	const source = await sourceSession(store);
	const entryId = source.entries[1]!.id;
	const created: StageSessionCreateOptions[] = [];
	const agentSession: AgentSessionAdapter = {
		async create(options) {
			created.push(options);
			return makeMockSession({ prompt: async () => "done" }).session;
		},
	};
	const fork = { context: "fork" as const, forkFromSessionId: source.sessionId, forkFromEntryId: entryId };
	const def = workflow({
		name: "fork-entry-primitives",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("task", { prompt: "retry", ...fork }).catch(() => undefined);
			await ctx.chain([{ name: "chain", prompt: "retry", ...fork }]).catch(() => undefined);
			await ctx.parallel([{ name: "parallel", prompt: "retry", ...fork }]).catch(() => undefined);
			return {};
		},
	});
	await run(
		def,
		{},
		{
			runId: testRunId("fork-entry-primitives"),
			durableBackend: await createMemoryTestBackend(),
			store: createStore(),
			adapters: { agentSession, sessionStore: store },
		},
	);
	assert.equal(created.length, 3);
	for (const options of created) {
		assert.equal(options.sessionManager?.getHeader()?.parentSessionId, source.sessionId);
		assert.equal(options.sessionManager?.getLeafId(), entryId);
		assert.deepEqual(
			options.sessionManager?.getEntries().map((entry) => entry.id),
			[source.entries[0]!.id, entryId],
		);
	}
});

test("a task forking from a missing entry fails with the typed error in its cause chain (#4321)", async () => {
	const store = new MemorySessionStore();
	const source = await sourceSession(store);
	let failure: Error | undefined;
	const def = workflow({
		name: "fork-entry-missing",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			try {
				await ctx.task("task", {
					prompt: "retry",
					context: "fork",
					forkFromSessionId: source.sessionId,
					forkFromEntryId: "gone",
				});
			} catch (error) {
				failure = error as Error;
			}
			return {};
		},
	});
	await run(
		def,
		{},
		{
			runId: testRunId("fork-entry-missing"),
			durableBackend: await createMemoryTestBackend(),
			store: createStore(),
			adapters: {
				agentSession: { create: async () => makeMockSession().session },
				sessionStore: store,
			},
		},
	);
	const typed = findForkError(failure);
	assert.ok(isForkEntryNotFoundError(typed), String(failure));
	assert.equal(typed.entryId, "gone");
	assert.equal(typed.sessionId, source.sessionId);
});

test("forkStageSession copies every entry without an entryId and the branch to the entry with one (#4321)", async () => {
	const store = new MemorySessionStore();
	const source = await sourceSession(store);
	const [root, middle] = source.entries;
	const whole = await forkStageSession(store, source.sessionId, process.cwd(), {});
	assert.deepEqual(
		whole.getEntries().map((entry) => entry.id),
		source.entries.map((entry) => entry.id),
	);
	const branch = await forkStageSession(store, source.sessionId, process.cwd(), {}, store, middle!.id);
	assert.deepEqual(
		branch.getEntries().map((entry) => entry.id),
		[root!.id, middle!.id],
	);
	const atRoot = await forkStageSession(store, source.sessionId, process.cwd(), {}, store, root!.id);
	assert.deepEqual(
		atRoot.getEntries().map((entry) => entry.id),
		[root!.id],
	);
});

test("a missing entry names the workflow stage when the session has workflow metadata and no stage otherwise (#4321)", async () => {
	const store = new MemorySessionStore();
	const source = await sourceSession(store);
	const named = await forkStageSession(
		store,
		source.sessionId,
		process.cwd(),
		{ workflow: { runId: "run", stageId: "stage", stageName: "retry-impl" } },
		store,
		"gone",
	).catch((failure: Error) => failure);
	assert.ok(isForkEntryNotFoundError(named), String(named));
	assert.equal(named.stageName, "retry-impl");
	const unnamed = await forkStageSession(store, source.sessionId, process.cwd(), {}, store, "gone").catch(
		(failure: Error) => failure,
	);
	assert.ok(isForkEntryNotFoundError(unnamed), String(unnamed));
	assert.equal(unnamed.stageName, undefined);
	assert.equal(unnamed.entryId, "gone");
});

test("a resumed stage keeps the caller's forkFromEntryId only with the caller's forkFromSessionId (#4321)", async () => {
	const store = new MemorySessionStore();
	const replayed = await sourceSession(store);
	const chosen = await sourceSession(store);
	const entryId = chosen.entries[0]!.id;
	let fail = true;
	const created: StageSessionCreateOptions[] = [];
	const agentSession: AgentSessionAdapter = {
		async create(options) {
			created.push(options);
			return makeMockSession({
				prompt: async () => {
					if (fail) throw new Error("interrupted");
					return "done";
				},
			}).session;
		},
	};
	let mode: "none" | "entry-only" | "explicit" = "none";
	const def = workflow({
		name: "fork-entry-resume",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task(
				"retry",
				mode === "none"
					? { prompt: "retry" }
					: mode === "entry-only"
						? { prompt: "retry", forkFromEntryId: replayed.entries[0]!.id }
						: { prompt: "retry", context: "fork", forkFromSessionId: chosen.sessionId, forkFromEntryId: entryId },
			);
			return {};
		},
	});
	const adapters = { agentSession, sessionStore: store };
	const runStore = createStore();
	const failed = await run(def, {}, { runId: testRunId("fork-entry-resume"), store: runStore, adapters });
	assert.equal(failed.status, "failed");
	const source = runStore.run(failed.runId)!;
	const stage = source.stages.find((candidate) => candidate.name === "retry")!;
	stage.sessionId = replayed.sessionId;
	fail = false;
	for (const next of ["none", "entry-only", "explicit"] as const) {
		mode = next;
		created.length = 0;
		const resumed = await run(
			def,
			{},
			{ store: createStore(), adapters, continuation: { source, resumeFromStageId: stage.id } },
		);
		assert.equal(resumed.status, "completed", resumed.error);
		assert.equal(created.length, 1, next);
		const session = created[0]!.sessionManager!;
		if (next !== "explicit") {
			assert.equal(session.getHeader()?.parentSessionId, replayed.sessionId);
			assert.deepEqual(
				session.getEntries().map((entry) => entry.id),
				replayed.entries.map((entry) => entry.id),
			);
		} else {
			assert.equal(session.getHeader()?.parentSessionId, chosen.sessionId);
			assert.deepEqual(
				session.getEntries().map((entry) => entry.id),
				[entryId],
			);
		}
	}
});
