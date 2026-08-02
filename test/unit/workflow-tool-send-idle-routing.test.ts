import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
import {
	type StageControlHandle,
	stageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";

const runIds = new Set<string>();

afterEach(() => {
	stageControlRegistry.clear();
	for (const runId of runIds) store.removeRun(runId);
	runIds.clear();
});

function liveHandle(input: {
	readonly runId: string;
	readonly streaming: boolean;
	readonly calls: string[];
	readonly status?: StageControlHandle["status"];
	readonly runStatus?: "running" | "paused";
}): StageControlHandle {
	runIds.add(input.runId);
	store.recordRunStart({
		id: input.runId,
		name: "idle-routing",
		inputs: {},
		status: input.runStatus ?? "running",
		stages: [],
		startedAt: 1,
	});
	store.recordStageStart(input.runId, {
		id: "stage-a",
		name: "chat",
		status: input.status === "paused" ? "paused" : "running",
		parentIds: [],
		toolEvents: [],
	});
	const handle: StageControlHandle = {
		runId: input.runId,
		stageId: "stage-a",
		stageName: "chat",
		status: input.status ?? "running",
		sessionId: "session-a",
		sessionFile: undefined,
		isStreaming: input.streaming,
		messages: [],
		async ensureAttached() {},
		async sendUserMessage(text, options, beforeDelivery) {
			beforeDelivery?.();
			if (!input.streaming) {
				input.calls.push(`prompt:${text}`);
				return "prompt";
			}
			const delivery = options?.deliverAs ?? "followUp";
			input.calls.push(`${delivery}:${text}`);
			return delivery;
		},
		async prompt(text) {
			input.calls.push(`prompt:${text}`);
		},
		async steer(text) {
			input.calls.push(`steer:${text}`);
		},
		async followUp(text) {
			input.calls.push(`followUp:${text}`);
		},
		async pause() {},
		async resume(text, beforeResume) {
			beforeResume?.();
			input.calls.push(`resume:${text ?? ""}`);
		},
		subscribe() {
			return () => {};
		},
	};
	stageControlRegistry.register(handle);
	return handle;
}

describe("workflow send — idle-aware live-stage routing", () => {
	for (const delivery of ["auto", "followUp"] as const) {
		test(`idle ${delivery} starts a prompt and reports the actual action`, async () => {
			const runId = testRunId(`idle-${delivery}`);
			const calls: string[] = [];
			liveHandle({ runId, streaming: false, calls });

			const result = await workflowSendAction({
				runId,
				stageId: "stage-a",
				text: "continue now",
				delivery,
			});

			assert.deepEqual(calls, ["prompt:continue now"]);
			assert.deepEqual(result, {
				action: "send",
				runId,
				stageId: "stage-a",
				delivery: "prompt",
				status: "ok",
				message: "Prompt started for stage.",
			});
		});
	}

	test("explicit idle prompt preserves its established response string", async () => {
		const runId = testRunId("explicit-idle-prompt");
		const calls: string[] = [];
		liveHandle({ runId, streaming: false, calls });

		const result = await workflowSendAction({
			runId,
			stageId: "stage-a",
			text: "explicit prompt",
			delivery: "prompt",
		});

		assert.deepEqual(calls, ["prompt:explicit prompt"]);
		assert.equal(result.delivery, "prompt");
		assert.equal(result.status, "ok");
		assert.equal(result.message, "Prompt sent to stage.");
	});

	test("paused root resume preserves its established response string", async () => {
		const runId = testRunId("ordinary-resume");
		const calls: string[] = [];
		liveHandle({ runId, streaming: false, calls, status: "paused", runStatus: "paused" });
		assert.equal(store.runs().find((run) => run.id === runId)?.status, "paused");

		const result = await workflowSendAction({
			runId,
			stageId: "stage-a",
			text: "resume normally",
			delivery: "resume",
		});

		assert.deepEqual(calls, ["resume:resume normally"]);
		assert.equal(result.delivery, "resume");
		assert.equal(result.status, "ok");
		assert.equal(result.message, "Resumed interrupted stage with message.");
	});

	test("resume against a running stage is a truthful noop", async () => {
		const runId = testRunId("running-resume-noop");
		const calls: string[] = [];
		liveHandle({ runId, streaming: false, calls });

		const result = await workflowSendAction({
			runId,
			stageId: "stage-a",
			text: "must not be discarded",
			delivery: "resume",
		});

		assert.deepEqual(calls, []);
		assert.equal(result.delivery, "resume");
		assert.equal(result.status, "noop");
		assert.equal(result.message, "Stage is not paused; no resume message was delivered.");
	});

	test("explicit sends cannot bypass a paused stage", async () => {
		const runId = testRunId("paused-follow-up-noop");
		const calls: string[] = [];
		liveHandle({ runId, streaming: false, calls, status: "paused" });

		const result = await workflowSendAction({
			runId,
			stageId: "stage-a",
			text: "must wait for resume",
			delivery: "followUp",
		});

		assert.deepEqual(calls, []);
		assert.equal(result.delivery, "followUp");
		assert.equal(result.status, "noop");
		assert.equal(result.message, "Stage is paused; resume it before sending a new message.");
	});

	test("streaming followUp queues without starting a concurrent prompt", async () => {
		const runId = testRunId("streaming-follow-up");
		const calls: string[] = [];
		liveHandle({ runId, streaming: true, calls });

		const result = await workflowSendAction({
			runId,
			stageId: "stage-a",
			text: "after this turn",
			delivery: "followUp",
		});

		assert.deepEqual(calls, ["followUp:after this turn"]);
		assert.equal(result.delivery, "followUp");
		assert.equal(result.message, "Follow-up queued for stage.");
	});

	test("streaming steer steers without starting a concurrent prompt", async () => {
		const runId = testRunId("streaming-steer");
		const calls: string[] = [];
		liveHandle({ runId, streaming: true, calls });

		const result = await workflowSendAction({
			runId,
			stageId: "stage-a",
			text: "change direction",
			delivery: "steer",
		});

		assert.deepEqual(calls, ["steer:change direction"]);
		assert.equal(result.delivery, "steer");
		assert.equal(result.message, "Steered live stage.");
	});

	test("streaming auto selects steering, matching a manually typed message", async () => {
		const runId = testRunId("streaming-auto");
		const calls: string[] = [];
		liveHandle({ runId, streaming: true, calls });

		const result = await workflowSendAction({
			runId,
			stageId: "stage-a",
			text: "change direction",
			delivery: "auto",
		});

		assert.deepEqual(calls, ["steer:change direction"]);
		assert.equal(result.delivery, "steer");
	});

	test("sequential sends preserve submission order within each queue", async () => {
		const runId = testRunId("streaming-order");
		const calls: string[] = [];
		liveHandle({ runId, streaming: true, calls });

		for (const text of ["first steer", "second steer"]) {
			const result = await workflowSendAction({ runId, stageId: "stage-a", text, delivery: "steer" });
			assert.equal(result.delivery, "steer");
		}
		for (const text of ["first follow-up", "second follow-up"]) {
			const result = await workflowSendAction({ runId, stageId: "stage-a", text, delivery: "followUp" });
			assert.equal(result.delivery, "followUp");
		}

		// FIFO holds within each queue class. Nothing here asserts a global FIFO
		// across steering and follow-up: steering keeps semantic priority even
		// when a follow-up was submitted first.
		assert.deepEqual(calls, [
			"steer:first steer",
			"steer:second steer",
			"followUp:first follow-up",
			"followUp:second follow-up",
		]);
	});

	test("expanded root target sends to the hydrated child owner", async () => {
		const rootId = testRunId("hydrated-routing-root");
		const childId = testRunId("hydrated-routing-child");
		const calls: string[] = [];
		runIds.add(rootId);
		runIds.add(childId);
		store.recordRunStart({
			id: rootId,
			name: "root",
			inputs: {},
			status: "running",
			startedAt: 1,
			stages: [
				{
					id: "child-boundary",
					name: "workflow:child",
					status: "running",
					parentIds: [],
					toolEvents: [],
					attachable: false,
					workflowChildRun: { alias: "child", workflow: "child", runId: childId },
				},
			],
		});
		store.recordRunStart({
			id: childId,
			name: "child",
			inputs: {},
			status: "running",
			startedAt: 1,
			parentRunId: rootId,
			parentStageId: "child-boundary",
			rootRunId: rootId,
			stages: [{ id: "stage-a", name: "chat", status: "running", parentIds: [], toolEvents: [], attachable: true }],
		});
		stageControlRegistry.register({
			runId: childId,
			stageId: "stage-a",
			stageName: "chat",
			status: "running",
			sessionId: "session-a",
			sessionFile: undefined,
			isStreaming: false,
			messages: [],
			async ensureAttached() {},
			async sendUserMessage(text, _options, beforeDelivery) {
				beforeDelivery?.();
				calls.push(`prompt:${text}`);
				return "prompt";
			},
			async prompt(text) {
				calls.push(`prompt:${text}`);
			},
			async steer() {},
			async followUp() {},
			async pause() {},
			async resume() {},
			subscribe() {
				return () => {};
			},
		});

		const result = await workflowSendAction({
			runId: rootId,
			stageId: `${childId}:stage-a`,
			text: "child message",
			delivery: "prompt",
		});
		assert.deepEqual(calls, ["prompt:child message"]);
		assert.equal(result.runId, childId);
		assert.equal(result.stageId, "stage-a");
	});
});
