import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	isSafeFsWatchPathError,
	isUnsafeWindowsShortPath,
	resolveNativeWatchPath,
	SAFE_FS_WATCH_CANONICALIZATION_FAILED,
	SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH,
	watchWithErrorHandler,
} from "../../packages/coding-agent/src/utils/fs-watch.js";
import { createResultWatcher } from "../../packages/subagents/src/runs/background/result-watcher.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentState } from "../../packages/subagents/src/shared/types.js";

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

function waitForTimers(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 25));
}

function makeSubagentState(): SubagentState {
	return {
		baseCwd: "/repo",
		currentSessionId: "session-1",
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

describe("safe fs.watch path handling", () => {
	test("detects Windows 8.3 short-name path components", () => {
		assert.equal(isUnsafeWindowsShortPath(String.raw`C:\Users\USERNA~1\AppData\Local\Temp`, "win32"), true);
		assert.equal(isUnsafeWindowsShortPath(String.raw`C:\PROGRA~1\Atomic\theme.json`, "win32"), true);
		assert.equal(isUnsafeWindowsShortPath(String.raw`C:\Users\Alex Lavaee\AppData\Local\Temp`, "win32"), false);
		assert.equal(isUnsafeWindowsShortPath(String.raw`/tmp/USERNA~1`, "linux"), false);
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
		assert.equal(isSafeFsWatchPathError(errors[0]) ? errors[0].code : undefined, SAFE_FS_WATCH_CANONICALIZATION_FAILED);
		assert.ok("error" in unsafe);
		assert.equal("error" in unsafe ? unsafe.error.code : undefined, SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH);
	});

	test("subagent result watcher falls back to polling when safe watch refuses a path", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-result-watch-"));
		const resultPath = join(dir, "run-1.json");
		writeFileSync(resultPath, JSON.stringify({
			id: "run-1",
			agent: "worker",
			success: true,
			summary: "done",
			sessionId: "session-1",
			cwd: "/repo",
		}));

		const completed: unknown[] = [];
		const completeHandlers: Array<(data: unknown) => void> = [];
		const events = {
			on: (channel: string, handler: (data: unknown) => void): (() => void) => {
				if (channel === SUBAGENT_ASYNC_COMPLETE_EVENT) {
					completeHandlers.push(handler);
				}
				return () => {};
			},
			emit: (channel: string, data: unknown): void => {
				if (channel === SUBAGENT_ASYNC_COMPLETE_EVENT) {
					completed.push(data);
					for (const handler of completeHandlers) {
						handler(data);
					}
				}
			},
		};
		const state = makeSubagentState();
		const safeWatchError = Object.assign(new Error("unsafe path"), {
			code: SAFE_FS_WATCH_UNSAFE_WINDOWS_SHORT_PATH,
			watchedPath: String.raw`C:\Users\USERNA~1\AppData\Local\Temp\atomic-results`,
		});
		let safeWatchCalled = false;

		const watcher = createResultWatcher({ events }, state, dir, 60_000, {
			safeWatch: (_path, _listener, onError) => {
				safeWatchCalled = true;
				onError(safeWatchError);
				return null;
			},
		});

		try {
			watcher.startResultWatcher();
			await waitForTimers();
			assert.equal(safeWatchCalled, true);
			assert.equal(completed.length, 1);
			assert.equal(existsSync(resultPath), false);
		} finally {
			watcher.stopResultWatcher();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
