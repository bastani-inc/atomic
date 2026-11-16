/**
 * Temporary extension installs (`-e npm:…`, `-e git:…`) need a directory that
 * belongs to the current account alone. A root other accounts cannot create
 * is preferred; anything found at a candidate path that is not private to this
 * account is refused (never adopted or repaired), and the next candidate is
 * used, so a directory planted by someone else neither hijacks nor blocks them.
 */
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getGitInstallPath, getNpmInstallRoot } from "../src/core/package-manager-paths.ts";
import type { PackageLocationContext } from "../src/core/package-manager-types.ts";
import {
	assertPrivateDirectory,
	ensurePrivateTempDir,
	ensurePrivateTempDirAsync,
	getTempRootDir,
	resetSessionTempDirStateForTesting,
} from "../src/core/tools/session-temp-dir.ts";
import {
	readWindowsDirectorySecurity,
	readWindowsDirectorySecurityAsync,
	setWindowsDirectorySecurityAsyncReaderForTesting,
	setWindowsDirectorySecurityReaderForTesting,
} from "../src/core/tools/windows-directory-security.ts";
import { isPathInside } from "../src/utils/path-inside.js";

const isPosix = process.platform !== "win32";
const envKeys = ["TMPDIR", "TEMP", "TMP", "XDG_RUNTIME_DIR", ENV_AGENT_DIR] as const;
const savedEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));
let sandbox: string;
let shared: string;
let agentDir: string;
let context: PackageLocationContext;

beforeAll(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-temp-install-owner-")));
});

beforeEach(() => {
	// A fresh shared temp directory and agent directory per test, and no runtime directory unless a test sets one.
	shared = mkdtempSync(join(sandbox, "tmp-"));
	for (const key of ["TMPDIR", "TEMP", "TMP"]) process.env[key] = shared;
	agentDir = join(mkdtempSync(join(sandbox, "home-")), "agent");
	process.env[ENV_AGENT_DIR] = agentDir;
	delete process.env.XDG_RUNTIME_DIR;
	context = { cwd: sandbox, agentDir } as PackageLocationContext;
	resetSessionTempDirStateForTesting();
});

afterEach(() => {
	vi.restoreAllMocks();
	setWindowsDirectorySecurityReaderForTesting(undefined);
	setWindowsDirectorySecurityAsyncReaderForTesting(undefined);
	resetSessionTempDirStateForTesting();
});

afterAll(() => {
	for (const [key, saved] of savedEnv) {
		if (saved === undefined) delete process.env[key];
		else process.env[key] = saved;
	}
	rmSync(sandbox, { recursive: true, force: true });
});

/** Every existing directory from `root` up to (not including) `stop` is a real directory private to this account. */
function assertPrivateChain(root: string, stop: string): void {
	let checked = 0;
	for (let dir = root; isPathInside(stop, dir) && dir !== stop; dir = dirname(dir)) {
		if (!existsSync(dir)) continue;
		const stat = lstatSync(dir);
		assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), dir);
		if (isPosix) {
			assert.equal(stat.uid, process.getuid!(), dir);
			assert.equal(stat.mode & 0o077, 0, `${dir} has no group or other access`);
		}
		checked++;
	}
	assert.ok(checked >= 1, `a private directory exists between ${stop} and ${root}`);
}

/** Make the agent cache unusable so the shared temp directory is the next candidate. */
function plantAgentCacheLink(): string {
	const elsewhere = mkdtempSync(join(sandbox, "agent-cache-target-"));
	mkdirSync(join(agentDir, "cache"), { recursive: true });
	symlinkSync(elsewhere, join(agentDir, "cache", "tmp"), "dir");
	return elsewhere;
}

describe("temporary extension install directories", () => {
	it.skipIf(!isPosix)("temporary extension installs prefer the per-user runtime directory", () => {
		const runtime = mkdtempSync(join(sandbox, "run-"));
		process.env.XDG_RUNTIME_DIR = runtime;

		const root = getNpmInstallRoot(context, "temporary", true);

		assert.ok(isPathInside(runtime, root), `${root} is inside the runtime directory`);
		assertPrivateChain(root, runtime);
	});

	it("without a runtime directory, temporary extension installs use the agent cache", () => {
		const root = getNpmInstallRoot(context, "temporary", true);

		assert.ok(isPathInside(join(agentDir, "cache", "tmp"), root), `${root} is inside the agent cache`);
		assertPrivateChain(root, agentDir);
	});

	it("temporary git checkouts share the same per-user directory", () => {
		const npm = getNpmInstallRoot(context, "temporary", true);
		const checkout = getGitInstallPath(context, { host: "github.com", path: "owner/repo" }, "temporary");
		assert.equal(dirname(dirname(dirname(dirname(checkout)))), dirname(dirname(npm)));
	});

	it.skipIf(!isPosix)("a shared runtime directory is not used", () => {
		const runtime = mkdtempSync(join(sandbox, "run-"));
		chmodSync(runtime, 0o777);
		process.env.XDG_RUNTIME_DIR = runtime;

		const root = getNpmInstallRoot(context, "temporary", true);

		assert.ok(!isPathInside(runtime, root));
		assert.deepEqual(readdirSync(runtime), [], "nothing is created in it");
	});

	it.skipIf(!isPosix)("the shared temp directory is used when the agent cache is unusable", () => {
		const elsewhere = plantAgentCacheLink();

		const root = getNpmInstallRoot(context, "temporary", true);

		assert.ok(isPathInside(getTempRootDir(), root), `${root} is inside the per-user temp root`);
		assertPrivateChain(root, shared);
		assert.deepEqual(readdirSync(elsewhere), [], "nothing is created through the planted link");
	});

	it.skipIf(!isPosix)("a pre-existing directory owned by another account is neither used nor blocking", () => {
		plantAgentCacheLink();
		const realUid = process.getuid!();
		vi.spyOn(process, "getuid").mockReturnValue(realUid + 1);
		resetSessionTempDirStateForTesting();
		// The directory exists under the name the (other) account expects but is not owned by it.
		const planted = getTempRootDir();
		mkdirSync(planted, { mode: 0o700 });

		const root = getNpmInstallRoot(context, "temporary", true);

		assert.ok(!isPathInside(planted, root), `${root} is not inside the planted directory`);
		assert.ok(isPathInside(shared, root));
		assert.ok(statSync(dirname(dirname(root))).isDirectory());
		assert.deepEqual(readdirSync(planted), [], "nothing is created in it");
		const nested = ensurePrivateTempDir("nested", "deeper");
		assert.ok(statSync(nested).isDirectory(), "nested names work in the fallback directory too");
		assert.ok(!isPathInside(planted, nested));
	});

	it.skipIf(!isPosix)("a symbolic link in place of the per-user directory is neither followed nor blocking", () => {
		plantAgentCacheLink();
		const elsewhere = mkdtempSync(join(sandbox, "planted-"));
		symlinkSync(elsewhere, getTempRootDir(), "dir");

		const root = getNpmInstallRoot(context, "temporary", true);

		assert.ok(!isPathInside(getTempRootDir(), root));
		assertPrivateChain(root, shared);
		assert.deepEqual(readdirSync(elsewhere), [], "nothing is created through the planted link");
	});

	it.skipIf(!isPosix)("a group-writable directory is neither repaired nor blocking", () => {
		plantAgentCacheLink();
		mkdirSync(getTempRootDir(), { mode: 0o700 });
		chmodSync(getTempRootDir(), 0o770);

		const root = getNpmInstallRoot(context, "temporary", true);

		assert.ok(!isPathInside(getTempRootDir(), root));
		assertPrivateChain(root, shared);
		assert.equal(statSync(getTempRootDir()).mode & 0o777, 0o770, "the refused directory is left as found");
		assert.deepEqual(readdirSync(getTempRootDir()), []);
	});

	it.runIf(process.platform === "win32")("uses a directory inside the account's own profile on Windows", () => {
		const root = getNpmInstallRoot(context, "temporary", true);
		assert.ok(isPathInside(agentDir, root) || isPathInside(tmpdir(), root), root);
		assert.ok(statSync(dirname(dirname(root))).isDirectory());
	});

	it.skipIf(!isPosix)("a runtime directory that is a link, a file or another account's is not used", () => {
		const real = mkdtempSync(join(sandbox, "run-real-"));
		const link = join(sandbox, `run-link-${Date.now()}`);
		symlinkSync(real, link, "dir");
		const file = join(sandbox, `run-file-${Date.now()}`);
		writeFileSync(file, "");
		for (const runtime of [link, file]) {
			process.env.XDG_RUNTIME_DIR = runtime;
			const root = getNpmInstallRoot(context, "temporary", true);
			assert.ok(isPathInside(agentDir, root), `${runtime}: ${root} falls back to the agent cache`);
		}
		assert.deepEqual(readdirSync(real), [], "nothing is created through the linked runtime directory");

		process.env.XDG_RUNTIME_DIR = real;
		vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
		resetSessionTempDirStateForTesting();
		const root = getNpmInstallRoot(context, "temporary", true);
		assert.ok(!isPathInside(real, root), `${root} avoids a runtime directory owned by another account`);
		assert.deepEqual(readdirSync(real), []);
	});

	it("only plain relative names are accepted below the private directory", () => {
		for (const segment of ["..", ".", "", "a//b", "a/../b"]) {
			assert.throws(() => ensurePrivateTempDir(segment), /not a plain relative path/, JSON.stringify(segment));
		}
		assert.ok(ensurePrivateTempDir("a/b").endsWith(join("a", "b")));
	});

	it("reports clearly when no private directory can be created", () => {
		const file = join(sandbox, `not-a-dir-${Date.now()}`);
		writeFileSync(file, "");
		for (const key of ["TMPDIR", "TEMP", "TMP"]) process.env[key] = join(file, "tmp");
		process.env[ENV_AGENT_DIR] = join(file, "agent");
		resetSessionTempDirStateForTesting();

		assert.throws(() => ensurePrivateTempDir("extensions"), /no directory private to this account could be created/);
	});

	it.skipIf(!isPosix)("a directory is private only when it is this account's own real directory", () => {
		const own = mkdtempSync(join(sandbox, "own-"));
		assert.doesNotThrow(() => assertPrivateDirectory(own));

		chmodSync(own, 0o500);
		assert.doesNotThrow(() => assertPrivateDirectory(own), "an owner-only mode is accepted");
		chmodSync(own, 0o700);

		chmodSync(own, 0o750);
		assert.throws(() => assertPrivateDirectory(own), /accessible to other accounts/);
		chmodSync(own, 0o700);

		const link = join(sandbox, `own-link-${Date.now()}`);
		symlinkSync(own, link, "dir");
		assert.throws(() => assertPrivateDirectory(link), /symbolic link/);

		vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
		assert.throws(() => assertPrivateDirectory(own), /owned by another account/);
	});

	it.runIf(process.platform === "win32")(
		"a directory already in use is not re-read from its security descriptor on every call",
		() => {
			let reads = 0;
			setWindowsDirectorySecurityReaderForTesting((path) => {
				reads++;
				return readWindowsDirectorySecurity(path);
			});
			const dir = ensurePrivateTempDir("extensions");
			writeFileSync(join(dir, "in-use.txt"), "");
			const firstReads = reads;
			assert.ok(firstReads > 0);

			for (let call = 0; call < 5; call++) assert.equal(ensurePrivateTempDir("extensions"), dir);
			assert.equal(reads, firstReads, "repeat calls cost no PowerShell security reads");
		},
	);

	it("the asynchronous form chooses the private directory the synchronous one returns (#5324)", async () => {
		const dir = await ensurePrivateTempDirAsync("extensions");

		assert.ok(isPathInside(join(agentDir, "cache", "tmp"), dir), `${dir} is inside the agent cache`);
		assertPrivateChain(dir, agentDir);
		assert.equal(ensurePrivateTempDir("extensions"), dir);
	});

	it.skipIf(!isPosix)(
		"the asynchronous form falls back past an agent cache that is not this account's (#5324)",
		async () => {
			const elsewhere = plantAgentCacheLink();

			const dir = await ensurePrivateTempDirAsync("extensions");

			assert.ok(isPathInside(getTempRootDir(), dir), `${dir} is inside the per-user temp root`);
			assert.deepEqual(readdirSync(elsewhere), [], "nothing is created through the planted link");
		},
	);

	it.runIf(process.platform === "win32")(
		"the asynchronous form falls back past an agent cache another account owns, reading descriptors only off the main thread (#5324)",
		async () => {
			const foreignCache = join(agentDir, "cache", "tmp");
			const heldReads: string[] = [];
			const asyncReads: string[] = [];
			setWindowsDirectorySecurityReaderForTesting((path) => {
				heldReads.push(path);
				return readWindowsDirectorySecurity(path);
			});
			setWindowsDirectorySecurityAsyncReaderForTesting(async (path) => {
				asyncReads.push(path);
				const security = await readWindowsDirectorySecurityAsync(path);
				return security && path === foreignCache ? { ...security, ownerSid: "S-1-5-21-4-5-6-1002" } : security;
			});

			const dir = await ensurePrivateTempDirAsync("extensions");

			assert.ok(isPathInside(getTempRootDir(), dir), `${dir} is inside the per-user temp root`);
			assert.deepEqual(asyncReads, [foreignCache, getTempRootDir()]);
			assert.deepEqual(heldReads, [], "no descriptor was read on the main thread");
		},
	);

	it.skipIf(!isPosix)("a directory already in use is checked again on every call", () => {
		const dir = ensurePrivateTempDir("extensions");
		chmodSync(dir, 0o770);
		const reopened = ensurePrivateTempDir("extensions");
		assert.notEqual(reopened, dir, "a directory opened up after first use is not returned again");
		assertPrivateChain(reopened, sandbox);

		const swapped = ensurePrivateTempDir("swapped");
		rmSync(swapped, { recursive: true });
		const elsewhere = mkdtempSync(join(sandbox, "swap-target-"));
		symlinkSync(elsewhere, swapped, "dir");
		const again = ensurePrivateTempDir("swapped");
		assert.notEqual(again, swapped, "a directory replaced by a link after first use is not returned again");
		assert.deepEqual(readdirSync(elsewhere), []);
	});
});
