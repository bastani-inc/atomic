import type { AgentSessionEvent } from "@bastani/atomic";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
import { createStageControlHandle } from "../../packages/workflows/src/runs/foreground/executor-stage-control.js";
import {
	assert,
	createStore,
	deriveGraphTheme,
	makeHandle,
	makeTestTui,
	StageChatView,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

test("a stage publishes a model switch it announced between two sessions, and clears it on the next request (#5572)", () => {
	let emit: ((event: AgentSessionEvent) => void) | undefined;
	const handle = createStageControlHandle({
		innerCtx: {
			__agentSession: () => undefined,
			subscribe(listener: (event: AgentSessionEvent) => void) {
				emit = listener;
				return () => {};
			},
		},
	} as never);
	const switchModel = {
		type: "model_fallback_start",
		from: "primary",
		to: "fallback",
		reason: "not found",
		attempt: 1,
	} as const;
	assert.ok(emit);
	emit(switchModel);
	assert.equal(handle.modelSwitch, switchModel);
	emit({ type: "agent_start" });
	assert.equal(handle.modelSwitch, undefined);
});

for (const [failure, eventType, expected] of [
	["529 overloaded_error: Overloaded", "auto_retry_start", "retrying…"],
	["404 model not found", "model_fallback_start", "switching model…"],
] as const) {
	test(`reopening a stage chat during ${eventType} preserves its ${expected} line (#5572)`, async () => {
		const h = await createHarness({
			provider: "faux",
			models: [{ id: "primary" }, { id: "fallback" }],
			settings: { fallbackModels: ["faux/fallback"], retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 } },
		});
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: failure }),
			fauxAssistantMessage("done"),
		]);
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const { handle, state, emit } = makeHandle(undefined, h.session.messages, "running", h.session);
		const open = () =>
			new StageChatView({
				store,
				graphTheme: deriveGraphTheme({}),
				runId: "run-1",
				stageId: "stage-a",
				workflowName: "test",
				handle,
				onDetach() {},
				onClose() {},
				piTui: makeTestTui(30),
			});
		let view = open();
		const line = () =>
			view
				.render(80)
				.map(stripAnsi)
				.find((row) => row.includes("∀"))
				?.trim();
		const atWait = Promise.withResolvers<void>();
		const off = h.session.subscribe((event) => {
			state.isStreaming = h.session.isStreaming;
			emit(event);
			if (event.type === eventType) atWait.resolve();
		});
		const prompt = h.session.prompt("hello");
		try {
			await atWait.promise;
			assert.equal(line(), `∀ ${expected}`);
			view.dispose();
			view = open();
			assert.equal(line(), `∀ ${expected}`);
		} finally {
			off();
			view.dispose();
			h.session.abortRetry();
			await prompt;
			await h.cleanup();
		}
	});
}
