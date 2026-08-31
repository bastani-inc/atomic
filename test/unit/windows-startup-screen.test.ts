import assert from "node:assert/strict";
import { test } from "vitest";
import { StartupScreenTracker } from "../../scripts/perf/windows-startup/screen.js";

const ms = (value: number): bigint => BigInt(value) * 1_000_000n;
const clear = "\u001b[2J\u001b[H";
const finalFrame = `${clear}Atomic v0.0.0\r\nWe question,\r\nwe break away from what is accepted.\r\n\u001b[1mEngineering matters.\u001b[22m\r\n\r\n❯ hello`;

async function feedInPieces(tracker: StartupScreenTracker, bytes: Uint8Array, cuts: readonly number[]): Promise<void> {
	let start = 0;
	for (const end of [...cuts, bytes.length]) {
		await tracker.write(bytes.subarray(start, end), ms(end));
		start = end;
	}
}

test("fragmented ANSI and UTF-8 chunks produce the same startup screen", async () => {
	const whole = new StartupScreenTracker("0.0.0", { cols: 120, rows: 40 });
	const split = new StartupScreenTracker("0.0.0", { cols: 120, rows: 40 });
	const encoded = new TextEncoder().encode(finalFrame.replace("hello", "héllo"));
	await whole.write(encoded, ms(1));
	await feedInPieces(split, encoded, [1, 4, 9, encoded.indexOf(0xc3) + 1]);
	assert.deepEqual({ ...split.snapshot(), atNs: "ignored" }, { ...whole.snapshot(), atNs: "ignored" });
});

test("an intermediate startup identity cannot satisfy strict completion", async () => {
	const tracker = new StartupScreenTracker("0.0.0", { cols: 120, rows: 40, animationIntervalMs: 80 });
	await tracker.write(
		`${clear}Atomic v0.0.0\r\nWe question,\r\nwe break away from what is accepted.\r\nEngineering matters.\r\n\r\n❯ `,
		ms(0),
	);
	const first = tracker.observe(ms(0));
	const later = tracker.observe(ms(100));
	assert.equal(first.coherent, true);
	assert.equal(first.complete, false);
	assert.equal(later.complete, false);
});

test("the cursor must be inside the editor after the prompt", async () => {
	const tracker = new StartupScreenTracker("0.0.0", { cols: 120, rows: 40 });
	await tracker.write(
		`${clear}Atomic v0.0.0\r\nWe question,\r\nwe break away from what is accepted.\r\nEngineering matters.\r\n❯ draft\u001b[H`,
		ms(0),
	);
	assert.equal(tracker.observe(ms(0)).coherent, false);
});

test("strict completion requires identical final frames separated by an animation interval", async () => {
	const tracker = new StartupScreenTracker("0.0.0", { cols: 120, rows: 40, animationIntervalMs: 80 });
	await tracker.write(finalFrame, ms(10));
	assert.equal(tracker.observe(ms(10)).complete, false);
	assert.equal(tracker.observe(ms(89)).complete, false);
	assert.equal(tracker.observe(ms(90)).complete, true);
});
