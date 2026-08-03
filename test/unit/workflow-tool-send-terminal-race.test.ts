import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
import { createStageControlHandle } from "../../packages/workflows/src/runs/foreground/executor-stage-control.js";
import type { PostMortemStageChatDeps } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { mockSession, type StageSessionRuntime } from "./executor-shared.js";

const RUN_ID = testRunId("terminal-send-race");
let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "atomic-terminal-send-race-"));
});

afterEach(() => {
	stageControlRegistry.clear();
	store.removeRun(RUN_ID);
	rmSync(tempDir, { recursive: true, force: true });
});

function retainedSession(): string {
	const sessionFile = join(tempDir, "retained.jsonl");
	writeFileSync(
		sessionFile,
		`${[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "retained-session",
				timestamp: new Date().toISOString(),
				cwd: tempDir,
			}),
			JSON.stringify({
				type: "message",
				id: "original",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Original request" },
			}),
		].join("\n")}\n`,
	);
	return sessionFile;
}

test("terminal publication revokes a send awaiting retained-session creation", async () => {
	const sessionFile = retainedSession();
	store.recordRunStart({
		id: RUN_ID,
		name: "send-race",
		inputs: {},
		status: "running",
		stages: [
			{
				id: "stage-a",
				name: "completed stage",
				status: "completed",
				parentIds: [],
				toolEvents: [],
				attachable: true,
				sessionFile,
			},
		],
		startedAt: 1,
	});
	const creationStarted = Promise.withResolvers<void>();
	const releaseCreation = Promise.withResolvers<void>();
	const sessionDisposed = Promise.withResolvers<void>();
	const prompts: string[] = [];
	let creates = 0;
	let sdkMessageCalls = 0;
	const sideEffectPath = join(tempDir, "unexpected-side-effect.txt");
	let disposes = 0;
	const session: StageSessionRuntime = {
		...mockSession(),
		sessionFile,
		async prompt(text: string) {
			prompts.push(text);
			writeFileSync(sideEffectPath, "prompt side effect");
		},
		async sendUserMessage() {
			sdkMessageCalls += 1;
			writeFileSync(sideEffectPath, "SDK message side effect");
		},
		async dispose() {
			disposes += 1;
			sessionDisposed.resolve();
		},
	};
	const adapters: StageAdapters = {
		agentSession: {
			async create() {
				creates += 1;
				creationStarted.resolve();
				await releaseCreation.promise;
				return session;
			},
		},
	};
	const resolvePostMortemDeps = (): PostMortemStageChatDeps => ({
		registry: stageControlRegistry,
		adapters,
		cwd: tempDir,
	});
	const transcriptBefore = readFileSync(sessionFile);

	const send = workflowSendAction({ runId: RUN_ID, stageId: "stage-a", text: "late work" }, { resolvePostMortemDeps });
	await creationStarted.promise;
	const [capturedHandle] = stageControlRegistry.forRun(RUN_ID);
	assert.ok(capturedHandle);
	assert.equal(store.recordRunEnd(RUN_ID, "failed", undefined, "terminal during revival"), true);
	const terminalSnapshot = store.snapshot();
	const result = await send;

	assert.equal(result.status, "failed");
	if (result.status === "failed") {
		assert.equal(result.code, "WORKFLOW_TERMINAL");
		assert.equal(result.workflowStatus, "failed");
		assert.equal(result.error, result.message);
	}
	assert.equal(result.runId, RUN_ID);
	assert.match(result.message, new RegExp(`${RUN_ID}.*status failed`));
	assert.match(result.message, /start a new workflow/);
	assert.match(result.message, /small, deterministic, and low risk/);
	assert.doesNotMatch(result.message, /accepted|running|Prompt started|queued|sent|steered|resumed|answered/i);
	assert.equal(result.delivery, "rejected");
	assert.equal(creates, 1);
	assert.deepEqual(prompts, []);
	assert.equal(sdkMessageCalls, 0);
	assert.equal(disposes, 0);
	assert.equal(capturedHandle.isDisposed, true);
	assert.equal(stageControlRegistry.get(RUN_ID, "stage-a"), undefined);
	releaseCreation.resolve();
	await sessionDisposed.promise;
	assert.equal(disposes, 1);
	assert.deepEqual(readFileSync(sessionFile), transcriptBefore);
	assert.equal(existsSync(sideEffectPath), false);
	assert.deepEqual(store.snapshot(), terminalSnapshot);
});

test("terminal publication does not revoke a turn already admitted to the SDK", async () => {
	const sessionFile = retainedSession();
	store.recordRunStart({
		id: RUN_ID,
		name: "send-admitted-race",
		inputs: {},
		status: "running",
		stages: [
			{
				id: "stage-a",
				name: "completed stage",
				status: "completed",
				parentIds: [],
				toolEvents: [],
				attachable: true,
				sessionFile,
			},
		],
		startedAt: 1,
	});
	const promptStarted = Promise.withResolvers<void>();
	const finishPrompt = Promise.withResolvers<void>();
	const prompts: string[] = [];
	let disposes = 0;
	const session: StageSessionRuntime = {
		...mockSession(),
		sessionFile,
		async prompt(text: string) {
			prompts.push(text);
			promptStarted.resolve();
			await finishPrompt.promise;
		},
		async dispose() {
			disposes += 1;
		},
	};
	const resolvePostMortemDeps = (): PostMortemStageChatDeps => ({
		registry: stageControlRegistry,
		adapters: {
			agentSession: {
				async create() {
					return session;
				},
			},
		},
		cwd: tempDir,
	});

	const send = workflowSendAction(
		{ runId: RUN_ID, stageId: "stage-a", text: "admitted work" },
		{ resolvePostMortemDeps },
	);
	await promptStarted.promise;
	assert.equal(store.recordRunEnd(RUN_ID, "failed", undefined, "terminal after admission"), true);
	finishPrompt.resolve();
	const result = await send;

	assert.equal(result.status, "ok");
	assert.equal(result.delivery, "prompt");
	assert.deepEqual(prompts, ["admitted work"]);
	assert.equal(disposes, 0);
	assert.ok(stageControlRegistry.get(RUN_ID, "stage-a"));
	assert.equal(store.runs().find((run) => run.id === RUN_ID)?.status, "failed");
});

test("terminal publication during awaited __resume revokes paused-root admission", async () => {
	store.recordRunStart({
		id: RUN_ID,
		name: "resume-race",
		inputs: {},
		status: "paused",
		stages: [
			{
				id: "stage-a",
				name: "paused stage",
				status: "paused",
				parentIds: [],
				toolEvents: [],
				attachable: true,
			},
		],
		startedAt: 1,
	});
	const resumeStarted = Promise.withResolvers<void>();
	const continueResume = Promise.withResolvers<void>();
	const resumeFinished = Promise.withResolvers<void>();
	let resumeMutations = 0;
	const runtime = {
		runId: RUN_ID,
		stageId: "stage-a",
		name: "paused stage",
		stageSnapshot: { status: "paused", sessionId: "paused-session" },
		state: {
			liveHandleReleased: false,
			waitingForStageChatTurn: false,
			resumeContinuationPending: false,
		},
		innerCtx: {
			__sessionMeta: () => ({ sessionId: "paused-session", sessionFile: undefined }),
			__isPaused: () => true,
			subscribe: () => () => {},
			async __resume(
				_message: string | undefined,
				_beforeResolve:
					| ((result: { releasedQueuedMessages: boolean; runnerOwnedDeliveryPending: boolean }) => void)
					| undefined,
				beforeRelease: (() => void) | undefined,
			) {
				resumeStarted.resolve();
				try {
					await continueResume.promise;
					beforeRelease?.();
					resumeMutations += 1;
					return { releasedQueuedMessages: false, runnerOwnedDeliveryPending: false };
				} finally {
					resumeFinished.resolve();
				}
			},
		},
		activeStore: {
			recordStageResumed() {
				resumeMutations += 1;
				return true;
			},
			recordRunResumed() {
				resumeMutations += 1;
			},
		},
		throwIfStageMutationBlocked() {},
		captureStageSessionMeta() {},
		async releaseLiveHandle() {},
	};
	stageControlRegistry.register(createStageControlHandle(runtime as never));

	const send = workflowSendAction({
		runId: RUN_ID,
		stageId: "stage-a",
		text: "resume late",
		delivery: "resume",
	});
	await resumeStarted.promise;
	assert.equal(store.recordRunEnd(RUN_ID, "failed", undefined, "terminal during resume"), true);
	const terminalSnapshot = store.snapshot();
	const result = await send;

	assert.equal(result.status, "failed");
	assert.equal(result.delivery, "rejected");
	assert.equal(resumeMutations, 0);
	assert.deepEqual(store.snapshot(), terminalSnapshot);

	continueResume.resolve();
	await resumeFinished.promise;
	assert.equal(resumeMutations, 0);
	assert.deepEqual(store.snapshot(), terminalSnapshot);
});

test("a handle without admission-aware send never enters the legacy fallback", async () => {
	store.recordRunStart({
		id: RUN_ID,
		name: "legacy-fallback-race",
		inputs: {},
		status: "running",
		stages: [
			{
				id: "stage-a",
				name: "legacy stage",
				status: "running",
				parentIds: [],
				toolEvents: [],
				attachable: true,
			},
		],
		startedAt: 1,
	});
	const fallbackStarted = Promise.withResolvers<void>();
	const neverFinishFallback = Promise.withResolvers<void>();
	let fallbackMutations = 0;
	stageControlRegistry.register({
		runId: RUN_ID,
		stageId: "stage-a",
		stageName: "legacy stage",
		status: "running",
		sessionId: "legacy-session",
		sessionFile: undefined,
		isStreaming: false,
		messages: [],
		async ensureAttached() {},
		async prompt() {
			fallbackStarted.resolve();
			await neverFinishFallback.promise;
			fallbackMutations += 1;
		},
		async steer() {
			fallbackMutations += 1;
		},
		async followUp() {
			fallbackMutations += 1;
		},
		async pause() {},
		async resume() {
			return undefined;
		},
		subscribe() {
			return () => {};
		},
	});

	const send = workflowSendAction({
		runId: RUN_ID,
		stageId: "stage-a",
		text: "must not use an unsafe fallback",
	});
	const first = await Promise.race([
		send.then((result) => ({ kind: "result" as const, result })),
		fallbackStarted.promise.then(() => ({ kind: "fallback" as const })),
	]);

	assert.equal(first.kind, "result");
	if (first.kind !== "result") return;
	assert.equal(first.result.status, "noop");
	assert.match(first.result.message, /does not support admission-aware message delivery/);
	assert.equal(fallbackMutations, 0);
	assert.equal(store.recordRunEnd(RUN_ID, "failed", undefined, "terminal after rejection"), true);
	assert.equal(fallbackMutations, 0);
});

test("replacement revokes provisional admission and settles its send lease", async () => {
	store.recordRunStart({
		id: RUN_ID,
		name: "replacement-race",
		inputs: {},
		status: "running",
		stages: [
			{
				id: "stage-a",
				name: "replaceable stage",
				status: "running",
				parentIds: [],
				toolEvents: [],
				attachable: true,
			},
		],
		startedAt: 1,
	});
	const deliverySetup = Promise.withResolvers<void>();
	const continueDelivery = Promise.withResolvers<void>();
	const disposeStarted = Promise.withResolvers<void>();
	const finishDispose = Promise.withResolvers<void>();
	let deliveryMutations = 0;
	let disposes = 0;
	const provisional = {
		runId: RUN_ID,
		stageId: "stage-a",
		stageName: "replaceable stage",
		status: "running" as const,
		sessionId: "provisional-session",
		sessionFile: undefined,
		isStreaming: false,
		messages: [],
		async ensureAttached() {},
		async sendUserMessage(_text: string, _options: object | undefined, beforeDelivery?: () => void) {
			deliverySetup.resolve();
			await continueDelivery.promise;
			beforeDelivery?.();
			deliveryMutations += 1;
			return "prompt" as const;
		},
		async prompt() {
			return undefined;
		},
		async steer() {},
		async followUp() {},
		async pause() {},
		async resume() {
			return undefined;
		},
		subscribe() {
			return () => {};
		},
		async dispose() {
			disposes += 1;
			disposeStarted.resolve();
			await finishDispose.promise;
		},
	};
	const ownerLease = stageControlRegistry.acquireDetached(RUN_ID, "stage-a", () => provisional);
	const send = workflowSendAction({ runId: RUN_ID, stageId: "stage-a", text: "racing message" });
	await deliverySetup.promise;
	const replacement = { ...provisional, sessionId: "replacement-session", dispose: undefined };

	stageControlRegistry.register(replacement);
	await disposeStarted.promise;
	continueDelivery.resolve();
	let sendSettled = false;
	void send.then(() => {
		sendSettled = true;
	});
	await Promise.resolve();

	assert.equal(deliveryMutations, 0);
	assert.equal(sendSettled, false);
	assert.equal(stageControlRegistry.get(RUN_ID, "stage-a"), replacement);
	finishDispose.resolve();
	const result = await send;
	await ownerLease.release();

	assert.equal(result.status, "noop");
	assert.match(result.message, /Stage handle changed before message admission/);
	assert.equal(deliveryMutations, 0);
	assert.equal(disposes, 1);
	assert.equal(stageControlRegistry.get(RUN_ID, "stage-a"), replacement);
});
