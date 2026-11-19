import assert from "node:assert/strict";
import type { CreateAgentSessionOptions } from "@bastani/atomic";
import { test } from "vitest";
import { registerCompletedStageIntercomAskRouter } from "../../packages/workflows/src/extension/completed-stage-intercom-ask.js";
import { buildRuntimeAdapters } from "../../packages/workflows/src/extension/wiring.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { sleep } from "../helpers/runtime.js";
import { mockSession } from "./executor-shared.js";

interface LateAskEvent {
	handled: boolean;
	completion?: Promise<void>;
	batch: boolean;
	workflowRunId: string;
	workflowStageId: string;
	messages: Array<{
		customType: "intercom_message";
		content: string;
		details: {
			from: { id: string };
			message: { id: string; expectsReply: true; content: { text: string } };
		};
	}>;
}

function askEvent(overrides: Partial<LateAskEvent> = {}): LateAskEvent {
	return {
		handled: false,
		batch: false,
		workflowRunId: "run-1",
		workflowStageId: "stage-a",
		messages: [
			{
				customType: "intercom_message",
				content: "**From B**\n\nReturn the exact summary",
				details: {
					from: { id: "stage-b-session" },
					message: { id: "ask-1", expectsReply: true, content: { text: "Return the exact summary" } },
				},
			},
		],
		...overrides,
	};
}

function eventHarness() {
	let listener: ((event: unknown) => void) | undefined;
	return {
		pi: {
			events: {
				on(_name: string, callback: (event: unknown) => void) {
					listener = callback;
					return () => {
						listener = undefined;
					};
				},
			},
		},
		emit(event: LateAskEvent) {
			listener?.(event);
			return event;
		},
	};
}

function completedHandle(
	prompt: (text: string) => Promise<void>,
	ensureAttached: () => Promise<void> = async () => {},
): StageControlHandle {
	return {
		runId: "run-1",
		stageId: "stage-a",
		stageName: "A",
		status: "completed",
		sessionId: "stage-a-session",
		sessionFile: "/tmp/stage-a.jsonl",
		isStreaming: false,
		messages: [],
		ensureAttached,
		prompt,
		steer: async () => {},
		followUp: async () => {},
		pause: async () => {},
		resume: async () => {},
		subscribe: () => () => {},
	};
}

test("completed-stage ask schedules one post-mortem turn with the exact inbound text", async () => {
	const harness = eventHarness();
	const prompts: string[] = [];
	registerCompletedStageIntercomAskRouter(harness.pi as never, () => ({
		ok: true,
		handle: completedHandle(async (text) => {
			prompts.push(text);
		}),
	}));

	const event = harness.emit(askEvent());
	assert.equal(event.handled, true);
	assert.ok(event.completion);
	await event.completion;
	assert.deepEqual(prompts, ["**From B**\n\nReturn the exact summary"]);
});

test.each(["producer", "stored record"] as const)(
	"a closed stage session’s late Intercom ask is not redirected after replacing its %s (#5577)",
	async (replace) => {
		const harness = eventHarness();
		const store = createStore();
		const broker = new StageUiBroker(store);
		const runId = "run-1",
			stageId = "stage-a";
		store.recordRunStart({
			id: runId,
			name: "review",
			inputs: {},
			status: "completed",
			stages: [{ id: stageId, name: "s", status: "completed", parentIds: [], toolEvents: [] }],
			toolNodes: [],
			startedAt: 1,
		});
		const original = broker.claimStage(runId, stageId);
		let route: NonNullable<CreateAgentSessionOptions["orchestrationContext"]>["lateMessageRouter"];
		const adapters = buildRuntimeAdapters(
			{ events: { emit: (_, event) => harness.emit(event as unknown as LateAskEvent) } },
			{
				stageUiBroker: broker,
				createAgentSession: async (opts) => {
					route = opts?.orchestrationContext?.lateMessageRouter;
					return { session: mockSession() as never };
				},
			},
		);
		const prompts: string[] = [];
		const started = Promise.withResolvers<void>(),
			finish = Promise.withResolvers<void>();
		let waitForAttach = false;
		const stop = registerCompletedStageIntercomAskRouter(harness.pi, () => ({
			ok: true,
			handle: completedHandle(
				async (text) => {
					prompts.push(text);
				},
				async () => {
					if (waitForAttach) {
						started.resolve();
						await finish.promise;
					}
				},
			),
		}));
		try {
			await adapters.agentSession!.create({}, { runId, stageId, stageName: "s", stageUiSignal: original.signal });
			assert.ok(route);
			const message = { ...askEvent().messages[0]!, display: true };
			original.release();
			await route.routeMessage({ ...message, content: "still the original conversation" });
			waitForAttach = true;
			const inFlight = Promise.resolve(route.routeMessage(message));
			await started.promise;
			if (replace === "producer") broker.claimStage(runId, stageId).release();
			else store.recordRunStart(structuredClone(store.run(runId)!));
			finish.resolve();
			await assert.rejects(inFlight, /replaced/);
			await assert.rejects(async () => route!.routeMessages([message]), /replaced/);
			assert.deepEqual(prompts, ["still the original conversation"]);
		} finally {
			finish.resolve();
			stop();
			original.release();
		}
	},
);

test("concurrent duplicate wakeups serialize onto the retained completed conversation", async () => {
	const harness = eventHarness();
	const first = Promise.withResolvers<void>();
	const order: string[] = [];
	registerCompletedStageIntercomAskRouter(harness.pi as never, () => ({
		ok: true,
		handle: completedHandle(async (text) => {
			order.push(`start:${text}`);
			if (text === "first") await first.promise;
			order.push(`end:${text}`);
		}),
	}));

	const firstEvent = harness.emit(askEvent({ messages: [{ ...askEvent().messages[0]!, content: "first" }] }));
	const secondEvent = harness.emit(
		askEvent({
			messages: [
				{
					...askEvent().messages[0]!,
					content: "second",
					details: {
						...askEvent().messages[0]!.details,
						message: { ...askEvent().messages[0]!.details.message, id: "ask-2" },
					},
				},
			],
		}),
	);
	await sleep(0);
	assert.deepEqual(order, ["start:first"]);
	first.resolve();
	await Promise.all([firstEvent.completion, secondEvent.completion]);
	assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
});

test("deleted, invalid, non-resumable, and failed-to-attach targets reject promptly and actionably", async () => {
	const failedAttach = completedHandle(
		async () => {},
		async () => {
			throw new Error("session reopen failed");
		},
	);
	const disposed = { ...completedHandle(async () => {}), isDisposed: true };
	const cases = [
		{ result: undefined, expected: /deleted or is no longer retained/ },
		{ result: { ok: false as const, reason: "not_terminal" as const }, expected: /not resumable/ },
		{ result: { ok: false as const, reason: "no_session" as const }, expected: /has no retained conversation/ },
		{ result: { ok: false as const, reason: "invalid_session" as const }, expected: /missing, deleted, or invalid/ },
		{ result: { ok: false as const, reason: "no_adapter" as const }, expected: /not resumable/ },
		{ result: { ok: true as const, handle: disposed }, expected: /not resumable/ },
		{ result: { ok: true as const, handle: failedAttach }, expected: /session reopen failed/ },
	];
	for (const { result, expected } of cases) {
		const harness = eventHarness();
		registerCompletedStageIntercomAskRouter(harness.pi as never, () => result);
		const started = performance.now();
		const event = harness.emit(askEvent());
		assert.equal(event.handled, true);
		await assert.rejects(event.completion!, expected);
		assert.ok(performance.now() - started < 1_000, "failure must be bounded rather than waiting for ask timeout");
	}
});

test("ordinary completed-stage sends retain the existing late-message route", () => {
	const harness = eventHarness();
	registerCompletedStageIntercomAskRouter(harness.pi as never, () => {
		throw new Error("must not resolve");
	});
	const event = askEvent();
	event.messages[0]!.details.message.expectsReply = false as never;
	harness.emit(event);
	assert.equal(event.handled, false);
	assert.equal(event.completion, undefined);
});

for (const boundary of ["resolution", "attachment"] as const) {
	test(`disposing the completed-stage router during ${boundary} prevents delivery`, async () => {
		const harness = eventHarness();
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let prompts = 0;
		const wait = async () => {
			started.resolve();
			await finish.promise;
		};
		const handle = completedHandle(
			async () => {
				prompts++;
			},
			boundary === "attachment" ? wait : undefined,
		);
		const dispose = registerCompletedStageIntercomAskRouter(harness.pi, async () => {
			if (boundary === "resolution") await wait();
			return { ok: true, handle };
		});
		const event = harness.emit(askEvent());
		await started.promise;
		dispose();
		finish.resolve();
		await assert.rejects(event.completion!, /closed/);
		assert.equal(prompts, 0);
	});
}
