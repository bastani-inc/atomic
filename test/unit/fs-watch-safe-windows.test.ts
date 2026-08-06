import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "vitest";
import {
	isSafeFsWatchPathError,
	isUnsafeWindowsShortPath,
	resolveNativeWatchPath,
	SAFE_FS_WATCH_CANONICALIZATION_FAILED,
	SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH,
	watchWithErrorHandler,
} from "../../packages/coding-agent/src/utils/fs-watch.js";

class FakeWatcher extends EventEmitter {
	closed = false;

	close(): void {
		this.closed = true;
	}

	ref(): this {
		return this;
	}

	unref(): this {
		return this;
	}
}

describe("safe fs.watch path handling", () => {
	test("detects Windows 8.3 short-name path components", () => {
		assert.equal(isUnsafeWindowsShortPath(String.raw`C:\Users\USERNA~1\AppData\Local\Temp`, "win32"), true);
		assert.equal(isUnsafeWindowsShortPath(String.raw`C:\PROGRA~1\Atomic\theme.json`, "win32"), true);
		assert.equal(isUnsafeWindowsShortPath(String.raw`C:\Users\Alex Lavaee\AppData\Local\Temp`, "win32"), false);
		assert.equal(isUnsafeWindowsShortPath("/tmp/USERNA~1", "linux"), false);
	});

	test("canonicalizes Windows watch paths before native fs.watch", () => {
		const watchedPaths: string[] = [];
		const watcher = watchWithErrorHandler(
			String.raw`C:\Users\USERNA~1\AppData\Local\Temp\atomic`,
			() => {},
			() => assert.fail("canonicalized safe path should not report an error"),
			{
				platform: "win32",
				realpathSyncNative: () => String.raw`C:\Users\Alex Lavaee\AppData\Local\Temp\atomic`,
				watch: (path) => {
					watchedPaths.push(path);
					return new FakeWatcher();
				},
			},
		);

		assert.ok(watcher);
		assert.deepEqual(watchedPaths, [String.raw`C:\Users\Alex Lavaee\AppData\Local\Temp\atomic`]);
	});

	test("rejects native fs.watch when canonicalization fails or remains unsafe", () => {
		const errors: Error[] = [];
		let watchCalls = 0;

		const failed = watchWithErrorHandler(
			String.raw`C:\Users\USERNA~1\AppData\Local\Temp\atomic`,
			() => {},
			(error) => errors.push(error),
			{
				platform: "win32",
				realpathSyncNative: () => {
					throw new Error("realpath failed");
				},
				watch: () => {
					watchCalls += 1;
					return new FakeWatcher();
				},
			},
		);

		const unsafe = resolveNativeWatchPath(String.raw`C:\Users\USERNA~1\AppData\Local\Temp\atomic`, {
			platform: "win32",
			realpathSyncNative: () => String.raw`C:\Users\USERNA~1\AppData\Local\Temp\atomic`,
		});

		assert.equal(failed, null);
		assert.equal(watchCalls, 0);
		assert.equal(errors[0]?.message.includes("Cannot canonicalize Windows fs.watch path"), true);
		assert.equal(isSafeFsWatchPathError(errors[0]), true);
		assert.equal(
			isSafeFsWatchPathError(errors[0]) ? errors[0].code : undefined,
			SAFE_FS_WATCH_CANONICALIZATION_FAILED,
		);
		assert.ok("error" in unsafe);
		assert.equal("error" in unsafe ? unsafe.error.code : undefined, SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH);
	});
});
