import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";

const sync = vi.hoisted(() => ({ calls: [] as string[], active: false }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	function watch<T extends object>(name: string, operation: T): T {
		return new Proxy(operation, {
			apply(target, receiver, args) {
				if (sync.active) sync.calls.push(name);
				return Reflect.apply(target as (...args: never[]) => object, receiver, args);
			},
		});
	}
	return {
		...actual,
		lstatSync: watch("lstatSync", actual.lstatSync),
		statSync: watch("statSync", actual.statSync),
		mkdirSync: watch("mkdirSync", actual.mkdirSync),
		realpathSync: watch("realpathSync", actual.realpathSync),
		rmSync: watch("rmSync", actual.rmSync),
	};
});

const { getSessionTempDirAsync, resetSessionTempDirStateForTesting } = await import(
	"../src/core/tools/session-temp-dir.js"
);
const { setWindowsDirectorySecurityReaderForTesting, waitForWindowsDirectorySecurityReadsForTesting } = await import(
	"../src/core/tools/windows-directory-security.js"
);

const PRIVATE_DESCRIPTOR = { currentSid: "S-1-5-21-1", ownerSid: "S-1-5-21-1", dacl: "D:", accessRules: [] };

test("asynchronous Windows session directories perform no synchronous filesystem operations (#5324)", async () => {
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-async-directory-")));
	const root = join(sandbox, "tmp");
	mkdirSync(root);
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	for (const key of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(key, root);
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	resetSessionTempDirStateForTesting();
	setWindowsDirectorySecurityReaderForTesting(() => PRIVATE_DESCRIPTOR);
	try {
		sync.calls = [];
		sync.active = true;
		const dir = await getSessionTempDirAsync("async-filesystem");
		await getSessionTempDirAsync("async-filesystem-second");
		sync.active = false;
		assert.ok(dir.startsWith(root));
		assert.deepEqual(sync.calls, [], "a pending filesystem operation must not hold the main thread");
	} finally {
		sync.active = false;
		resetSessionTempDirStateForTesting();
		await waitForWindowsDirectorySecurityReadsForTesting();
		if (platform) Object.defineProperty(process, "platform", platform);
		vi.unstubAllEnvs();
		rmSync(sandbox, { recursive: true, force: true });
	}
});
