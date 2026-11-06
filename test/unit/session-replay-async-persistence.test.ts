import assert from "node:assert/strict";
import { SessionManager } from "@bastani/atomic";
import { test } from "vitest";
import { SessionConflictError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { createReplayStageContext } from "../../packages/workflows/src/runs/foreground/executor-stage-replay.js";
import type { WorkflowExitCleanup } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { readReplayedStageMessages } from "../../packages/workflows/src/runs/foreground/stage-runner-options.js";
import {
	deserializeStageWaitError,
	isStageRehydrationError,
	isStageReleasedError,
	StageRehydrationError,
	StageReleasedError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowPersistencePort } from "../../packages/workflows/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";

function replay(
	persistence: WorkflowPersistencePort,
	source: Partial<StageSnapshot> = {},
	readStoredMessages: (sessionId: string) => Promise<readonly object[]> = async () =>
		assert.fail("this replay reads no stored messages"),
) {
	const store = createStore();
	store.recordRunStart({
		id: "run",
		name: "replay",
		inputs: {},
		status: "running",
		stages: [],
		toolNodes: [],
		startedAt: 1,
	});
	const stage: StageSnapshot = { id: "stage", name: "saved", status: "running", parentIds: [], toolEvents: [] };
	let cleanup!: WorkflowExitCleanup;
	const context = createReplayStageContext({
		runId: "run",
		name: "saved",
		stageId: "stage",
		stageSnapshot: stage,
		replaySource: { ...stage, status: "completed", result: "saved result", ...source },
		activeStore: store,
		opts: { persistence },
		tracker: new GraphFrontierTracker(),
		registerWorkflowExitCleanup(_id, registered) {
			cleanup = registered;
			return () => {};
		},
		workflowExitSkippedReason: (reason) => `workflow-exit: ${reason}`,
		throwIfWorkflowExitSelected() {},
		readStoredMessages,
	});
	return { context, stage, cleanup: () => cleanup };
}

test("constructing a replay handle performs no asynchronous persistence", async () => {
	const calls: string[] = [];
	const { context } = replay({
		appendEntry: async (type) => {
			calls.push(type);
		},
	});
	assert.equal(context instanceof Promise, false);
	await sleep(0);
	assert.deepEqual(calls, []);
});

test("replay operations await one ordered start and end commit", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const calls: string[] = [];
	const { context } = replay({
		appendEntry: async (type) => {
			calls.push(type);
			if (type === "workflow.stage.end") {
				entered.resolve();
				await release.promise;
			}
		},
	});
	let firstSettled = false;
	let secondSettled = false;
	const first = context.prompt("unused").then((result) => {
		firstSettled = true;
		return result;
	});
	const second = context.complete("unused").then((result) => {
		secondSettled = true;
		return result;
	});
	await entered.promise;
	await sleep(0);
	try {
		assert.equal(firstSettled, false);
		assert.equal(secondSettled, false);
		assert.deepEqual(calls, ["workflow.stage.start", "workflow.stage.end"]);
	} finally {
		release.resolve();
	}
	assert.deepEqual(await Promise.all([first, second]), ["saved result", "saved result"]);
});

test("concurrent replay operations receive the identical typed start rejection", async () => {
	const failure = new SessionConflictError("session", 1, 2);
	let starts = 0;
	const { context } = replay({
		appendEntry: async () => {
			starts++;
			throw failure;
		},
	});
	const first = context.prompt("unused");
	const second = context.complete("unused");
	await Promise.all([
		assert.rejects(first, (error) => error === failure),
		assert.rejects(second, (error) => error === failure),
	]);
	assert.equal(starts, 1);
});

test("exit-first replay cleanup commits start before its terminal entry", async () => {
	const calls: string[] = [];
	const { stage, cleanup } = replay({
		appendEntry: async (type) => {
			calls.push(type);
		},
	});
	await cleanup().skipForWorkflowExit("stop");
	assert.deepEqual(calls, ["workflow.stage.start", "workflow.stage.end"]);
	assert.equal(stage.status, "skipped");
	assert.equal(stage.skippedReason, "workflow-exit: stop");
});

test("a replayed stage whose source recorded no session reads no messages, and messages throws StageReleasedError (#4309)", async () => {
	const { context } = replay({ appendEntry: async () => {} });
	assert.deepEqual(await context.readMessages(), []);
	assert.deepEqual(context.__residentMessages(), []);
	assert.throws(
		() => context.messages,
		(error: unknown) =>
			isStageReleasedError(error) && error.fields.property === "messages" && error.fields.replayed === true,
	);
});

test("a replayed stage reads its transcript from the run's session store, keeps its recorded model, and refuses to rehydrate (#4309)", async () => {
	const sessions = new MemorySessionStore();
	const manager = await SessionManager.create(sessions, process.cwd());
	await manager.appendMessage({ role: "user", content: "stored transcript", timestamp: 1 });
	const sessionId = manager.getSessionId();
	const { context } = replay(
		{ appendEntry: async () => {} },
		{ sessionId, model: "faux/faux-model", thinkingLevel: "high" },
		(id) => readReplayedStageMessages({}, { adapters: { sessionStore: sessions }, defaultCwd: process.cwd() }, id),
	);

	const messages = await context.readMessages();
	assert.deepEqual(
		messages.map((message) => (message as { readonly content: string }).content),
		["stored transcript"],
	);
	assert.equal(context.model, "faux/faux-model");
	assert.equal(context.thinkingLevel, "high");
	await context.release();
	for (const read of [() => context.messages, () => context.agent]) {
		assert.throws(read, (error: unknown) => {
			assert.ok(error instanceof StageReleasedError);
			assert.equal(error.code, "stage-released");
			assert.equal(error.fields.sessionId, sessionId);
			assert.equal(error.fields.replayed, true);
			return true;
		});
	}
	const error = await context.rehydrate().then(
		() => assert.fail("expected rehydrate() to reject"),
		(reason: unknown) => reason,
	);
	assert.ok(error instanceof StageRehydrationError);
	assert.equal(error.code, "replayed-stage");
	assert.equal(error.retryable, false);
	assert.deepEqual(error.fields, { runId: "run", stageId: "stage", stageName: "saved", sessionId, replayed: true });
	const copy = deserializeStageWaitError(JSON.parse(JSON.stringify(error)));
	assert.ok(isStageRehydrationError(copy));
	assert.equal(copy.code, "replayed-stage");
	assert.deepEqual(copy.fields, error.fields);
});

test("a replayed stage whose source recorded no model or thinking level throws StageReleasedError for both (#4309)", () => {
	const { context } = replay({ appendEntry: async () => {} });
	for (const [property, read] of [
		["model", () => context.model],
		["thinkingLevel", () => context.thinkingLevel],
	] as const) {
		assert.throws(read, (error: unknown) => isStageReleasedError(error) && error.fields.property === property);
	}
});
