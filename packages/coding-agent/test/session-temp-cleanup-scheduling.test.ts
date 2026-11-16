import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
	CLEANUP_MARKER_FILE,
	deferredSessionTempCleanupSettledForTesting,
	resetSessionTempCleanupScheduleForTesting,
	SESSION_TEMP_CLEANUP_DELAY_MS,
	scheduleSessionTempCleanup,
} from "../src/core/tools/session-temp-cleanup.js";
import { getTempRootDir, resetSessionTempDirStateForTesting } from "../src/core/tools/session-temp-dir.ts";
import {
	readWindowsDirectorySecurity,
	setWindowsDirectorySecurityReaderForTesting,
} from "../src/core/tools/windows-directory-security.ts";

/** A sweep that reads one real PowerShell descriptor: each attempt is bounded by 30 s, and a loaded host takes them all. */
const DEFERRED_SWEEP_TEST_TIMEOUT_MS = 90_000;

const sandboxes: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	resetSessionTempCleanupScheduleForTesting();
	setWindowsDirectorySecurityReaderForTesting(undefined);
	resetSessionTempDirStateForTesting();
	for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
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

test.skipIf(process.platform !== "win32")(
	"the deferred sweep reads the temp root's descriptor without holding the event loop (#5324)",
	async () => {
		const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-deferred-sweep-")));
		sandboxes.push(sandbox);
		for (const key of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(key, sandbox);
		resetSessionTempDirStateForTesting();
		const root = getTempRootDir();
		mkdirSync(root);
		const heldReads: string[] = [];
		setWindowsDirectorySecurityReaderForTesting((path) => {
			heldReads.push(path);
			return readWindowsDirectorySecurity(path);
		});

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		scheduleSessionTempCleanup({ sessionsRoots: [] });
		vi.advanceTimersByTime(SESSION_TEMP_CLEANUP_DELAY_MS);
		vi.useRealTimers();
		await deferredSessionTempCleanupSettledForTesting();

		assert.deepEqual(heldReads, [], "the sweep read no descriptor on the main thread");
		assert.ok(existsSync(join(root, CLEANUP_MARKER_FILE)), "the sweep ran once the temp root was verified");
	},
	DEFERRED_SWEEP_TEST_TIMEOUT_MS,
);
