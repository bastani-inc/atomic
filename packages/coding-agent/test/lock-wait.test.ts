import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import * as takeover from "../src/core/lock-takeover.ts";
import { waitForLock } from "../src/core/lock-wait.ts";

afterEach(() => vi.restoreAllMocks());

test("a lock wait cancelled during process-start preparation never acquires the lock (#5315)", async () => {
	const controller = new AbortController();
	const reason = new Error("cancelled while preparing the lock");
	vi.spyOn(takeover, "prepareTakeoverMutex").mockImplementation(async () => {
		controller.abort(reason);
	});
	let acquisitions = 0;
	const waiting = waitForLock(
		async () => {
			acquisitions++;
		},
		{
			lockPath: join(tmpdir(), `atomic-lock-wait-${randomUUID()}`),
			staleMs: 10_000,
			holderWaitMs: 1_000,
			pollMinMs: 10,
			pollMaxMs: 50,
			retryable: () => false,
			stuck: () => new Error("holder did not release the lock"),
			contended: () => new Error("lock wait exceeded its bound"),
		},
		controller.signal,
	);
	await assert.rejects(waiting, (error) => error === reason);
	assert.equal(acquisitions, 0);
});
