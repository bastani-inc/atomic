import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn };
});

const { evaluateWindowsDirectorySecurity, readWindowsDirectorySecurityAsync } = await import(
	"../src/core/tools/windows-directory-security.js"
);

test("the native descriptor worker agrees with the direct reader for existing and missing paths (#5324)", async () => {
	const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		windowsDirectorySecurity(
			path: string,
		): import("../src/core/tools/windows-directory-security.js").WindowsDirectorySecurity | null;
		windowsDirectorySecurityAsync(
			path: string,
		): Promise<import("../src/core/tools/windows-directory-security.js").WindowsDirectorySecurity | null>;
	};
	const dir = mkdtempSync(join(tmpdir(), "atomic-native-descriptor-"));
	try {
		for (const path of [dir, join(dir, "missing")]) {
			const reading = binding.windowsDirectorySecurityAsync(path);
			assert.equal(typeof reading.then, "function");
			assert.deepEqual((await reading) ?? null, binding.windowsDirectorySecurity(path) ?? null);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "win32")(
	"a directory's descriptor is read without starting PowerShell, so a loaded host cannot hold the main thread on it (#5324)",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-native-descriptor-"));
		try {
			const security = await readWindowsDirectorySecurityAsync(dir);

			assert.ok(security, "the descriptor of an owned directory is readable");
			assert.match(security.currentSid, /^S-1-/);
			assert.match(security.ownerSid, /^S-1-/);
			assert.equal(evaluateWindowsDirectorySecurity(security), undefined);
			assert.deepEqual(spawn.mock.calls, [], "no PowerShell process was started");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
