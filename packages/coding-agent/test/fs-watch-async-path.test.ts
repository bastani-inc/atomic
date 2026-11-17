import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { test } from "vitest";
import { SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH, watchWithErrorHandlerAsync } from "../src/utils/fs-watch.ts";

const blockingRealpath = (): string => {
	throw new Error("the synchronous realpath blocks the event loop");
};

test("a Windows watch canonicalizes its path without the synchronous realpath", async () => {
	const watched: string[] = [];
	const errors: Error[] = [];
	const watcher = await watchWithErrorHandlerAsync(
		"C:\\repo\\.git",
		() => {},
		(error) => errors.push(error),
		{
			platform: "win32",
			realpathSyncNative: blockingRealpath,
			realpathNative: async (path) => `${path}\\resolved`,
			watch: (path) => {
				watched.push(path);
				return new EventEmitter() as FSWatcher;
			},
		},
	);
	assert.deepEqual(errors, []);
	assert.notEqual(watcher, null);
	assert.deepEqual(watched, ["C:\\repo\\.git\\resolved"]);
});

test("a Windows short name found without blocking is still refused before it is watched", async () => {
	const errors: Error[] = [];
	const watcher = await watchWithErrorHandlerAsync(
		"C:\\repo",
		() => {},
		(error) => errors.push(error),
		{
			platform: "win32",
			realpathSyncNative: blockingRealpath,
			realpathNative: async () => "C:\\PROGRA~1\\repo",
			watch: () => {
				throw new Error("an unsafe short-name path must not be watched");
			},
		},
	);
	assert.equal(watcher, null);
	assert.equal((errors[0] as Error & { code?: string }).code, SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH);
});
