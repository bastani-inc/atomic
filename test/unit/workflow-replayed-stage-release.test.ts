import assert from "node:assert/strict";
import { SessionManager } from "@bastani/atomic";
import { Type } from "typebox";
import { describe, test, vi } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import {
	deserializeStageWaitError,
	isStageRehydrationError,
	isStageReleasedError,
	isStageWaitError,
	StageRehydrationError,
	StageReleasedError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageContext, StageOptions } from "../../packages/workflows/src/shared/types.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";

const RUN_ID = "wf-replayed-release";
const STAGE = "implement";

interface Checkpoint {
	readonly sessionId?: string;
	readonly model?: string;
	readonly thinkingLevel?: string;
}

/** A store holding one stage session whose transcript is the user message `text`. */
async function storeWithTranscript(text: string): Promise<{ store: MemorySessionStore; sessionId: string }> {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	await manager.appendMessage({ role: "user", content: text, timestamp: 1 });
	return { store, sessionId: manager.getSessionId() };
}

function contents(messages: readonly object[]): string[] {
	return messages.map((message) => (message as { readonly content: string }).content);
}

/** What `body` returned or threw. */
async function settle<T>(body: () => T | Promise<T>): Promise<{ value?: T; error?: unknown }> {
	try {
		return { value: await body() };
	} catch (error) {
		return { error };
	}
}

/**
 * Resume a run whose stage completed before the restart, so the workflow replays it from its checkpoint, and let
 * `body` use the replayed stage. Nothing may open a live stage session.
 */
async function resumeWithReplayedStage<T>(input: {
	readonly checkpoint: Checkpoint;
	readonly runStore?: MemorySessionStore;
	readonly stageOptions?: StageOptions;
	readonly body: (stage: StageContext) => Promise<T>;
}): Promise<{ readonly status: string; readonly outcome: T; readonly prompted: unknown }> {
	const backend = await JournalTestBackend.create();
	await backend.commitWorkflowRegistration({
		workflowId: RUN_ID,
		name: "replayed-release",
		inputs: {},
		createdAt: Date.now(),
		status: "running",
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: RUN_ID,
		checkpointId: `stage:stage:${STAGE}:1`,
		name: STAGE,
		replayKey: `stage:${STAGE}:1`,
		output: "implemented",
		completedAt: Date.now(),
		...input.checkpoint,
	});
	const create = vi.fn(async () => {
		throw new Error("a replayed stage must not open a live session");
	});
	let outcome!: T;
	let prompted: unknown;
	const def = workflow({
		name: "replayed-release",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			const stage = ctx.stage(STAGE, input.stageOptions);
			prompted = await stage.prompt("Implement the change.");
			await stage.release();
			outcome = await input.body(stage);
			return { result: "done" };
		},
	});
	const result = await run(
		def,
		{},
		{
			runId: RUN_ID,
			store: createStore(),
			durableBackend: backend,
			adapters: {
				agentSession: { create },
				...(input.runStore === undefined ? {} : { sessionStore: input.runStore }),
			},
		},
	);
	assert.equal(create.mock.calls.length, 0);
	return { status: result.status, outcome, prompted };
}

describe("a stage a resumed run replays from its checkpoint, after stage.release() (#4309)", () => {
	test("release() resolves, the run completes, and readMessages() reads the transcript from the run's session store", async () => {
		const { store, sessionId } = await storeWithTranscript("stored transcript");
		const close = vi.spyOn(store, "close");

		const { status, outcome, prompted } = await resumeWithReplayedStage({
			checkpoint: { sessionId, model: "faux/faux-model", thinkingLevel: "high" },
			runStore: store,
			body: async (stage) => ({
				messages: contents(await stage.readMessages()),
				model: stage.model,
				thinkingLevel: stage.thinkingLevel,
				secondRelease: await settle(() => stage.release()),
			}),
		});

		assert.equal(status, "completed");
		assert.equal(prompted, "implemented");
		assert.deepEqual(outcome.messages, ["stored transcript"]);
		assert.equal(outcome.model, "faux/faux-model");
		assert.equal(outcome.thinkingLevel, "high");
		assert.deepEqual(outcome.secondRelease, { value: undefined });
		assert.equal(close.mock.calls.length, 0, "the run's own session store stays open");
	});

	test("a stage's own sessionStore is read instead of the run's session store", async () => {
		const own = await storeWithTranscript("stage-owned transcript");
		const runLevel = new MemorySessionStore();

		const { outcome } = await resumeWithReplayedStage({
			checkpoint: { sessionId: own.sessionId },
			runStore: runLevel,
			stageOptions: { sessionStore: own.store },
			body: async (stage) => contents(await stage.readMessages()),
		});

		assert.deepEqual(outcome, ["stage-owned transcript"]);
	});

	test("messages and agent throw StageReleasedError naming the replay, and the checkpoint's missing model throws too", async () => {
		const { store, sessionId } = await storeWithTranscript("stored transcript");

		const { status, outcome } = await resumeWithReplayedStage({
			checkpoint: { sessionId },
			runStore: store,
			body: async (stage) => ({
				messages: await settle(() => stage.messages),
				agent: await settle(() => stage.agent),
				model: await settle(() => stage.model),
				thinkingLevel: await settle(() => stage.thinkingLevel),
			}),
		});

		assert.equal(status, "completed");
		for (const property of ["messages", "agent", "model", "thinkingLevel"] as const) {
			const error = outcome[property].error;
			assert.ok(error instanceof StageReleasedError, property);
			assert.ok(isStageReleasedError(error));
			assert.equal(error.code, "stage-released");
			assert.equal(error.retryable, false);
			assert.deepEqual(error.fields, {
				runId: RUN_ID,
				stageName: STAGE,
				sessionId,
				replayed: true,
				property,
			});
		}
		assert.equal(
			(outcome.messages.error as Error).message,
			`Cannot read stage.messages of stage "${STAGE}": its session ${sessionId} is released because the stage was replayed from its durable checkpoint (stage-released). The stage completed before the run was resumed and was replayed from its durable checkpoint, so it has no live session for stage.messages to read and stage.rehydrate() cannot open one. Call await stage.readMessages() to read its stored transcript from the session store.`,
		);
	});

	test("a thinking level set on the replayed stage is the one it returns", async () => {
		const { outcome } = await resumeWithReplayedStage({
			checkpoint: { thinkingLevel: "high" },
			body: async (stage) => {
				await stage.setThinkingLevel("low");
				return stage.thinkingLevel;
			},
		});

		assert.equal(outcome, "low");
	});

	test("rehydrate() rejects with StageRehydrationError replayed-stage, which round-trips as the same class", async () => {
		const { store, sessionId } = await storeWithTranscript("stored transcript");

		const { status, outcome } = await resumeWithReplayedStage({
			checkpoint: { sessionId },
			runStore: store,
			body: async (stage) => settle(() => stage.rehydrate()),
		});

		assert.equal(status, "completed");
		const error = outcome.error;
		assert.ok(error instanceof StageRehydrationError);
		assert.ok(isStageRehydrationError(error));
		assert.equal(error.code, "replayed-stage");
		assert.equal(error.retryable, false);
		assert.deepEqual(error.fields, { runId: RUN_ID, stageName: STAGE, sessionId, replayed: true });
		assert.equal(
			error.message,
			`Cannot rehydrate stage "${STAGE}": it was replayed from its durable checkpoint and has no live stage session to reopen (replayed-stage). Read the stage's transcript with await stage.readMessages(), which reads it from the session store. To run the stage again, fork the run from it with /workflow fork <runId> --from <stage>.`,
		);

		const copy = deserializeStageWaitError(JSON.parse(JSON.stringify(error)));
		assert.ok(copy instanceof StageRehydrationError);
		assert.equal(copy.code, "replayed-stage");
		assert.equal(copy.retryable, false);
		assert.deepEqual(copy.fields, error.fields);
		assert.equal(copy.message, error.message);
		const structural = { ...JSON.parse(JSON.stringify(error)) };
		assert.ok(isStageRehydrationError(structural));
		assert.ok(isStageWaitError(structural));
	});

	test("a replayed stage whose checkpoint recorded no session reads no messages", async () => {
		const { outcome } = await resumeWithReplayedStage({
			checkpoint: {},
			body: async (stage) => stage.readMessages(),
		});

		assert.deepEqual(outcome, []);
	});
});
