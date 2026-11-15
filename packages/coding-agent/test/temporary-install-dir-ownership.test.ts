/**
 * Temporary extension installs (`-e npm:…`, `-e git:…`) live under the system
 * temp directory, so the directory holding them must belong to the current
 * account alone. Anything else found at that path is refused, never adopted.
 */
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest";
import { getGitInstallPath, getNpmInstallRoot } from "../src/core/package-manager-paths.ts";
import type { PackageLocationContext } from "../src/core/package-manager-types.ts";
import { getTempRootDir, resetSessionTempDirStateForTesting } from "../src/core/tools/session-temp-dir.ts";
import { isPathInside } from "../src/utils/path-inside.js";

const isPosix = process.platform !== "win32";
const envKeys = ["TMPDIR", "TEMP", "TMP"] as const;
const savedEnv = new Map<string, string | undefined>();
let sandbox: string;
let context: PackageLocationContext;

beforeAll(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-temp-install-owner-")));
	context = { cwd: sandbox, agentDir: join(sandbox, "agent") } as PackageLocationContext;
});

beforeEach(() => {
	// A fresh shared temp directory per test, so one test's state never leaks.
	const shared = mkdtempSync(join(sandbox, "tmp-"));
	for (const key of envKeys) {
		if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
		process.env[key] = shared;
	}
	resetSessionTempDirStateForTesting();
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSessionTempDirStateForTesting();
});

afterAll(() => {
	for (const key of envKeys) {
		const saved = savedEnv.get(key);
		if (saved === undefined) delete process.env[key];
		else process.env[key] = saved;
	}
	rmSync(sandbox, { recursive: true, force: true });
});

describe("temporary extension install directories", () => {
	it("temporary extension installs use a directory only the current user owns", () => {
		const root = getNpmInstallRoot(context, "temporary", true);

		assert.ok(isPathInside(getTempRootDir(), root), `${root} is inside the per-user temp root`);
		assert.ok(isPathInside(tmpdir(), root));
		// Every directory already created between the per-user root and the install is private.
		let checked = 0;
		for (let dir = root; dir === getTempRootDir() || isPathInside(getTempRootDir(), dir); dir = dirname(dir)) {
			if (!existsSync(dir)) continue;
			const stat = lstatSync(dir);
			assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), dir);
			if (isPosix) {
				assert.equal(stat.uid, process.getuid!(), dir);
				assert.equal(stat.mode & 0o077, 0, `${dir} has no group or other access`);
			}
			checked++;
		}
		assert.ok(checked >= 2, "the per-user root and the install directory parent exist");
	});

	it("temporary git checkouts share the same per-user directory", () => {
		const checkout = getGitInstallPath(context, { host: "github.com", path: "owner/repo" }, "temporary");
		assert.ok(isPathInside(getTempRootDir(), checkout));
	});

	it.skipIf(!isPosix)("refuses a pre-existing directory owned by another account", () => {
		const realUid = process.getuid!();
		vi.spyOn(process, "getuid").mockReturnValue(realUid + 1);
		resetSessionTempDirStateForTesting();
		// The directory exists under the name the (other) account expects but is not owned by it.
		mkdirSync(getTempRootDir(), { mode: 0o700 });

		assert.throws(() => getNpmInstallRoot(context, "temporary", true), /owned by another account/);
	});

	it.skipIf(!isPosix)("refuses a symbolic link in place of the per-user directory", () => {
		const elsewhere = join(sandbox, "planted");
		mkdirSync(elsewhere, { mode: 0o700, recursive: true });
		symlinkSync(elsewhere, getTempRootDir(), "dir");

		assert.throws(() => getNpmInstallRoot(context, "temporary", true), /symbolic link/);
	});

	it.skipIf(!isPosix)("refuses a group-writable directory instead of repairing it", () => {
		mkdirSync(getTempRootDir(), { mode: 0o700 });
		const extensions = join(getTempRootDir(), "extensions");
		mkdirSync(extensions, { mode: 0o700 });
		chmodSync(extensions, 0o770);

		assert.throws(() => getNpmInstallRoot(context, "temporary", true), /accessible to other accounts/);
		assert.equal(statSync(extensions).mode & 0o777, 0o770, "the refused directory is left as found");
	});

	it.runIf(process.platform === "win32")("uses the account's own temp directory on Windows", () => {
		const root = getNpmInstallRoot(context, "temporary", true);
		assert.ok(isPathInside(tmpdir(), root));
		assert.ok(statSync(dirname(root)).isDirectory());
	});
});
