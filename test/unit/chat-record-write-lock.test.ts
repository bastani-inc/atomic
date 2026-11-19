import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import {
	assertChatRecordWaitsWithoutStoppingTheEventLoop,
	CHAT_RECORD_LOCK_CASES,
} from "../helpers/chat-record-write-lock.js";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

test.each(CHAT_RECORD_LOCK_CASES)(
	"saving %s waits for another process's SQLite write lock without stopping the event loop, as main's append does (#5682)",
	(which) => assertChatRecordWaitsWithoutStoppingTheEventLoop(which),
	30_000,
);

test("a saved diagnostic also keeps the event loop running on Bun while another process holds the lock (#5682)", () => {
	const result = spawnSyncCollect([
		bunExecutable(),
		"test",
		join(moduleDir(import.meta.url), "../fixtures/chat-record-write-lock.bun.ts"),
	]);
	assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
}, 90_000);
