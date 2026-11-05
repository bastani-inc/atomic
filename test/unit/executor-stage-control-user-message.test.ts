import assert from "node:assert/strict";
import { test } from "vitest";
import { createStageControlHandle } from "../../packages/workflows/src/runs/foreground/executor-stage-control.js";
import type { LiveStageRuntime } from "../../packages/workflows/src/runs/foreground/executor-stage-types.js";
import type { StageUserMessageDeliveryAction } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";

/** The smallest stage runtime a control handle needs to deliver user messages. */
function fakeRuntime(input: {
	readonly action?: StageUserMessageDeliveryAction;
	readonly admit?: boolean;
	readonly queue?: () => Promise<boolean>;
}) {
	const state = { latestUserMessage: "earlier message" } as LiveStageRuntime["state"];
	const seenDuringDelivery: Array<string | undefined> = [];
	const queuedKinds: string[] = [];
	const innerCtx = {
		subscribe: () => () => {},
		isStreaming: true,
		__agentSession: () => ({ isStreaming: true }),
		__turnLoopBusy: () => true,
		__sessionMeta: () => ({ sessionId: "session", sessionFile: undefined }),
		async __sendUserMessage(_text: unknown, _options: unknown, admit?: () => void) {
			if (input.admit !== false) admit?.();
			seenDuringDelivery.push(state.latestUserMessage);
			return input.action ?? "prompt";
		},
		__queueIntoLiveTurn: async (_text: string, kind: string) => {
			queuedKinds.push(kind);
			const queued = await (input.queue ?? (async () => true))();
			seenDuringDelivery.push(state.latestUserMessage);
			return queued;
		},
	};
	const runtime = {
		runId: "run",
		stageId: "stage",
		name: "stage",
		stageSnapshot: { status: "running", sessionId: "session" },
		state,
		innerCtx,
		throwIfStageMutationBlocked: () => {},
		captureStageSessionMeta: async () => {},
	} as unknown as LiveStageRuntime;
	return { handle: createStageControlHandle(runtime), state, seenDuringDelivery, queuedKinds };
}

for (const action of ["prompt", "steer", "followUp"] as const) {
	test(`a message delivered as ${action} is the user's message before its turn can end (#4358)`, async () => {
		const viaSend = fakeRuntime({ action });
		await viaSend.handle.sendUserMessage!("Also make the header bold.");
		assert.deepEqual(viaSend.seenDuringDelivery, ["Also make the header bold."]);
		assert.equal(viaSend.state.latestUserMessage, "Also make the header bold.");
	});
}

test("a prompt is remembered at admission, and a command the host handled is forgotten", async () => {
	const prompted = fakeRuntime({});
	await prompted.handle.prompt("Use green.");
	assert.deepEqual(prompted.seenDuringDelivery, ["Use green."]);
	assert.equal(prompted.state.latestUserMessage, "Use green.");
	const handledPrompt = fakeRuntime({ action: "handled" });
	await handledPrompt.handle.prompt("/compact");
	assert.equal(handledPrompt.state.latestUserMessage, "earlier message");
	const handledSend = fakeRuntime({ action: "handled" });
	await handledSend.handle.sendUserMessage!("/compact");
	assert.equal(handledSend.state.latestUserMessage, "earlier message");
	const notAdmitted = fakeRuntime({ admit: false });
	await notAdmitted.handle.sendUserMessage!("never admitted");
	assert.equal(notAdmitted.state.latestUserMessage, "earlier message");
	const notAdmittedPrompt = fakeRuntime({ admit: false });
	await notAdmittedPrompt.handle.prompt("never admitted");
	assert.equal(notAdmittedPrompt.state.latestUserMessage, "earlier message");
	const handledUnadmitted = fakeRuntime({ admit: false, action: "handled" });
	await handledUnadmitted.handle.prompt("/compact");
	await handledUnadmitted.handle.sendUserMessage!("/compact");
	assert.equal(handledUnadmitted.state.latestUserMessage, "earlier message");
});

for (const kind of ["steer", "followUp"] as const) {
	test(`a ${kind} is the user's message while it is queued, and is forgotten when queueing fails`, async () => {
		const queued = fakeRuntime({});
		await queued.handle[kind](`${kind} text`);
		assert.deepEqual(queued.seenDuringDelivery, [`${kind} text`]);
		assert.deepEqual(queued.queuedKinds, [kind]);
		assert.equal(queued.state.latestUserMessage, `${kind} text`);
		const failure = new Error("queue closed");
		const failed = fakeRuntime({
			queue: async () => {
				throw failure;
			},
		});
		await assert.rejects(failed.handle[kind]("lost"), (error: unknown) => error === failure);
		assert.equal(failed.state.latestUserMessage, "earlier message");
	});
}

test("an empty message keeps the previous one", async () => {
	const blank = fakeRuntime({});
	await blank.handle.sendUserMessage!("   ");
	assert.equal(blank.state.latestUserMessage, "earlier message");
});
