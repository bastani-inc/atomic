import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { WheelScrollAccelerator } from "../../packages/coding-agent/src/modes/interactive/components/wheel-scroll-accelerator.js";

/** The rows each wheel-up event moves, for events `gaps[i]` milliseconds after the previous one. */
function steps(accelerator: WheelScrollAccelerator, gaps: readonly number[], direction: -1 | 1 = -1): number[] {
	let now = 10_000;
	return gaps.map((gap) => {
		now += gap;
		return accelerator.next(direction, now);
	});
}

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
	Object.defineProperty(process, "platform", realPlatform);
	vi.unstubAllEnvs();
});

describe("wheel velocity in overlay transcripts matches the main transcript (#4521)", () => {
	test("a numeric setting moves that many whole rows per event, and never less than one", () => {
		for (const [lines, expected] of [
			[3, 3],
			[2.7, 2],
			[0, 1],
			[-4, 1],
			[Number.POSITIVE_INFINITY, 1],
			[Number.NaN, 1],
		] as const)
			assert.deepEqual(steps(new WheelScrollAccelerator(lines, true), [0, 20, 20]), [expected, expected, expected]);
	});

	test('"auto" scales with the average gap of one gesture: 100 ms is one row, 50 ms two, 20 ms five, capped at six', () => {
		assert.deepEqual(steps(new WheelScrollAccelerator("auto", true), [0, 100, 100]), [1, 1, 1]);
		assert.deepEqual(steps(new WheelScrollAccelerator("auto", true), [0, 50, 50]), [1, 2, 2]);
		assert.deepEqual(steps(new WheelScrollAccelerator("auto", true), [0, 20, 20]), [1, 5, 5]);
		assert.deepEqual(steps(new WheelScrollAccelerator("auto", true), [0, 10, 10]), [1, 6, 6]);
		assert.deepEqual(steps(new WheelScrollAccelerator("auto", true), [0, 20, 100]), [1, 5, 1]);
	});

	test("fractional rows carry over to the next event of the gesture", () => {
		assert.deepEqual(steps(new WheelScrollAccelerator("auto", true), [0, 40, 40, 40]), [1, 2, 3, 2]);
	});

	test("events under 5 ms apart are one notch: one row each, and the average is left alone", () => {
		assert.deepEqual(steps(new WheelScrollAccelerator("auto", true), [0, 20, 4, 20]), [1, 5, 1, 5]);
		assert.deepEqual(steps(new WheelScrollAccelerator("auto", true), [0, 5]), [1, 6]);
	});

	test("a pause over 200 ms or a change of direction starts a new gesture", () => {
		assert.deepEqual(steps(new WheelScrollAccelerator("auto", true), [0, 20, 201, 20]), [1, 5, 1, 5]);
		assert.deepEqual(steps(new WheelScrollAccelerator("auto", true), [0, 20, 200, 20]), [1, 5, 1, 1]);
		const turning = new WheelScrollAccelerator("auto", true);
		assert.deepEqual(
			[turning.next(-1, 0), turning.next(-1, 20), turning.next(1, 40), turning.next(1, 60)],
			[1, 5, 1, 5],
		);
	});

	test("setLines applies the new setting and forgets the gesture in progress", () => {
		const accelerator = new WheelScrollAccelerator(4, true);
		assert.equal(accelerator.next(-1, 0), 4);
		accelerator.setLines("auto");
		assert.deepEqual([accelerator.next(-1, 0), accelerator.next(-1, 20)], [1, 5]);
		accelerator.setLines("auto");
		assert.equal(accelerator.next(-1, 40), 1);
	});

	test('"auto" moves one row per event when the terminal accelerates the wheel itself', () => {
		assert.deepEqual(steps(new WheelScrollAccelerator("auto", false), [0, 10, 10]), [1, 1, 1]);
		assert.deepEqual(steps(new WheelScrollAccelerator(3, false), [0, 10]), [3, 3]);
	});

	test("only a local macOS terminal counts as accelerating the wheel", () => {
		const fastSpin = () => steps(new WheelScrollAccelerator(), [0, 20]).at(-1);
		for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) vi.stubEnv(name, undefined);
		Object.defineProperty(process, "platform", { value: "linux" });
		assert.equal(fastSpin(), 5);
		Object.defineProperty(process, "platform", { value: "darwin" });
		assert.equal(fastSpin(), 1);
		for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) {
			vi.stubEnv(name, "remote");
			assert.equal(fastSpin(), 5, `${name} marks a remote terminal`);
			vi.stubEnv(name, undefined);
		}
	});
});
