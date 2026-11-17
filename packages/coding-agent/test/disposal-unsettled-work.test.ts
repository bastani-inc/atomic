import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { SESSION_WORK_DRAIN_MS, SessionWorkUnsettledError } from "../src/core/session-lifecycle-work.js";
import { persistedManager } from "./helpers/detached-tools.js";
import { createHarness, type Harness } from "./suite/harness.js";

const NOTICE = { customType: "subagent-notify", content: "child finished", display: true } as const;
/** Bound on the event-loop turns until disposal has cancelled the session's work and started waiting for it. */
const UNTIL_DRAINING_TURNS = 10_000;

const harnesses: Harness[] = [];
afterEach(async () => {
	vi.useRealTimers();
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

test("disposal stops waiting for a session save that never settles after SESSION_WORK_DRAIN_MS, closes the session and reports the unsettled work", async () => {
	const { manager } = await persistedManager();
	const harness = await createHarness({ sessionManager: manager });
	harnesses.push({ ...harness, cleanup: () => harness.cleanup().catch(() => {}) });
	manager.appendCustomMessageEntry = (() => new Promise(() => {})) as typeof manager.appendCustomMessageEntry;
	const sent = harness.session.sendCustomMessage(NOTICE);
	void sent.catch(() => {});

	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const disposed = harness.session.dispose();
	const outcome = disposed.then(
		() => undefined,
		(error: unknown) => error,
	);
	for (let turn = 0; vi.getTimerCount() === 0 && turn < UNTIL_DRAINING_TURNS; turn++)
		await new Promise((resolve) => setImmediate(resolve));
	assert.ok(vi.getTimerCount() > 0, "disposal waits for the session's work with a bound");
	await vi.advanceTimersByTimeAsync(SESSION_WORK_DRAIN_MS);
	vi.useRealTimers();

	const error = await outcome;
	assert.ok(error instanceof AggregateError, String(error));
	assert.equal((error as AggregateError & { code?: string }).code, "ShutdownFailed");
	const unsettled = error.errors
		.map((entry: Error) => entry.cause)
		.find((cause): cause is SessionWorkUnsettledError => cause instanceof SessionWorkUnsettledError);
	assert.ok(unsettled, `the shutdown names the unsettled work: ${error.errors.map(String).join("; ")}`);
	assert.equal(unsettled.pending, 1);
	assert.equal(unsettled.waitedMs, SESSION_WORK_DRAIN_MS);
});
