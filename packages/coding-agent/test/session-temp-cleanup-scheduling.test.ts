import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, test, vi } from "vitest";
import {
	resetSessionTempCleanupScheduleForTesting,
	scheduleSessionTempCleanup,
} from "../src/core/tools/session-temp-cleanup.ts";

afterEach(() => {
	vi.restoreAllMocks();
	resetSessionTempCleanupScheduleForTesting();
});

test("the deferred sweep is armed once, outside the async context of the session that asked for it (#4309)", () => {
	const session = new AsyncLocalStorage<string>();
	const realSetTimeout = globalThis.setTimeout;
	const armedIn: (string | undefined)[] = [];
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler, delay, ...args) => {
		armedIn.push(session.getStore());
		return realSetTimeout(handler, delay, ...args);
	}) as typeof setTimeout);
	resetSessionTempCleanupScheduleForTesting();

	session.run("session-a", () => scheduleSessionTempCleanup({ sessionsRoots: [] }));
	session.run("session-b", () => scheduleSessionTempCleanup({ sessionsRoots: [] }));

	assert.deepEqual(armedIn, [undefined]);
});
