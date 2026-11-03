/**
 * How a print-mode run reads a piped stdin (#4224), against a stream the test writes to on its own schedule: input
 * that has started arriving by the deadline is read to its end, even when its first character is split across the
 * deadline, and a wait too long for a timer is not cut short.
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import { readPipedStdin } from "../src/main-stdio.js";

/** The deadline the cases below cross: short, so the test waits well past it. */
const SHORT_TIMEOUT_MS = 20;
/** Comfortably past `SHORT_TIMEOUT_MS`, also on a loaded machine. */
const PAST_THE_DEADLINE_MS = 200;

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

test("a first character split across the deadline is read with the rest of the input (#4224)", async () => {
	vi.stubEnv("ATOMIC_STDIN_TIMEOUT_MS", String(SHORT_TIMEOUT_MS));
	const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
	for (const character of ["é", "€", "𝄞"]) {
		const bytes = Buffer.from(character);
		const stdin = new PassThrough();
		const input = readPipedStdin({ hasPrompt: true, stdin });
		// The character's first byte arrives before the deadline, and the rest of it after.
		stdin.write(bytes.subarray(0, 1));
		await sleep(PAST_THE_DEADLINE_MS);
		stdin.end(Buffer.concat([bytes.subarray(1), Buffer.from(" Say hi.")]));

		assert.equal(await input, `${character} Say hi.`);
	}
	assert.deepEqual(warnings.mock.calls, []);
});

test("a wait longer than a timer can hold is not cut short (#4224)", async () => {
	vi.stubEnv("ATOMIC_STDIN_TIMEOUT_MS", "2147483648");
	const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
	const stdin = new PassThrough();
	const input = readPipedStdin({ hasPrompt: true, stdin });
	await sleep(PAST_THE_DEADLINE_MS);
	stdin.end("arrived after a while");

	assert.equal(await input, "arrived after a while");
	assert.deepEqual(warnings.mock.calls, []);
});
