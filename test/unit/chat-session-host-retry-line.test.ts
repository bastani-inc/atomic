// @ts-nocheck

import assert from "node:assert/strict";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { makeLifecycleHost, stripAnsi } from "./chat-session-host-working-lifecycle-fixture.ts";

/** The working line at a width that fits the whole retry line. */
function workingLine(host): string | undefined {
	const line = host.renderWorkingStatus(100)[1];
	return line === undefined ? undefined : stripAnsi(line).trimEnd();
}

beforeAll(() => {
	initTheme("dark", false);
});
let previousReducedMotion: string | undefined;
beforeEach(() => {
	previousReducedMotion = process.env.ATOMIC_REDUCED_MOTION;
	delete process.env.ATOMIC_REDUCED_MOTION;
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	if (previousReducedMotion === undefined) delete process.env.ATOMIC_REDUCED_MOTION;
	else process.env.ATOMIC_REDUCED_MOTION = previousReducedMotion;
});

const timedOut = {
	type: "auto_retry_start",
	attempt: 2,
	maxAttempts: 3,
	delayMs: 4000,
	errorMessage: "Provider stream timed out after 300000ms without a new event (stream deadline exceeded)",
} as const;

test("a chat's retry line counts down to its next attempt, then reads Working… until the attempt starts", () => {
	let renders = 0;
	const host = makeLifecycleHost({
		commands: { interrupt: async () => {} },
		requestRender: () => {
			renders += 1;
		},
	});
	try {
		host.applyAgentEvent({ type: "agent_start" });
		host.applyAgentEvent(timedOut);
		assert.equal(workingLine(host), " ∀ Retrying · response timed out · attempt 2/3 in 4s   esc cancel");
		const before = renders;
		vi.advanceTimersByTime(1000);
		assert.ok(renders > before, "the line repaints itself while it waits");
		assert.equal(workingLine(host), " ∀ Retrying · response timed out · attempt 2/3 in 3s   esc cancel");
		vi.advanceTimersByTime(3000);
		assert.equal(workingLine(host), " ∀ Working…", "the next attempt is due");
		host.applyAgentEvent({ type: "agent_start" });
		assert.equal(workingLine(host), " ∀ Working…", "the attempt's own working line follows");
		assert.equal(host.statusText(), "");
	} finally {
		host.dispose();
	}
});

test("a chat names the key that cancels a retry only where Esc reaches it", () => {
	for (const [options, hint] of [
		[{}, false],
		[{ commands: { interrupt: async () => {} } }, true],
		[{ commands: { interrupt: async () => {} }, canCancelRetry: () => false }, false],
		[{ canCancelRetry: () => true }, true],
	] as const) {
		const host = makeLifecycleHost(options);
		try {
			host.applyAgentEvent(timedOut);
			assert.equal(
				workingLine(host),
				` ∀ Retrying · response timed out · attempt 2/3 in 4s${hint ? "   esc cancel" : ""}`,
				JSON.stringify(Object.keys(options)),
			);
		} finally {
			host.dispose();
		}
	}
});

test("a chat retrying a summary names the summary, and no key: Esc interrupts the turn, not the summary", () => {
	const host = makeLifecycleHost({ commands: { interrupt: async () => {} } });
	try {
		host.applyAgentEvent({
			type: "summarization_retry_scheduled",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 2000,
			errorMessage: "429 Too Many Requests",
		});
		assert.equal(workingLine(host), " ∀ Retrying summary · rate limited · attempt 1/3 in 2s");
		host.applyAgentEvent({ type: "summarization_retry_attempt_start", source: "branchSummary" });
		assert.doesNotMatch(workingLine(host) ?? "", /Retrying/);
	} finally {
		host.dispose();
	}
});
