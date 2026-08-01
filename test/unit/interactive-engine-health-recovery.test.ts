import assert from "node:assert/strict";
import { test } from "vitest";
import {
	type ActivityWatchdogDiagnostic,
	ENGINE_UNRESPONSIVE_MS,
} from "../../packages/coding-agent/src/modes/interactive-engine/activity-watchdog.ts";
import type { InteractiveEngineGenerationEnded } from "../../packages/coding-agent/src/modes/interactive-engine/engine-generation.ts";
import {
	EngineHealthController,
	formatUnexpectedEngineLossNotice,
	UNEXPECTED_ENGINE_LOSS_NOTICE,
	UNRESPONSIVE_ENGINE_NOTICE,
} from "../../packages/coding-agent/src/modes/interactive-engine/engine-health.ts";
import { sleep } from "../helpers/runtime.js";

function ended(overrides?: Partial<InteractiveEngineGenerationEnded>): InteractiveEngineGenerationEnded {
	return {
		generation: 1,
		error: new Error("Agent process exited (code=null signal=SIGKILL). Stderr: "),
		kind: "exit",
		expected: false,
		...overrides,
	};
}

interface Harness {
	controller: EngineHealthController;
	diagnostics: ActivityWatchdogDiagnostic[];
	stops: number;
	restarts: number;
	activityClears: number;
	/** Move the injected clock forward without sleeping. */
	advance(ms: number): void;
}

function harness(restart: () => Promise<void>): Harness {
	const state = { stops: 0, restarts: 0, activityClears: 0 } as Omit<
		Harness,
		"controller" | "diagnostics" | "advance"
	>;
	const diagnostics: ActivityWatchdogDiagnostic[] = [];
	let clock = 1_000;
	const controller = new EngineHealthController(
		{
			stop: async () => {
				state.stops += 1;
			},
			restart: () => {
				state.restarts += 1;
				return restart();
			},
			clearActivity: () => {
				state.activityClears += 1;
			},
		},
		{ now: () => clock },
	);
	controller.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
	return Object.assign(state, {
		controller,
		diagnostics,
		advance: (ms: number) => {
			clock += ms;
		},
	}) as Harness;
}

const watchdogUnresponsive: ActivityWatchdogDiagnostic = {
	activity: undefined,
	elapsedMs: 1_011,
	level: "unresponsive",
	message: "Engine callback tool.execute bash has not yielded for 1011 ms; Esc interrupt · Ctrl+C terminate",
	source: "watchdog",
};

test("an expected generation loss clears activity and never restarts", async () => {
	const h = harness(async () => {});
	h.controller.handleGenerationEnded(ended({ expected: true, kind: "explicit-stop" }));
	await sleep(5);
	assert.equal(h.activityClears, 1);
	assert.equal(h.restarts, 0);
	assert.deepEqual(h.diagnostics, []);
});

test("an unexpected generation loss runs exactly one automatic restart with a calm notice", async () => {
	let resolveRestart!: () => void;
	const h = harness(
		() =>
			new Promise<void>((resolve) => {
				resolveRestart = resolve;
			}),
	);
	h.controller.handleGenerationEnded(ended());
	assert.equal(h.controller.isRecovering(), true);
	// A second death while the attempt is in flight must not start another engine.
	h.controller.handleGenerationEnded(ended({ generation: 2 }));
	assert.equal(h.restarts, 1);
	assert.deepEqual(
		h.diagnostics.map((d) => d.message),
		[`${UNEXPECTED_ENGINE_LOSS_NOTICE} Cause (exit): Agent process exited (code=null signal=SIGKILL).`],
	);
	assert.equal(h.diagnostics[0]!.source, "recovery");
	assert.equal(h.diagnostics[0]!.level, "blocking");
	resolveRestart();
	await sleep(5);
	assert.equal(h.controller.isRecovering(), false);
});

test("unexpected-loss diagnostics retain the exit cause without exposing child stderr", () => {
	assert.equal(
		formatUnexpectedEngineLossNotice(
			ended({
				error: new Error(
					"Agent process exited (code=1 signal=null). Stderr: provider secret and arbitrary child output",
				),
			}),
		),
		`${UNEXPECTED_ENGINE_LOSS_NOTICE} Cause (exit): Agent process exited (code=1 signal=null).`,
	);
});

test("a failed restart surfaces a concrete failure, stops retrying, and stays user-recoverable", async () => {
	const h = harness(async () => {
		throw new Error("Agent process exited immediately. Stderr: boom");
	});
	h.controller.handleGenerationEnded(ended());
	await sleep(10);
	assert.equal(h.controller.isRecovering(), false, "no attempt keeps running");
	const failure = h.diagnostics.at(-1)!;
	assert.equal(failure.message, "Interactive engine restart failed: Agent process exited immediately. Stderr: boom");
	assert.equal(failure.source, undefined, "a real failure must surface as a chat error");
	assert.equal(failure.level, "unresponsive");
	assert.equal(h.controller.needsExplicitTermination(), true, "the user must still be able to ask for another engine");
});

test("a hung restart keeps the host in recovery without terminating anything else", async () => {
	const h = harness(() => new Promise<void>(() => {}));
	h.controller.handleGenerationEnded(ended());
	await sleep(10);
	assert.equal(h.controller.isRecovering(), true);
	assert.equal(h.stops, 0);
	assert.equal(h.restarts, 1);
});

test("explicit termination force-stops first and supersedes a hung automatic attempt", async () => {
	let pendingReject: ((error: Error) => void) | undefined;
	let attempts = 0;
	const h = harness(() => {
		attempts += 1;
		if (attempts === 1)
			return new Promise<void>((_, reject) => {
				pendingReject = reject;
			});
		return Promise.resolve();
	});
	h.controller.handleGenerationEnded(ended());
	await sleep(5);
	const termination = h.controller.terminate();
	// Same-turn repeats join the in-flight termination instead of stacking.
	assert.equal(h.controller.terminate(), termination);
	assert.equal(h.stops, 1, "the escape hatch must stop the child before restarting");
	pendingReject?.(new Error("Agent process stopped"));
	await termination;
	assert.equal(attempts, 2, "the explicit path must run its own replacement attempt");
	assert.equal(h.controller.isRecovering(), false);
	assert.ok(h.diagnostics.some((d) => d.message === UNRESPONSIVE_ENGINE_NOTICE));
});

test("shutdown stops accepting recovery work", async () => {
	const h = harness(async () => {});
	h.controller.shutdown();
	h.controller.handleGenerationEnded(ended());
	await sleep(5);
	assert.equal(h.restarts, 0);
	assert.equal(h.activityClears, 1, "activity is still cleared on shutdown");
});

test("the Ctrl+C escape hatch arms only for a provably unanswering engine", () => {
	const h = harness(async () => {});
	assert.equal(h.controller.needsExplicitTermination(), false);

	// A cooperative abort that has just been requested is not grounds to terminate:
	// a stray second Ctrl+C during a normal abort must never replace the engine.
	h.controller.markCooperativeAbortStarted();
	assert.equal(h.controller.needsExplicitTermination(), false);
	h.controller.markCooperativeAbortSettled();

	// The heartbeat watchdog's unresponsive verdict does arm it.
	h.controller.publish(watchdogUnresponsive);
	assert.equal(h.controller.needsExplicitTermination(), true);
	// A heartbeat proves the loop turns again and disarms it.
	h.controller.clearUnresponsive();
	assert.equal(h.controller.needsExplicitTermination(), false);

	// Blocking-level watchdog reports are too early to arm anything.
	h.controller.publish({ ...watchdogUnresponsive, level: "blocking", elapsedMs: 264 });
	assert.equal(h.controller.needsExplicitTermination(), false);
});

test("an abort left unanswered past the watchdog threshold arms the escape hatch", () => {
	const h = harness(async () => {});
	h.controller.markCooperativeAbortStarted();
	h.advance(ENGINE_UNRESPONSIVE_MS - 1);
	assert.equal(h.controller.needsExplicitTermination(), false, "a fresh abort must not arm the hatch");
	h.advance(1);
	assert.equal(h.controller.needsExplicitTermination(), true);
	h.controller.markCooperativeAbortSettled();
	assert.equal(h.controller.needsExplicitTermination(), false);
});

/**
 * The pre-ready case: a replacement child stopped before `engine_ready` emits no
 * heartbeat and no watchdog diagnostic, and `RpcClient.start()` waits without a
 * deadline, so nothing else can arm the escape hatch.
 */
test("a replacement still waiting for readiness arms the escape hatch after the threshold", async () => {
	const h = harness(() => new Promise<void>(() => {}));
	h.controller.handleGenerationEnded(ended());
	await sleep(0);
	assert.equal(h.controller.isRecovering(), true);
	assert.equal(h.controller.needsExplicitTermination(), false, "a fresh replacement must not arm the hatch");
	h.advance(ENGINE_UNRESPONSIVE_MS - 1);
	assert.equal(h.controller.needsExplicitTermination(), false);
	h.advance(1);
	assert.equal(h.controller.needsExplicitTermination(), true, "an overdue pre-ready replacement must arm Ctrl+C");
});

/**
 * The watchdog's verdict describes one generation. A replacement emits no
 * heartbeat before `engine_ready`, so nothing would clear an inherited latch and
 * the first Ctrl+C would stop a child that never misbehaved.
 */
test("a dead generation's unresponsive verdict does not arm the hatch against its replacement", async () => {
	const h = harness(() => new Promise<void>(() => {}));
	h.controller.publish(watchdogUnresponsive);
	assert.equal(h.controller.needsExplicitTermination(), true, "the stalled child itself must arm Ctrl+C");
	h.controller.handleGenerationEnded(ended());
	await sleep(0);
	assert.equal(h.controller.isRecovering(), true);
	assert.equal(
		h.controller.needsExplicitTermination(),
		false,
		"the replacement inherits no verdict during its pre-ready window",
	);
	// The fence is time-bounded, not permanent: this replacement is still on the
	// hook for its own readiness.
	h.advance(ENGINE_UNRESPONSIVE_MS);
	assert.equal(h.controller.needsExplicitTermination(), true, "an overdue replacement still arms Ctrl+C");
});

test("a successful replacement disarms the escape hatch", async () => {
	let settle!: () => void;
	const h = harness(
		() =>
			new Promise<void>((resolve) => {
				settle = resolve;
			}),
	);
	h.controller.handleGenerationEnded(ended());
	await sleep(0);
	h.advance(ENGINE_UNRESPONSIVE_MS);
	assert.equal(h.controller.needsExplicitTermination(), true);
	settle();
	await sleep(5);
	assert.equal(h.controller.isRecovering(), false);
	assert.equal(h.controller.needsExplicitTermination(), false);
});

test("Ctrl+C stops an overdue pre-ready replacement before starting the next one", async () => {
	const restarts: Array<{ reject: (error: Error) => void; resolve: () => void }> = [];
	const h = harness(
		() =>
			new Promise<void>((resolve, reject) => {
				restarts.push({ resolve, reject });
			}),
	);
	h.controller.handleGenerationEnded(ended());
	await sleep(0);
	assert.equal(h.stops, 0, "automatic recovery must not stop anything on its own");
	h.advance(ENGINE_UNRESPONSIVE_MS);

	const termination = h.controller.terminate();
	assert.equal(h.stops, 1, "the escape hatch must stop the hung child before replacing it");
	restarts[0]!.reject(new Error("Agent process stopped"));
	await sleep(5);
	assert.equal(restarts.length, 2, "an explicit termination starts its own replacement");

	// The replacement started by that termination hangs too: a repeat Ctrl+C must
	// rescue it rather than joining the same promise forever.
	h.advance(ENGINE_UNRESPONSIVE_MS);
	assert.equal(h.controller.needsExplicitTermination(), true);
	assert.equal(h.controller.terminate(), termination, "a repeat press joins the live termination");
	await sleep(5);
	assert.equal(h.stops, 2, "the repeat press must force-stop the overdue replacement");
	restarts[1]!.reject(new Error("Agent process stopped"));
	await sleep(5);
	assert.equal(restarts.length, 3, "the rescued termination starts one more replacement");

	restarts[2]!.resolve();
	await termination;
	assert.equal(h.controller.isRecovering(), false);
	assert.equal(h.controller.needsExplicitTermination(), false);
});

test("repeat presses cannot stack stops on a healthy replacement", async () => {
	const restarts: Array<() => void> = [];
	const h = harness(
		() =>
			new Promise<void>((resolve) => {
				restarts.push(resolve);
			}),
	);
	h.controller.handleGenerationEnded(ended());
	await sleep(0);
	h.advance(ENGINE_UNRESPONSIVE_MS);
	const termination = h.controller.terminate();
	assert.equal(h.stops, 1);
	restarts[0]!(); // the automatic attempt releases the slot
	await sleep(5);
	assert.equal(restarts.length, 2, "the termination started its own replacement");
	// That replacement is fresh, so further presses must leave it alone.
	h.controller.terminate();
	h.controller.terminate();
	await sleep(5);
	assert.equal(h.stops, 1, "a healthy replacement must never be stopped by a repeat press");
	restarts[1]!();
	await termination;
	assert.equal(restarts.length, 2, "no extra replacement was stacked");
});

test("Escape's cooperative path never stops or restarts the engine", async () => {
	const h = harness(async () => {});
	h.controller.markCooperativeAbortStarted();
	h.advance(ENGINE_UNRESPONSIVE_MS * 5);
	h.controller.markCooperativeAbortSettled();
	await sleep(5);
	assert.equal(h.stops, 0);
	assert.equal(h.restarts, 0);
	assert.equal(h.controller.isRecovering(), false);
});

test("diagnostics emitted before any listener attaches are replayed once", () => {
	const controller = new EngineHealthController({
		stop: async () => {},
		restart: async () => {},
		clearActivity: () => {},
	});
	controller.publish(watchdogUnresponsive);
	const first: ActivityWatchdogDiagnostic[] = [];
	const second: ActivityWatchdogDiagnostic[] = [];
	controller.onDiagnostic((d) => first.push(d));
	controller.onDiagnostic((d) => second.push(d));
	assert.deepEqual(first, [watchdogUnresponsive]);
	assert.deepEqual(second, []);
});

test("an attempt the user deliberately stopped is not reported as a restart failure", async () => {
	const restarts: Array<{ reject: (error: Error) => void; resolve: () => void }> = [];
	const h = harness(
		() =>
			new Promise<void>((resolve, reject) => {
				restarts.push({ resolve, reject });
			}),
	);
	h.controller.handleGenerationEnded(ended());
	await sleep(0);
	h.advance(ENGINE_UNRESPONSIVE_MS);
	const termination = h.controller.terminate();
	// The explicit stop is what makes this attempt fail, so it must stay silent.
	restarts[0]!.reject(new Error("Agent process stopped"));
	await sleep(5);
	restarts[1]!.resolve();
	await termination;
	assert.deepEqual(
		h.diagnostics.filter((d) => d.message.startsWith("Interactive engine restart failed")),
		[],
		"a user-stopped attempt must not surface as a restart failure",
	);
});

test("a replacement that genuinely fails on its own is still reported", async () => {
	const h = harness(async () => {
		throw new Error("Agent process exited immediately. Stderr: boom");
	});
	h.controller.handleGenerationEnded(ended());
	await sleep(10);
	assert.equal(
		h.diagnostics.at(-1)?.message,
		"Interactive engine restart failed: Agent process exited immediately. Stderr: boom",
	);
});

/**
 * A replacement that fails on its own used to leave nothing armed: no pending
 * attempt, no overdue abort, no watchdog flag. Ctrl+C could not ask for another
 * engine, so the host stayed permanently engine-less.
 */
test("a failed replacement keeps Ctrl+C armed and each press starts exactly one attempt", async () => {
	const outcomes: Array<() => void> = [];
	const restarts: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
	const h = harness(
		() =>
			new Promise<void>((resolve, reject) => {
				restarts.push({ resolve, reject });
			}),
	);

	h.controller.handleGenerationEnded(ended());
	await sleep(0);
	restarts[0]!.reject(new Error("Agent process exited immediately. Stderr: boom"));
	await sleep(5);
	assert.equal(h.controller.isRecovering(), false, "the automatic attempt is finished");
	assert.equal(h.controller.needsExplicitTermination(), true, "a failed replacement must arm Ctrl+C");
	assert.equal(h.restarts, 1, "automatic recovery stays single-shot");

	// Nothing may retry on its own while the user has not pressed anything.
	h.advance(ENGINE_UNRESPONSIVE_MS * 5);
	await sleep(10);
	assert.equal(h.restarts, 1, "no automatic retry loop");

	const first = h.controller.terminate();
	await sleep(5); // terminate() stops before it restarts
	assert.equal(h.restarts, 2, "Ctrl+C starts exactly one new attempt");
	restarts[1]!.reject(new Error("Agent process exited immediately. Stderr: again"));
	await first;
	assert.equal(h.controller.needsExplicitTermination(), true, "a second failure re-arms Ctrl+C");
	assert.equal(h.restarts, 2, "still no automatic retry");

	const second = h.controller.terminate();
	await sleep(5);
	assert.equal(h.restarts, 3);
	restarts[2]!.resolve();
	await second;
	assert.equal(h.controller.needsExplicitTermination(), false, "success disarms the latch");
	assert.equal(h.controller.isRecovering(), false);
	assert.deepEqual(outcomes, []);
});

/**
 * A newer child dying while the replacement attempt is still running means that
 * attempt cannot leave a viable generation behind. Automatic recovery must stay
 * single-shot, but the host must not settle into "recovered" with no engine and
 * nothing arming Ctrl+C.
 */
test("a death during an active replacement latches Ctrl+C without starting a second restart", async () => {
	const restarts: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
	const h = harness(
		() =>
			new Promise<void>((resolve, reject) => {
				restarts.push({ resolve, reject });
			}),
	);

	h.controller.handleGenerationEnded(ended({ generation: 1 }));
	await sleep(0);
	assert.equal(h.restarts, 1, "one automatic attempt");

	// Generation 2 dies while attempt A is still in flight.
	h.controller.handleGenerationEnded(ended({ generation: 2 }));
	await sleep(5);
	assert.equal(h.restarts, 1, "the nested death must not start another automatic restart");

	restarts[0]!.resolve();
	await sleep(5);
	assert.equal(h.controller.isRecovering(), false, "the attempt settled");
	assert.equal(h.controller.needsExplicitTermination(), true, "the nested death must keep Ctrl+C armed");

	// Still nothing automatic, however long we wait.
	h.advance(ENGINE_UNRESPONSIVE_MS * 5);
	await sleep(10);
	assert.equal(h.restarts, 1, "no automatic retry loop");

	const termination = h.controller.terminate();
	await sleep(5);
	assert.equal(h.restarts, 2, "Ctrl+C starts exactly one replacement");
	restarts[1]!.resolve();
	await termination;
	assert.equal(h.controller.needsExplicitTermination(), false, "success clears the latch");
});

test("a death during a user-requested replacement re-arms Ctrl+C", async () => {
	const restarts: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
	const h = harness(
		() =>
			new Promise<void>((resolve, reject) => {
				restarts.push({ resolve, reject });
			}),
	);
	h.controller.publish(watchdogUnresponsive);
	const termination = h.controller.terminate();
	await sleep(5);
	assert.equal(h.restarts, 1);
	h.controller.handleGenerationEnded(ended({ generation: 3 }));
	restarts[0]!.resolve();
	await termination;
	assert.equal(h.restarts, 1, "still no automatic retry");
	assert.equal(h.controller.needsExplicitTermination(), true, "the nested death re-arms the escape hatch");
});

test("an expected generation end during a replacement does not latch", async () => {
	const restarts: Array<() => void> = [];
	const h = harness(
		() =>
			new Promise<void>((resolve) => {
				restarts.push(resolve);
			}),
	);
	h.controller.handleGenerationEnded(ended({ generation: 1 }));
	await sleep(0);
	h.controller.handleGenerationEnded(ended({ generation: 2, expected: true, kind: "explicit-stop" }));
	restarts[0]!();
	await sleep(5);
	assert.equal(h.controller.needsExplicitTermination(), false, "an expected end is not a failure");
	assert.equal(h.restarts, 1);
});

test("shutdown ignores a later death entirely", async () => {
	const h = harness(async () => {});
	h.controller.shutdown();
	h.controller.handleGenerationEnded(ended({ generation: 1 }));
	h.controller.handleGenerationEnded(ended({ generation: 2 }));
	await sleep(5);
	assert.equal(h.restarts, 0);
	assert.equal(h.controller.needsExplicitTermination(), false);
});
