import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	isSessionStartTimeoutError,
	type SessionStartEventLoopSample,
	type SessionStartTimeoutError,
} from "../../packages/coding-agent/src/index.js";
import {
	SATURATED_LOOP_TURN_MS,
	SESSION_START_MIN_LOOP_TURNS,
	SessionStartBudget,
	START_PROBE_INTERVAL_MS,
	sessionStartPhase,
} from "../../packages/subagents/src/runs/inprocess/session-start-budget.js";

/** A budget long enough for several probe turns around one blocked turn. */
const BLOCKED_BUDGET_MS = 900;
/** One turn the main thread is held for: three probe intervals. */
const BLOCKED_TURN_MS = 3 * START_PROBE_INTERVAL_MS;

const idleLoop: SessionStartEventLoopSample = { turns: 3_000, meanTurnMs: START_PROBE_INTERVAL_MS, maxTurnMs: 104 };

describe("sessionStartPhase (#4319)", () => {
	test("names the admission wait, whatever the event loop did", () => {
		assert.equal(sessionStartPhase("awaiting-admission", idleLoop), "admission");
		assert.equal(
			sessionStartPhase("awaiting-admission", { turns: 1, meanTurnMs: 90_000, maxTurnMs: 90_000 }),
			"admission",
		);
	});

	test("names the step's own phase when the loop turned often enough for a start", () => {
		assert.equal(sessionStartPhase("opening-session", idleLoop), "setup");
		assert.equal(sessionStartPhase("loading-resources", idleLoop), "setup");
		assert.equal(sessionStartPhase("creating-session", idleLoop), "setup");
		assert.equal(sessionStartPhase("dispatching-task", idleLoop), "dispatch");
	});

	test("names the event loop when it turned too few and too slow turns for any start", () => {
		const starved = { turns: SESSION_START_MIN_LOOP_TURNS - 1, meanTurnMs: SATURATED_LOOP_TURN_MS, maxTurnMs: 400 };
		assert.equal(sessionStartPhase("creating-session", starved), "event-loop");
		assert.equal(sessionStartPhase("dispatching-task", starved), "event-loop");
		assert.equal(sessionStartPhase("creating-session", { ...starved, turns: SESSION_START_MIN_LOOP_TURNS }), "setup");
		assert.equal(
			sessionStartPhase("creating-session", { ...starved, meanTurnMs: SATURATED_LOOP_TURN_MS - 1 }),
			"setup",
		);
	});

	test("keeps the measured #4319 case, many slow turns, on the step that took them", () => {
		assert.equal(sessionStartPhase("creating-session", { turns: 1_190, meanTurnMs: 252, maxTurnMs: 260 }), "setup");
	});

	test("derives its thresholds from the probe interval", () => {
		assert.equal(START_PROBE_INTERVAL_MS, 100);
		assert.equal(SATURATED_LOOP_TURN_MS, 200);
		assert.equal(SESSION_START_MIN_LOOP_TURNS, 100);
	});
});

describe("SessionStartBudget (#4319)", () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
		});
		// A clock that is not at zero, as no real one is.
		vi.advanceTimersByTime(5_000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function expiry(budget: SessionStartBudget): SessionStartTimeoutError {
		const reason: unknown = budget.signal.reason;
		assert.ok(isSessionStartTimeoutError(reason), String(reason));
		return reason;
	}

	test("aborts its signal with a typed timeout naming the step, its timings and the loop's turns", () => {
		const budget = new SessionStartBudget("subagent worker_1 (id run:0)", 1_000, "opening-session");
		vi.advanceTimersByTime(150);
		budget.enter("loading-resources");
		vi.advanceTimersByTime(250);
		budget.enter("creating-session");
		vi.advanceTimersByTime(599);
		assert.equal(budget.signal.aborted, false);
		vi.advanceTimersByTime(1);

		assert.equal(budget.signal.aborted, true);
		assert.equal(vi.getTimerCount(), 0);
		const error = expiry(budget);
		assert.equal(error.subject, "subagent worker_1 (id run:0)");
		assert.equal(error.phase, "setup");
		assert.equal(error.step, "creating-session");
		assert.equal(error.timeoutMs, 1_000);
		assert.equal(error.elapsedMs, 1_000);
		assert.equal(error.stepElapsedMs, 600);
		assert.deepEqual(error.steps, [
			{ step: "opening-session", elapsedMs: 150 },
			{ step: "loading-resources", elapsedMs: 250 },
			{ step: "creating-session", elapsedMs: 600 },
		]);
		assert.deepEqual(error.eventLoop, { turns: 9, meanTurnMs: 100, maxTurnMs: 100 });
	});

	test("records the admission wait as its own step inside session creation", () => {
		const budget = new SessionStartBudget("child", 500, "creating-session");
		vi.advanceTimersByTime(40);
		budget.admissionWait(true);
		vi.advanceTimersByTime(100);
		budget.admissionWait(false);
		vi.advanceTimersByTime(60);
		budget.admissionWait(true);
		vi.advanceTimersByTime(300);

		const error = expiry(budget);
		assert.equal(error.phase, "admission");
		assert.equal(error.step, "awaiting-admission");
		assert.equal(error.stepElapsedMs, 300);
		assert.deepEqual(error.steps, [
			{ step: "creating-session", elapsedMs: 40 },
			{ step: "awaiting-admission", elapsedMs: 100 },
			{ step: "creating-session", elapsedMs: 60 },
			{ step: "awaiting-admission", elapsedMs: 300 },
		]);
	});

	test("keeps timing a step it enters again", () => {
		const budget = new SessionStartBudget("child", 300, "opening-session");
		vi.advanceTimersByTime(100);
		budget.enter("opening-session");
		vi.advanceTimersByTime(200);
		assert.deepEqual(expiry(budget).steps, [{ step: "opening-session", elapsedMs: 300 }]);
	});

	test("names dispatch when the task was still being dispatched", () => {
		const budget = new SessionStartBudget("child", 200, "creating-session");
		vi.advanceTimersByTime(50);
		budget.enter("dispatching-task");
		vi.advanceTimersByTime(150);
		const error = expiry(budget);
		assert.equal(error.phase, "dispatch");
		assert.equal(error.step, "dispatching-task");
	});

	test("reports the whole budget as one turn when the probe never turned", () => {
		const budget = new SessionStartBudget("child", 50, "opening-session");
		vi.advanceTimersByTime(50);
		assert.deepEqual(expiry(budget).eventLoop, { turns: 0, meanTurnMs: 50, maxTurnMs: 50 });
	});

	test.each(["creating-session", "dispatching-task", "awaiting-admission"] as const)(
		"includes the final blocked interval after a probe while %s",
		(step) => {
			const startedAt = performance.now();
			const budget = new SessionStartBudget("child", 150, step);
			vi.advanceTimersByTime(START_PROBE_INTERVAL_MS);
			const clock = vi.spyOn(performance, "now").mockReturnValue(startedAt + 1_000);
			try {
				vi.advanceTimersByTime(50);
				const error = expiry(budget);
				assert.deepEqual(error.eventLoop, { turns: 1, meanTurnMs: 500, maxTurnMs: 900 });
				assert.equal(error.phase, step === "awaiting-admission" ? "admission" : "event-loop");
				assert.equal(error.step, step);
				assert.equal(error.elapsedMs, 1_000);
			} finally {
				clock.mockRestore();
				budget.end();
			}
		},
	);

	test("never fires once ended, whatever steps follow", () => {
		const budget = new SessionStartBudget("child", 100, "opening-session");
		budget.end();
		budget.enter("creating-session");
		budget.admissionWait(true);
		vi.advanceTimersByTime(10_000);
		assert.equal(budget.signal.aborted, false);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("stops its timers when it expires", () => {
		const budget = new SessionStartBudget("child", 100, "opening-session");
		assert.equal(vi.getTimerCount(), 2);
		vi.advanceTimersByTime(100);
		assert.equal(budget.signal.aborted, true);
		assert.equal(vi.getTimerCount(), 0);
	});
});

describe("SessionStartBudget on a real event loop (#4319)", () => {
	test("reports the longest turn the loop took, however its turns varied", async () => {
		const budget = new SessionStartBudget("child", BLOCKED_BUDGET_MS, "creating-session");
		setTimeout(() => {
			const end = performance.now() + BLOCKED_TURN_MS;
			while (performance.now() < end) {
				// The main thread is held for one long turn.
			}
		}, START_PROBE_INTERVAL_MS + 50);
		await new Promise<void>((resolve) => budget.signal.addEventListener("abort", () => resolve(), { once: true }));
		const error = budget.signal.reason as SessionStartTimeoutError;
		assert.ok(error.eventLoop.maxTurnMs >= BLOCKED_TURN_MS, JSON.stringify(error.eventLoop));
		assert.ok(error.eventLoop.meanTurnMs < error.eventLoop.maxTurnMs, JSON.stringify(error.eventLoop));
	});
});
