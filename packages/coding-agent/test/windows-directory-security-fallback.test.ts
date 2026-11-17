import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { spawnSyncCollect } from "../../../test/helpers/runtime.ts";
import {
	evaluateWindowsDirectorySecurity,
	getLastWindowsSecurityReadFailureForTesting,
	readWindowsDirectorySecurityAsync,
	type WindowsDirectorySecurity,
} from "../src/core/tools/windows-directory-security.js";

const { loadNativeModule } = vi.hoisted(() => ({
	loadNativeModule: vi.fn(() => {
		throw new Error("native reader unavailable");
	}),
}));

vi.mock("../src/utils/module-require.js", () => ({
	createModuleRequire: () => loadNativeModule,
}));

test.skipIf(process.platform !== "win32")(
	"the PowerShell fallback reads the same owned and shared descriptors as the native reader (#5324)",
	async () => {
		const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
			windowsDirectorySecurity: (path: string) => WindowsDirectorySecurity | null;
		};
		const sandbox = mkdtempSync(join(tmpdir(), "atomic-fallback-acl-"));
		try {
			const initial = binding.windowsDirectorySecurity(sandbox);
			assert.ok(initial, "the native reader reads the fixture's current SID");
			const own = join(sandbox, "owned");
			const shared = join(sandbox, "shared");
			for (const path of [own, shared]) {
				mkdirSync(path);
				const restricted = spawnSyncCollect([
					"icacls",
					path,
					"/inheritance:r",
					"/grant:r",
					`*${initial.currentSid}:(OI)(CI)F`,
					"*S-1-5-18:(OI)(CI)F",
					"*S-1-5-32-544:(OI)(CI)F",
				]);
				assert.equal(restricted.exitCode, 0, restricted.stderr.toString());
			}
			const granted = spawnSyncCollect(["icacls", shared, "/grant", "*S-1-1-0:(OI)(CI)F"]);
			assert.equal(granted.exitCode, 0, granted.stderr.toString());
			const rules = (descriptor: WindowsDirectorySecurity) =>
				descriptor.accessRules.map((rule) => `${rule.allow ? "allow" : "deny"} ${rule.sid}`).sort();

			for (const [path, verdict] of [
				[own, undefined],
				[shared, "it grants access to another account"],
			] as const) {
				const native = binding.windowsDirectorySecurity(path);
				assert.ok(native, `the native reader reads ${path}`);
				const fallback = await readWindowsDirectorySecurityAsync(path);
				assert.ok(fallback, `the fallback reads ${path}: ${getLastWindowsSecurityReadFailureForTesting()}`);
				assert.equal(fallback.currentSid, native.currentSid);
				assert.equal(fallback.ownerSid, native.ownerSid);
				assert.deepEqual(rules(fallback), rules(native));
				assert.equal(evaluateWindowsDirectorySecurity(native), verdict);
				assert.equal(evaluateWindowsDirectorySecurity(fallback), verdict);
			}
			assert.deepEqual(loadNativeModule.mock.calls, [["@bastani/atomic-natives"]]);
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	},
);
