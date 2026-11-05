import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { WakeDeadlines } from "../src/core/agent-wake-deadlines.ts";
import type { AgentWake } from "../src/core/agent-wake-dispatcher.ts";

const timed = (id: string): AgentWake => ({ id, kind: "timer" });

/** The keys the deadlines still index: a key with nothing waiting must not stay in it. */
function indexedKeys(deadlines: WakeDeadlines): string[] {
	return [...(Reflect.get(deadlines, "index") as Map<string, object>).keys()];
}

/** The same sequence every run. */
function timesOf(count: number): number[] {
	let seed = 4_321;
	return Array.from({ length: count }, () => {
		seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
		return 1 + (seed % 1_000);
	});
}

describe("WakeDeadlines ordering (#4326)", () => {
	test("deadlines come out earliest first, and those due together in the order they were scheduled", () => {
		const deadlines = new WakeDeadlines();
		const scheduled: Array<[string, number]> = [
			["a", 5],
			["b", 3],
			["c", 5],
			["d", 3],
			["e", 1],
			["f", 5],
		];
		for (const [id, at] of scheduled) deadlines.set(`k:${id}`, timed(id), at);
		assert.deepEqual(
			deadlines.takeDue(Number.POSITIVE_INFINITY).map((due) => due.wake.id),
			["e", "b", "d", "a", "c", "f"],
		);
	});

	test("many deadlines come out in time order, and the earliest is always the smallest time left", () => {
		const deadlines = new WakeDeadlines();
		const times = timesOf(400);
		for (const [index, at] of times.entries()) deadlines.set(`k:${index}`, timed("reply"), at);
		const taken: number[] = [];
		while (deadlines.size > 0) {
			const next = deadlines.earliest();
			const due = deadlines.takeDue(next);
			assert.ok(due.length > 0 && due.every((one) => one.at === next));
			taken.push(next);
		}
		assert.deepEqual(
			taken,
			[...new Set(times)].sort((a, b) => a - b),
		);
	});

	test("taking the only deadline leaves nothing stored, nothing indexed and no earliest time", () => {
		const deadlines = new WakeDeadlines();
		deadlines.set("k:1", timed("reply"), 10);
		assert.equal(deadlines.takeDue(10).length, 1);
		assert.deepEqual([deadlines.size, deadlines.stored, deadlines.earliest()], [0, 0, Number.POSITIVE_INFINITY]);
		assert.deepEqual(indexedKeys(deadlines), []);
		assert.deepEqual(deadlines.takeDue(Number.POSITIVE_INFINITY), []);
	});
});

describe("WakeDeadlines index (#4326)", () => {
	test("cancelling an unknown key, or an unknown id of a known key, changes nothing", () => {
		const deadlines = new WakeDeadlines();
		deadlines.set("k:1", timed("reply"), 10);
		assert.equal(deadlines.delete("k:2", "reply"), false);
		assert.equal(deadlines.delete("k:1", "other"), false);
		assert.equal(deadlines.size, 1);
		assert.equal(deadlines.earliest(), 10);
	});

	test("one key can hold several ids, and each is cancelled on its own", () => {
		const deadlines = new WakeDeadlines();
		deadlines.set("k:1", timed("first"), 10);
		deadlines.set("k:1", timed("second"), 20);
		assert.equal(deadlines.delete("k:1", "first"), true);
		assert.equal(deadlines.delete("k:1", "second"), true);
		assert.equal(deadlines.size, 0);
	});

	test("a key stays indexed while one of its ids waits and leaves with its last one, cancelled or taken", () => {
		const deadlines = new WakeDeadlines();
		deadlines.set("k:1", timed("early"), 1);
		deadlines.set("k:1", timed("late"), 5);
		deadlines.set("k:2", timed("only"), 9);
		assert.deepEqual(indexedKeys(deadlines).sort(), ["k:1", "k:2"]);

		assert.deepEqual(
			deadlines.takeDue(1).map((due) => due.wake.id),
			["early"],
		);
		assert.deepEqual(indexedKeys(deadlines).sort(), ["k:1", "k:2"], "the key's other id still waits");
		assert.equal(deadlines.delete("k:2", "only"), true);
		assert.deepEqual(indexedKeys(deadlines), ["k:1"]);
		assert.equal(deadlines.delete("k:1", "late"), true, "the later id is still cancellable");
		assert.deepEqual(indexedKeys(deadlines), []);
	});
});

describe("WakeDeadlines compaction (#4326)", () => {
	const fill = (count: number): WakeDeadlines => {
		const deadlines = new WakeDeadlines();
		for (let index = 0; index < count; index++) deadlines.set(`k:${index}`, timed("reply"), 1_000 + index);
		return deadlines;
	};
	const cancel = (deadlines: WakeDeadlines, from: number, to: number): void => {
		for (let index = from; index < to; index++) assert.equal(deadlines.delete(`k:${index}`, "reply"), true);
	};

	test("a few cancelled deadlines stay stored however much they outnumber the live ones", () => {
		const deadlines = fill(10);
		cancel(deadlines, 0, 9);
		assert.deepEqual([deadlines.size, deadlines.stored], [1, 10]);
	});

	test("the heap is rebuilt once at least 64 cancelled deadlines outnumber the live ones", () => {
		const deadlines = fill(74);
		cancel(deadlines, 0, 63);
		assert.equal(deadlines.stored, 74, "63 cancelled deadlines are too few to rebuild for");
		cancel(deadlines, 63, 64);
		assert.deepEqual([deadlines.size, deadlines.stored], [10, 10]);
	});

	test("the heap is not rebuilt while the cancelled deadlines only equal the live ones", () => {
		const deadlines = fill(128);
		cancel(deadlines, 0, 64);
		assert.deepEqual([deadlines.size, deadlines.stored], [64, 128]);
		cancel(deadlines, 64, 65);
		assert.deepEqual([deadlines.size, deadlines.stored], [63, 63]);
	});

	test("a rebuild that leaves two, one or no deadlines stores exactly those", () => {
		for (const left of [2, 1, 0]) {
			const deadlines = fill(64 + left);
			cancel(deadlines, 0, 64);
			assert.deepEqual([deadlines.size, deadlines.stored], [left, left], `${left} left after the rebuild`);
		}
	});

	test("a heap rebuilt after its earliest deadlines were cancelled still has the earliest of the rest on top", () => {
		const deadlines = new WakeDeadlines();
		const times = timesOf(300);
		for (const [index, at] of times.entries()) deadlines.set(`k:${index}`, timed("reply"), at);
		const byTime = times.map((at, index) => ({ at, index })).sort((a, b) => a.at - b.at || a.index - b.index);
		const cancelled = byTime.slice(0, 180);
		for (const { index } of cancelled) assert.equal(deadlines.delete(`k:${index}`, "reply"), true);
		assert.ok(deadlines.stored < 300, "the cancelled deadlines were dropped from the heap");
		const rest = byTime.slice(180).map(({ at }) => at);
		assert.equal(deadlines.earliest(), rest[0]);
		assert.deepEqual(
			deadlines.takeDue(Number.POSITIVE_INFINITY).map((due) => due.at),
			rest,
		);
	});

	test("a rebuilt heap still gives its deadlines in time order, earliest first", () => {
		const deadlines = new WakeDeadlines();
		const times = timesOf(600);
		for (const [index, at] of times.entries()) deadlines.set(`k:${index}`, timed("reply"), at);
		const kept = new Map<number, number>();
		times.forEach((at, index) => {
			if (index % 3 === 0) kept.set(index, at);
			else assert.equal(deadlines.delete(`k:${index}`, "reply"), true);
		});
		assert.ok(deadlines.stored < 600, "the heap was rebuilt without the cancelled deadlines");
		assert.equal(deadlines.earliest(), Math.min(...kept.values()));
		const order = deadlines.takeDue(Number.POSITIVE_INFINITY).map((due) => due.at);
		assert.deepEqual(
			order,
			[...kept.values()].sort((a, b) => a - b),
		);
	});
});
