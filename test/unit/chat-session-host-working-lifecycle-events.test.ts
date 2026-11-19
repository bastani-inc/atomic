// @ts-nocheck

import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { stripAnsi } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-utils.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
	installLifecycleFakeClock,
	makeLifecycleHost,
	workingLine,
} from "./chat-session-host-working-lifecycle-fixture.ts";

beforeAll(() => {
	initTheme("dark", false);
});

test("ChatSessionHost disposal is final for public agent-event application", () => {
	const previousRandom = Math.random;
	const timers = installLifecycleFakeClock();
	let randomSelections = 0;
	let renderRequests = 0;
	Math.random = () => {
		randomSelections += 1;
		return 0;
	};
	const host = makeLifecycleHost({
		isStreaming: () => true,
		requestRender: () => {
			renderRequests += 1;
		},
	});
	try {
		host.dispose();
		const baselineEntries = [...host.entries()];
		const baselineStatus = host.statusText();
		const baselinePending = host.renderPendingMessages(80);

		for (const event of [
			{ type: "turn_start" },
			{ type: "agent_start" },
			{ type: "queue_update", steering: ["must not persist"], followUp: ["nor this"] },
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 80, errorMessage: "network" },
			{ type: "message_start", message: { role: "assistant", content: [] } },
		]) {
			assert.equal(host.applyAgentEvent(event as never), false, event.type);
		}

		assert.equal(host.isStreaming(), false, "a disposed host ignores a true streaming override");
		assert.equal(host.hasAnimationTick(), false);
		assert.equal(host.isCompacting(), false);
		assert.equal(randomSelections, 0);
		assert.equal(renderRequests, 0);
		assert.deepEqual(host.entries(), baselineEntries);
		assert.equal(host.statusText(), baselineStatus);
		assert.deepEqual(host.renderPendingMessages(80), baselinePending);
		assert.deepEqual(host.renderWorkingStatus(80), []);
		assert.equal(timers.intervalCount(), 0);
		assert.equal(timers.timeoutCount(), 0);
	} finally {
		host.dispose();
		timers.restore();
		Math.random = previousRandom;
	}
});

test.each([
	[{ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1000, errorMessage: "busy" }, /retrying…/],
	[
		{ type: "model_fallback_start", from: "primary", to: "fallback", reason: "not found", attempt: 1 },
		/switching model…/,
	],
	[{ type: "agent_start" }, /Working…/],
] as const)(
	"a failed follow-up during $type leaves the working line beside the delivery warning (#5572)",
	async (event, status) => {
		const delivery = Promise.withResolvers<void>();
		const host = makeLifecycleHost({ commands: { send: () => delivery.promise } });
		try {
			host.applyAgentEvent(event);
			const sending = host.submit("followUp", "check the latest result");
			assert.match(workingLine(host), status);
			delivery.reject(new Error("message delivery not confirmed"));
			await sending;
			assert.match(host.renderBody(80, 8).map(stripAnsi).join("\n"), /message delivery not confirmed/);
			assert.match(workingLine(host), status);
		} finally {
			host.dispose();
		}
	},
);

test("successful retry and fallback stay ordinary-inactive until a genuine lifecycle start", () => {
	const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
	const previousRandom = Math.random;
	delete process.env.ATOMIC_REDUCED_MOTION;
	Math.random = () => 0;
	const cases = [
		{
			start: { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 80, errorMessage: "network" },
			factual: "retrying…",
			end: { type: "auto_retry_end", success: true, attempt: 1 },
			restart: { type: "agent_start" },
			restartedLine: " ∀ Working…",
		},
		{
			start: { type: "model_fallback_start", from: "a", to: "b", reason: "quota", attempt: 1 },
			factual: "switching model…",
			end: { type: "model_fallback_end", success: true, from: "a", to: "b" },
			restart: { type: "turn_start" },
			restartedLine: " ∀ Schlepping…",
		},
	] as const;

	try {
		for (const transition of cases) {
			const timers = installLifecycleFakeClock();
			let renderRequests = 0;
			const host = makeLifecycleHost({
				requestRender: () => {
					renderRequests += 1;
				},
			});
			try {
				host.applyAgentEvent({ type: "agent_start" } as never);
				host.applyAgentEvent({ type: "turn_start" } as never);
				timers.advanceBy(88);
				assert.equal(workingLine(host), " ∀ Schlepping…");

				const beforeFactualStart = renderRequests;
				host.applyAgentEvent(transition.start as never);
				assert.equal(renderRequests, beforeFactualStart + 1, `${transition.start.type} repaints immediately`);
				assert.equal(host.statusText(), transition.factual);
				// The factual copy is the working line while the retry or switch waits; it does not animate.
				assert.deepEqual(host.renderWorkingStatus(64).map(stripAnsi), ["", ` ∀ ${transition.factual}`.padEnd(64)]);
				assert.equal(host.hasAnimationTick(), false);
				assert.equal(timers.timeoutCount(), 0);
				timers.advanceBy(80);
				assert.equal(renderRequests, beforeFactualStart + 1);

				host.applyAgentEvent(transition.end as never);
				const afterSuccessfulEnd = renderRequests;
				assert.equal(host.statusText(), "");
				assert.deepEqual(host.renderWorkingStatus(64), [], "successful end cannot reveal the prior frame/message");
				assert.equal(host.hasAnimationTick(), false);
				assert.equal(timers.timeoutCount(), 0);
				timers.advanceBy(160);
				assert.equal(renderRequests, afterSuccessfulEnd);

				host.applyAgentEvent(transition.restart as never);
				assert.equal(workingLine(host), transition.restartedLine);
				assert.equal(host.hasAnimationTick(), true);
			} finally {
				host.dispose();
				timers.restore();
			}
		}
	} finally {
		Math.random = previousRandom;
		if (previousReducedMotion === undefined) delete process.env.ATOMIC_REDUCED_MOTION;
		else process.env.ATOMIC_REDUCED_MOTION = previousReducedMotion;
	}
});

test("an assistant start paints on the next frame while the turn animation keeps its cadence", () => {
	const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
	const previousRandom = Math.random;
	delete process.env.ATOMIC_REDUCED_MOTION;
	Math.random = () => 0;
	const timers = installLifecycleFakeClock();
	const paintedFrames: Array<string | undefined> = [];
	let host: ReturnType<typeof makeLifecycleHost>;
	host = makeLifecycleHost({
		requestRender: () => {
			paintedFrames.push(workingLine(host));
		},
	});
	try {
		assert.equal(host.applyAgentEvent({ type: "agent_start" } as never), true);
		assert.equal(host.applyAgentEvent({ type: "turn_start" } as never), true);
		assert.equal(
			host.applyAgentEvent({
				type: "message_start",
				message: { role: "assistant", content: [] },
			} as never),
			true,
		);

		assert.equal(host.entries().length, 1, "the assistant transcript entry updates immediately");
		assert.equal(host.entries()[0]?.role, "assistant");
		assert.deepEqual(
			paintedFrames,
			[" ∀ Working…", " ∀ Schlepping…", " ∀ Schlepping…"],
			"the assistant entry paints on the next frame, as the main chat paints each delta",
		);
		timers.advanceBy(88);
		assert.equal(paintedFrames.length, 4, "the turn animation keeps its 88ms cadence");
		assert.deepEqual(timers.timeoutDelays(), [], "no event throttle is registered");
	} finally {
		host.dispose();
		timers.restore();
		Math.random = previousRandom;
		if (previousReducedMotion === undefined) delete process.env.ATOMIC_REDUCED_MOTION;
		else process.env.ATOMIC_REDUCED_MOTION = previousReducedMotion;
	}
});

test("public interrupt stops the working lifecycle and fences its captured callback", async () => {
	const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
	delete process.env.ATOMIC_REDUCED_MOTION;
	const timers = installLifecycleFakeClock();
	let streaming = true;
	let renderRequests = 0;
	const host = makeLifecycleHost({
		isStreaming: () => streaming,
		commands: {
			interrupt: async () => {
				streaming = false;
			},
		},
		requestRender: () => {
			renderRequests += 1;
		},
	});
	try {
		host.applyAgentEvent({ type: "agent_start" } as never);
		assert.equal(host.hasAnimationTick(), true);
		assert.deepEqual(timers.activeIntervalDelays(), [88]);
		assert.match(workingLine(host) ?? "", /^ ∀ /);
		const interruptedTick = timers.capturedAnimationCallbacks().at(-1)!;

		await host.interrupt();

		assert.equal(host.isStreaming(), false);
		assert.equal(host.hasAnimationTick(), false);
		assert.deepEqual(timers.activeIntervalDelays(), []);
		assert.deepEqual(host.renderWorkingStatus(64), []);
		const afterInterrupt = renderRequests;
		interruptedTick();
		timers.advanceBy(176);
		assert.equal(renderRequests, afterInterrupt, "interrupted lifecycle callback cannot repaint");
	} finally {
		host.dispose();
		timers.restore();
		if (previousReducedMotion === undefined) delete process.env.ATOMIC_REDUCED_MOTION;
		else process.env.ATOMIC_REDUCED_MOTION = previousReducedMotion;
	}
});

test("turn and terminal stops repaint immediately and leave no delayed repaint", () => {
	const stopCases = [
		// The retry still waits after the turn ends, so its factual working line stays.
		{
			name: "turn_end",
			stop: (host) => host.applyAgentEvent({ type: "turn_end" } as never),
			after: ["", " ∀ retrying…".padEnd(64)],
		},
		{
			name: "agent_end",
			stop: (host) => host.applyAgentEvent({ type: "agent_end", messages: [] } as never),
			after: ["", " ∀ Worked for 0s".padEnd(64)],
		},
	] as const;

	for (const stopCase of stopCases) {
		const timers = installLifecycleFakeClock();
		let renderRequests = 0;
		const host = makeLifecycleHost({
			requestRender: () => {
				renderRequests += 1;
			},
		});
		try {
			host.applyAgentEvent({ type: "agent_start" } as never);
			host.applyAgentEvent({ type: "auto_retry_start" } as never);
			const beforeQueue = renderRequests;
			host.applyAgentEvent({ type: "queue_update", steering: ["pending"] } as never);
			assert.equal(renderRequests, beforeQueue + 1, `${stopCase.name}: the queue paints on the next frame`);
			assert.equal(timers.timeoutCount(), 0, stopCase.name);
			const beforeStop = renderRequests;

			stopCase.stop(host);
			assert.equal(renderRequests, beforeStop + 1, `${stopCase.name} cleanup repaints immediately`);
			assert.equal(timers.timeoutCount(), 0, stopCase.name);
			assert.equal(timers.intervalCount(), 0, stopCase.name);
			assert.equal(host.hasAnimationTick(), false, stopCase.name);
			assert.deepEqual(host.renderWorkingStatus(64).map(stripAnsi), stopCase.after, stopCase.name);

			timers.advanceBy(160);
			assert.equal(renderRequests, beforeStop + 1, `${stopCase.name} leaves no delayed repaint`);
		} finally {
			host.dispose();
			timers.restore();
		}
	}
});

test("non-reduced in-flight host construction first renders the regular pulse phase", () => {
	const previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
	delete process.env.ATOMIC_REDUCED_MOTION;
	const timers = installLifecycleFakeClock();
	let renderRequests = 0;
	const host = makeLifecycleHost({
		isStreaming: () => true,
		requestRender: () => {
			renderRequests += 1;
		},
	});
	try {
		assert.equal(workingLine(host), " ∀ Working…");
		assert.deepEqual(timers.intervalDelays(), [88]);
		assert.equal(renderRequests, 0, "construction is not a synthetic lifecycle event");
		timers.advanceBy(88);
		assert.equal(workingLine(host), " ∀ Working…");
		assert.equal(renderRequests, 1);
	} finally {
		host.dispose();
		timers.restore();
		if (previousReducedMotion === undefined) delete process.env.ATOMIC_REDUCED_MOTION;
		else process.env.ATOMIC_REDUCED_MOTION = previousReducedMotion;
	}
});

test("delta-only message_update and thinking_delta events flip the token arrow down and count streaming tokens, and shrinking input after compaction updates the total (#5224)", () => {
	const previousRandom = Math.random;
	const timers = installLifecycleFakeClock();
	Math.random = () => 0;
	const host = makeLifecycleHost();
	try {
		host.applyAgentEvent({ type: "agent_start" } as never);
		host.applyAgentEvent({ type: "turn_start" } as never);
		host.applyAgentEvent({
			type: "message_start",
			message: { role: "assistant", content: [] },
		} as never);
		host.applyAgentEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a".repeat(400) },
		} as never);
		assert.equal(workingLine(host), " ∀ Schlepping… (0s · ↓ 100 tokens)");

		host.applyAgentEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "a".repeat(400) }],
				usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
			},
		} as never);
		host.applyAgentEvent({ type: "turn_end" } as never);
		host.applyAgentEvent({ type: "turn_start" } as never);
		assert.equal(workingLine(host), " ∀ Schlepping… (0s · ↑ 600 tokens)");

		host.applyAgentEvent({
			type: "message_start",
			message: { role: "assistant", content: [] },
		} as never);
		host.applyAgentEvent({
			type: "thinking_delta",
			delta: "b".repeat(80),
		} as never);
		assert.equal(workingLine(host), " ∀ Schlepping… (0s · ↓ 620 tokens)");

		host.applyAgentEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "b".repeat(80) }],
				usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
			},
		} as never);
		host.applyAgentEvent({ type: "agent_end", messages: [] } as never);
		assert.equal(host.renderWorkingStatus(64).map(stripAnsi)[1]?.trim(), "∀ Schlepped for 0s · ↓ 320 tokens");
	} finally {
		host.dispose();
		timers.restore();
		Math.random = previousRandom;
	}
});
