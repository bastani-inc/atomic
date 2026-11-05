import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { WakeDeadlines } from "../src/core/agent-wake-deadlines.ts";
import { type AgentWake, type AgentWakeClock, AgentWakeDispatcher } from "../src/core/agent-wake-dispatcher.ts";

const timed = (id: string): AgentWake => ({ id, kind: "timer" });

/** A clock that moves only when told: one timer at a time, so the test counts the dispatcher's work, not time. */
function handClock() {
	let now = 0;
	let callback: (() => void) | undefined;
	const clock: AgentWakeClock = {
		now: () => now,
		setTimer: (next) => {
			callback = next;
			return {};
		},
		clearTimer: () => {
			callback = undefined;
		},
	};
	return {
		clock,
		advanceTo(ms: number) {
			now = ms;
			const fire = callback;
			callback = undefined;
			fire?.();
		},
	};
}

/** The same sequence every run, so a count is a fact about the code and not about luck. */
function delaysOf(count: number): number[] {
	let seed = 12_345;
	return Array.from({ length: count }, () => {
		seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
		return 1 + (seed % 10_000_000);
	});
}

interface Run {
	readonly operations: number;
	readonly comparisons: number;
	readonly fired: readonly string[];
	readonly scheduledAfter: number;
	readonly timersAfter: number;
}

async function scheduleCancelAndFire(agents: number, cancels: number): Promise<Run> {
	const time = handClock();
	const dispatcher = new AgentWakeDispatcher({ clock: time.clock });
	const fired: string[] = [];
	dispatcher.handle("t", async (key) => {
		fired.push(key);
	});
	const delays = delaysOf(agents);
	delays.forEach((delay, index) => {
		dispatcher.schedule(`t:${index}`, timed("reply"), delay);
	});
	const stride = Math.floor(agents / cancels);
	for (let index = 0; index < cancels; index++) {
		assert.equal(dispatcher.cancel(`t:${index * stride}`, "reply"), true);
	}
	time.advanceTo(Math.max(...delays));
	await dispatcher.whenIdle();
	return {
		operations: agents + cancels + (agents - cancels),
		comparisons: dispatcher.deadlineComparisons,
		fired,
		scheduledAfter: dispatcher.stats().scheduled,
		timersAfter: dispatcher.stats().timers,
	};
}

describe("timed wakes cost O(log n) each (#4326)", () => {
	test("75,000 schedules, 1,000 cancels and firing them all stay within n log n comparisons, and the cost per wake grows only with log n", async () => {
		const small = await scheduleCancelAndFire(1_000, 100);
		const large = await scheduleCancelAndFire(75_000, 1_000);

		for (const [agents, cancels, run] of [
			[1_000, 100, small],
			[75_000, 1_000, large],
		] as const) {
			assert.equal(run.fired.length, agents - cancels, "every wake that was not cancelled fires, once");
			assert.equal(new Set(run.fired).size, run.fired.length);
			assert.deepEqual([run.scheduledAfter, run.timersAfter], [0, 0]);
			assert.ok(
				run.comparisons <= 4 * agents * Math.log2(agents),
				`${run.comparisons} comparisons for ${agents} agents exceeds 4 n log2 n`,
			);
		}
		const perOperation = (run: Run) => run.comparisons / run.operations;
		assert.ok(
			perOperation(large) <= perOperation(small) * (Math.log2(75_000) / Math.log2(1_000)) * 1.5,
			`per-operation cost grew from ${perOperation(small)} to ${perOperation(large)}: more than log n`,
		);
	}, 60_000);

	test("wakes fire in the order of their deadlines, and wakes due together in the order they were scheduled", async () => {
		const run = await scheduleCancelAndFire(2_000, 50);
		const delays = delaysOf(2_000);
		const order = run.fired.map((key) => delays[Number(key.slice(2))] as number);
		assert.deepEqual(
			order,
			[...order].sort((a, b) => a - b),
		);
	});
});

describe("WakeDeadlines (#4326)", () => {
	test("a deadline scheduled again under the same key and id replaces the earlier one", () => {
		const deadlines = new WakeDeadlines();
		deadlines.set("owner:child", timed("reply"), 100);
		deadlines.set("owner:child", timed("reply"), 300);
		assert.equal(deadlines.size, 1);
		assert.equal(deadlines.earliest(), 300);
		assert.deepEqual(deadlines.takeDue(299), []);
		assert.deepEqual(
			deadlines.takeDue(300).map((due) => due.at),
			[300],
		);
		assert.equal(deadlines.size, 0);
	});

	test("keys and ids that share text stay apart", () => {
		const deadlines = new WakeDeadlines();
		deadlines.set("a:b", timed("c"), 1);
		deadlines.set("a", timed("b:c"), 2);
		assert.equal(deadlines.delete("a", "c"), false);
		assert.equal(deadlines.delete("a:b", "c"), true);
		assert.equal(deadlines.size, 1);
		assert.equal(deadlines.earliest(), 2);
	});

	test("cancelled deadlines are dropped once they outnumber the live ones, so a cancelled deadline does not stay for its whole time", () => {
		const deadlines = new WakeDeadlines();
		for (let index = 0; index < 10_000; index++) deadlines.set(`k:${index}`, timed("reply"), 1_000_000 + index);
		for (let index = 0; index < 9_900; index++) deadlines.delete(`k:${index}`, "reply");
		assert.equal(deadlines.size, 100);
		assert.ok(deadlines.stored <= 2 * deadlines.size + 64, `${deadlines.stored} nodes stored for 100 live deadlines`);
		assert.equal(deadlines.earliest(), 1_000_000 + 9_900);
	});

	test("taking the due deadlines costs those deadlines, not the ones still waiting", () => {
		const deadlines = new WakeDeadlines();
		for (let index = 0; index < 50_000; index++) deadlines.set(`k:${index}`, timed("reply"), 10_000 + index);
		deadlines.set("k:soon", timed("reply"), 1);
		const before = deadlines.comparisons;
		assert.deepEqual(
			deadlines.takeDue(5).map((due) => due.wakeKey),
			["k:soon"],
		);
		assert.ok(deadlines.comparisons - before <= 2 * Math.ceil(Math.log2(50_001)) + 2);
	});
});
