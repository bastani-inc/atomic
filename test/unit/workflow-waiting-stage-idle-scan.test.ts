import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	disposeStageIdleReleaser,
	type IdleStage,
	StageIdleReleaser,
	settleReleasedStages,
	stageIdleReleaser,
} from "../../packages/workflows/src/runs/foreground/stage-idle-release.js";
import { StageWakeDispatcher } from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";

/** A stage's threshold and the busy recheck interval the scan uses, as the scan states them. */
const THRESHOLD_MS = 100;
const BUSY_RECHECK_MS = 1_000;
const START = new Date("2026-01-01T00:00:00.000Z");

interface Probe {
	readonly stage: IdleStage;
	readonly released: number[];
	idleSince: number | undefined;
	releaseError: Error | undefined;
}

/** A stage that records when it is released, whose idle state and release failure the test sets. */
function probe(afterMs = THRESHOLD_MS, idleSince: number | undefined = undefined): Probe {
	const state: Probe = {
		released: [],
		idleSince,
		releaseError: undefined,
		stage: {
			afterMs,
			idleSince: () => state.idleSince,
			release: async () => {
				state.released.push(Date.now());
				if (state.releaseError !== undefined) throw state.releaseError;
			},
		},
	};
	return state;
}

describe("the run's idle scan, at its deadlines (#4309)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(START);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	test("a watched stage idle since before it was watched is released exactly when its threshold is up, not before (#4309)", async () => {
		const releaser = new StageIdleReleaser(() => {});
		const idle = probe(THRESHOLD_MS, START.getTime());
		releaser.watch("a", idle.stage);
		assert.equal(releaser.size, 1);
		await vi.advanceTimersByTimeAsync(THRESHOLD_MS - 1);
		assert.deepEqual(idle.released, []);
		assert.equal(releaser.size, 1);
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(idle.released, [START.getTime() + THRESHOLD_MS]);
		assert.equal(releaser.size, 0);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("a stage idle for exactly its threshold at the scan is released, and one a millisecond short is looked at again exactly when it is due (#4309)", async () => {
		const releaser = new StageIdleReleaser(() => {});
		const exact = probe(THRESHOLD_MS, START.getTime());
		const short = probe(THRESHOLD_MS, START.getTime() + 1);
		releaser.watch("exact", exact.stage);
		releaser.watch("short", short.stage);
		await vi.advanceTimersByTimeAsync(THRESHOLD_MS);
		assert.deepEqual(exact.released, [START.getTime() + THRESHOLD_MS]);
		assert.deepEqual(short.released, []);
		assert.equal(releaser.size, 1);
		// Idle since +1 ms, so due one millisecond later, with one timer left for it.
		assert.equal(vi.getTimerCount(), 1);
		await vi.advanceTimersByTimeAsync(0);
		assert.deepEqual(short.released, []);
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(short.released, [START.getTime() + THRESHOLD_MS + 1]);
		assert.equal(releaser.size, 0);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("a busy stage is looked at again after the longer of its threshold and the busy recheck interval (#4309)", async () => {
		const releaser = new StageIdleReleaser(() => {});
		const SLOW_THRESHOLD_MS = BUSY_RECHECK_MS * 5;
		const quick = probe(THRESHOLD_MS);
		const slow = probe(SLOW_THRESHOLD_MS);
		releaser.watch("quick", quick.stage);
		releaser.watch("slow", slow.stage);
		await vi.advanceTimersByTimeAsync(THRESHOLD_MS);
		// Busy at its deadline, the quick stage is rechecked one busy interval later, not after its own threshold.
		quick.idleSince = START.getTime() - BUSY_RECHECK_MS;
		await vi.advanceTimersByTimeAsync(BUSY_RECHECK_MS - 1);
		assert.deepEqual(quick.released, []);
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(quick.released, [START.getTime() + THRESHOLD_MS + BUSY_RECHECK_MS]);
		// The slow stage is busy at its own deadline, so its recheck is one of its own thresholds later.
		await vi.advanceTimersByTimeAsync(SLOW_THRESHOLD_MS - THRESHOLD_MS - BUSY_RECHECK_MS);
		slow.idleSince = START.getTime();
		await vi.advanceTimersByTimeAsync(SLOW_THRESHOLD_MS - 1);
		assert.deepEqual(slow.released, []);
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(slow.released, [START.getTime() + SLOW_THRESHOLD_MS * 2]);
	});

	test("a stage that went idle only part-way through its threshold is released a full threshold after it went idle (#4309)", async () => {
		const setTimer = vi.spyOn(globalThis, "setTimeout");
		const releaser = new StageIdleReleaser(() => {});
		const idle = probe(THRESHOLD_MS);
		const WENT_IDLE_AFTER_MS = 60;
		releaser.watch("a", idle.stage);
		await vi.advanceTimersByTimeAsync(WENT_IDLE_AFTER_MS);
		const wentIdleAt = Date.now();
		idle.idleSince = wentIdleAt;
		// At its deadline the stage has been idle for less than its threshold: it is due a threshold after it went idle.
		await vi.advanceTimersByTimeAsync(THRESHOLD_MS - WENT_IDLE_AFTER_MS);
		assert.deepEqual(idle.released, []);
		await vi.advanceTimersByTimeAsync(WENT_IDLE_AFTER_MS - 1);
		assert.deepEqual(idle.released, []);
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(idle.released, [wentIdleAt + THRESHOLD_MS]);
		// One timer to its first deadline and one to the time it was due: the scan never polls in between.
		assert.deepEqual(
			setTimer.mock.calls.map((call) => call[1]),
			[THRESHOLD_MS, THRESHOLD_MS - (THRESHOLD_MS - WENT_IDLE_AFTER_MS)],
		);
	});

	test("one timer serves every watched stage and it fires at the earliest deadline, then at the next one (#4309)", async () => {
		const releaser = new StageIdleReleaser(() => {});
		const late = probe(300, START.getTime());
		const early = probe(100, START.getTime());
		const middle = probe(200, START.getTime());
		releaser.watch("late", late.stage);
		assert.equal(vi.getTimerCount(), 1);
		releaser.watch("early", early.stage);
		releaser.watch("middle", middle.stage);
		assert.equal(vi.getTimerCount(), 1);
		await vi.advanceTimersByTimeAsync(99);
		assert.equal(early.released.length, 0);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(early.released.length, 1);
		assert.equal(vi.getTimerCount(), 1);
		await vi.advanceTimersByTimeAsync(99);
		assert.equal(middle.released.length, 0);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(middle.released.length, 1);
		await vi.advanceTimersByTimeAsync(100);
		assert.equal(late.released.length, 1);
		assert.equal(vi.getTimerCount(), 0);
	});

	test("watching a stage later than the armed deadline leaves the timer where it is, and watching it earlier moves it up (#4309)", async () => {
		const setTimer = vi.spyOn(globalThis, "setTimeout");
		const releaser = new StageIdleReleaser(() => {});
		const first = probe(200, START.getTime());
		releaser.watch("first", first.stage);
		assert.equal(setTimer.mock.calls.length, 1);
		// Not earlier than the armed deadline, equal or later: no new timer.
		releaser.watch("equal", probe(200, START.getTime()).stage);
		releaser.watch("later", probe(300, START.getTime()).stage);
		assert.equal(setTimer.mock.calls.length, 1);
		releaser.watch("earlier", probe(50, START.getTime()).stage);
		assert.equal(setTimer.mock.calls.length, 2);
		assert.equal(setTimer.mock.calls[1]?.[1], 50);
		assert.equal(vi.getTimerCount(), 1);
		releaser.dispose();
	});

	test("the timer never keeps the process alive by itself (#4309)", () => {
		const setTimer = vi.spyOn(globalThis, "setTimeout");
		const releaser = new StageIdleReleaser(() => {});
		releaser.watch("a", probe(THRESHOLD_MS, START.getTime()).stage);
		assert.equal(setTimer.mock.calls[0]?.[1], THRESHOLD_MS);
		const timer = setTimer.mock.results[0]?.value as NodeJS.Timeout;
		assert.equal(timer.hasRef(), false);
		releaser.dispose();
	});

	test("unwatching the last stage clears the timer, and unwatching one of several leaves it armed (#4309)", async () => {
		const releaser = new StageIdleReleaser(() => {});
		const a = probe(100, START.getTime());
		const b = probe(100, START.getTime());
		releaser.watch("a", a.stage);
		releaser.watch("b", b.stage);
		releaser.unwatch("a");
		assert.equal(releaser.size, 1);
		assert.equal(vi.getTimerCount(), 1);
		releaser.unwatch("b");
		assert.equal(releaser.size, 0);
		assert.equal(vi.getTimerCount(), 0);
		await vi.advanceTimersByTimeAsync(1_000);
		assert.deepEqual([a.released, b.released], [[], []]);
		// Unwatching a stage nobody watches changes nothing.
		releaser.unwatch("a");
		assert.equal(vi.getTimerCount(), 0);
	});

	test("a stage watched again is due a full threshold after it was watched again, and is released once (#4309)", async () => {
		const releaser = new StageIdleReleaser(() => {});
		const idle = probe(100, START.getTime());
		releaser.watch("a", idle.stage);
		await vi.advanceTimersByTimeAsync(50);
		releaser.watch("a", idle.stage);
		assert.equal(releaser.size, 1);
		await vi.advanceTimersByTimeAsync(99);
		assert.deepEqual(idle.released, []);
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(idle.released, [START.getTime() + 150]);
		assert.equal(releaser.size, 0);
		await vi.advanceTimersByTimeAsync(1_000);
		assert.equal(idle.released.length, 1);
	});

	test("a release that fails is reported with the stage's key and the error, and does not stop the other stages (#4309)", async () => {
		const failures: [string, unknown][] = [];
		const releaser = new StageIdleReleaser((key, error) => failures.push([key, error]));
		const broken = probe(100, START.getTime());
		const fine = probe(100, START.getTime());
		broken.releaseError = new Error("store unavailable");
		releaser.watch("broken", broken.stage);
		releaser.watch("fine", fine.stage);
		await vi.advanceTimersByTimeAsync(100);
		assert.deepEqual(failures, [["broken", broken.releaseError]]);
		assert.equal(fine.released.length, 1);
		assert.equal(releaser.size, 0);
	});

	test("a stage whose release is under way is not looked at again, and a stage reports nothing when its release succeeds (#4309)", async () => {
		const failures: unknown[] = [];
		const releaser = new StageIdleReleaser((_key, error) => failures.push(error));
		const gate = Promise.withResolvers<void>();
		let starts = 0;
		releaser.watch("a", {
			afterMs: 10,
			idleSince: () => START.getTime(),
			release: async () => {
				starts += 1;
				await gate.promise;
			},
		});
		await vi.advanceTimersByTimeAsync(10_000);
		assert.equal(starts, 1);
		gate.resolve();
		await vi.advanceTimersByTimeAsync(10_000);
		assert.equal(starts, 1);
		assert.deepEqual(failures, []);
	});

	test("a release that ends the scan on its own account leaves no timer behind for the stages it did not reach (#4309)", async () => {
		const releaser = new StageIdleReleaser(() => {});
		const later = probe(500, START.getTime());
		releaser.watch("later", later.stage);
		releaser.watch("ending", {
			afterMs: 100,
			idleSince: () => START.getTime(),
			release: async () => releaser.dispose(),
		});
		await vi.advanceTimersByTimeAsync(100);
		assert.equal(vi.getTimerCount(), 0);
		await vi.advanceTimersByTimeAsync(1_000);
		assert.deepEqual(later.released, []);
	});

	test("after the workflow finished or the run ended nothing is watched, and nothing arms a timer (#4309)", async () => {
		for (const end of ["settleReleased", "dispose"] as const) {
			const releaser = new StageIdleReleaser(() => {});
			const watched = probe(100, START.getTime());
			releaser.watch("before", watched.stage);
			assert.equal(vi.getTimerCount(), 1);
			releaser[end]();
			assert.equal(releaser.size, 0, end);
			assert.equal(vi.getTimerCount(), 0, end);
			releaser.watch("after", probe(100, START.getTime()).stage);
			assert.equal(releaser.size, 0, end);
			assert.equal(vi.getTimerCount(), 0, end);
			await vi.advanceTimersByTimeAsync(1_000);
			assert.deepEqual(watched.released, [], end);
		}
	});

	test("stages released between turns settle once when the workflow finishes, and never again (#4309)", () => {
		const releaser = new StageIdleReleaser(() => {});
		const settled: string[] = [];
		releaser.trackReleased("a", () => settled.push("a"));
		releaser.trackReleased("b", () => settled.push("b"));
		releaser.trackReleased("c", () => settled.push("c"));
		releaser.forgetReleased("b");
		releaser.settleReleased();
		assert.deepEqual(settled, ["a", "c"]);
		releaser.settleReleased();
		releaser.dispose();
		assert.deepEqual(settled, ["a", "c"]);
	});

	test("a stage that was released as the workflow finished settles at once, and is not remembered (#4309)", () => {
		const releaser = new StageIdleReleaser(() => {});
		releaser.settleReleased();
		const settled: string[] = [];
		releaser.trackReleased("late", () => settled.push("late"));
		assert.deepEqual(settled, ["late"]);
		releaser.settleReleased();
		assert.deepEqual(settled, ["late"]);
	});

	test("ending the run forgets stages released between turns without showing any status again (#4309)", () => {
		const releaser = new StageIdleReleaser(() => {});
		const settled: string[] = [];
		releaser.trackReleased("a", () => settled.push("a"));
		releaser.dispose();
		releaser.settleReleased();
		assert.equal(settled.length, 0);
		// The run has ended: a stage tracked now settles at once.
		releaser.trackReleased("b", () => settled.push("b"));
		assert.deepEqual(settled, ["b"]);
	});

	test("a run's idle scan is created once per dispatcher, and ending the run stops it and forgets it (#4309)", () => {
		const dispatcher = new StageWakeDispatcher("run-idle-scan", undefined);
		const other = new StageWakeDispatcher("run-idle-scan-other", undefined);
		const unrelated = new StageWakeDispatcher("run-without-scan", undefined);
		try {
			const releaser = stageIdleReleaser(dispatcher, () => {});
			assert.equal(
				stageIdleReleaser(dispatcher, () => {}),
				releaser,
			);
			assert.notEqual(
				stageIdleReleaser(other, () => {}),
				releaser,
			);

			const settled: string[] = [];
			releaser.trackReleased("a", () => settled.push("a"));
			releaser.watch("watched", probe(THRESHOLD_MS, START.getTime()).stage);
			settleReleasedStages(dispatcher);
			assert.deepEqual(settled, ["a"]);
			assert.equal(releaser.size, 0);

			disposeStageIdleReleaser(dispatcher);
			const fresh = stageIdleReleaser(dispatcher, () => {});
			assert.notEqual(fresh, releaser);
			// The disposed scan is finished: it watches nothing.
			releaser.watch("late", probe(THRESHOLD_MS, START.getTime()).stage);
			assert.equal(releaser.size, 0);
			// A run that never had an idle scan has nothing to settle or dispose.
			settleReleasedStages(unrelated);
			disposeStageIdleReleaser(unrelated);
			assert.equal(vi.getTimerCount(), 0);
		} finally {
			dispatcher.dispose();
			other.dispose();
			unrelated.dispose();
		}
	});
});
