import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "vitest";
import { recordSettlement, settleVirtually, useVirtualTime } from "../helpers/routing-provider.js";

const DEADLINE_MS = 300_000;
const READY_AFTER_MS = 10;
/** Each read needs its own event-loop turn, so many of them keep file I/O in flight far longer than one turn. */
const FILE_READS = 50;
const MACROTASK_TURNS = 50;

beforeEach(useVirtualTime);

/**
 * An operation that finishes `realWork`, then needs `READY_AFTER_MS` of virtual time, while a
 * deadline timer is armed from the start. It resolves to the virtual time it took, or rejects
 * if the deadline fires first.
 */
function operationUnderDeadline(realWork: () => Promise<unknown>): Promise<number> {
	const started = Date.now();
	const deadline = new Promise<never>((_resolve, reject) =>
		setTimeout(
			() => reject(new Error("the deadline fired while the operation was still doing real work")),
			DEADLINE_MS,
		),
	);
	const ready = realWork().then(() => new Promise<void>((resolve) => setTimeout(resolve, READY_AFTER_MS)));
	return Promise.race([ready, deadline]).then(() => Date.now() - started);
}

test("virtual time does not reach a deadline while file reads are still in flight", async () => {
	const thisFile = fileURLToPath(import.meta.url);
	const settlement = recordSettlement(
		operationUnderDeadline(async () => {
			for (let read = 0; read < FILE_READS; read++) await readFile(thisFile);
		}),
	);
	await settleVirtually(settlement);
	const result = await settlement;
	assert.ok(result.ok, "the deadline fired under a healthy operation");
	assert.equal(result.value, READY_AFTER_MS);
});

test("virtual time does not reach a deadline while real macrotasks are still being scheduled", async () => {
	const settlement = recordSettlement(
		operationUnderDeadline(async () => {
			for (let turn = 0; turn < MACROTASK_TURNS; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
		}),
	);
	await settleVirtually(settlement);
	const result = await settlement;
	assert.ok(result.ok, "the deadline fired under a healthy operation");
	assert.equal(result.value, READY_AFTER_MS);
});

test("virtual time jumps to the only pending timer when no real work is in flight", async () => {
	const started = Date.now();
	await settleVirtually(new Promise<void>((resolve) => setTimeout(resolve, DEADLINE_MS)));
	assert.equal(Date.now() - started, DEADLINE_MS);
});
