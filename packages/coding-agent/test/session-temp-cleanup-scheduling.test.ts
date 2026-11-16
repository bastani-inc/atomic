import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

const spawned = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	spawned.spawnSync.mockImplementation(actual.spawnSync);
	return { ...actual, spawnSync: spawned.spawnSync };
});

const {
	CLEANUP_MARKER_FILE,
	resetSessionTempCleanupScheduleForTesting,
	SESSION_TEMP_CLEANUP_DELAY_MS,
	scheduleSessionTempCleanup,
} = await import("../src/core/tools/session-temp-cleanup.js");
const { getTempRootDir, resetSessionTempDirStateForTesting } = await import("../src/core/tools/session-temp-dir.ts");

const sandboxes: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	resetSessionTempCleanupScheduleForTesting();
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
	"the deferred sweep verifies the temp root without starting PowerShell on the main thread (#5324)",
	() => {
		const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-deferred-sweep-")));
		sandboxes.push(sandbox);
		for (const key of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(key, sandbox);
		resetSessionTempDirStateForTesting();
		const root = getTempRootDir();
		mkdirSync(root);
		spawned.spawnSync.mockClear();

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		scheduleSessionTempCleanup({ sessionsRoots: [] });
		vi.advanceTimersByTime(SESSION_TEMP_CLEANUP_DELAY_MS);

		assert.ok(existsSync(join(root, CLEANUP_MARKER_FILE)), "the sweep verified the temp root and ran");
		assert.deepEqual(
			spawned.spawnSync.mock.calls
				.map(([command]) => String(command))
				.filter((command) => /powershell|pwsh/i.test(command)),
			[],
			"no PowerShell process held the main thread",
		);
	},
);
