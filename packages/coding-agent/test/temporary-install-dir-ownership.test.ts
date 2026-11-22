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
import { renameWithRetry } from "../../../test/helpers/rename-retry.js";
import { spawnSyncCollect } from "../../../test/helpers/runtime.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getGitInstallPath, getNpmInstallRoot } from "../src/core/package-manager-paths.ts";
import type { PackageLocationContext } from "../src/core/package-manager-types.ts";
import {
	assertPrivateDirectory,
	assertPrivateDirectoryAsync,
	ensurePrivateTempDir,
	ensurePrivateTempDirAsync,
	getTempRootDir,
	resetSessionTempDirStateForTesting,
} from "../src/core/tools/session-temp-dir.ts";
import {
	powershellCandidates,
	readWindowsDirectorySecurityAsync,
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
	it.skipIf(!isPosix)("temporary extension installs prefer the per-user runtime directory", async () => {
		const runtime = mkdtempSync(join(sandbox, "run-"));
		process.env.XDG_RUNTIME_DIR = runtime;

		const root = await getNpmInstallRoot(context, "temporary", true);

		assert.ok(isPathInside(runtime, root), `${root} is inside the runtime directory`);
		assertPrivateChain(root, runtime);
	});

	it.skipIf(!isPosix)("a runtime directory link with trailing separators is refused (#5285)", async () => {
		const parent = mkdtempSync(join(sandbox, "run-parent-"));
		const target = mkdtempSync(join(sandbox, "run-target-"));
		const link = join(parent, "link");
		symlinkSync(target, link, "dir");
		process.env.XDG_RUNTIME_DIR = `${link}//`;

		const root = await ensurePrivateTempDirAsync("extensions");

		assert.ok(isPathInside(join(agentDir, "cache", "tmp"), root), "the agent cache is used instead");
		assert.deepEqual(readdirSync(target), [], "nothing is created through the linked runtime directory");
	});

	it.skipIf(!isPosix)("runtime inspection checks the same normalized root used for creation (#5285)", async () => {
		const lexicalRoot = mkdtempSync(join(sandbox, "run-lexical-"));
		chmodSync(lexicalRoot, 0o755);
		const privateTarget = mkdtempSync(join(sandbox, "run-private-"));
		const inner = join(privateTarget, "inner");
		mkdirSync(inner, { mode: 0o700 });
		const link = join(lexicalRoot, "link");
		symlinkSync(inner, link, "dir");
		process.env.XDG_RUNTIME_DIR = `${link}/..`;
		assert.equal(lstatSync(process.env.XDG_RUNTIME_DIR).mode & 0o777, 0o700);

		const root = await ensurePrivateTempDirAsync("extensions");

		assert.ok(isPathInside(join(agentDir, "cache", "tmp"), root), "the agent cache is used instead");
		assert.deepEqual(readdirSync(lexicalRoot), ["link"], "nothing is created in the shared lexical root");
		assert.equal(statSync(lexicalRoot).mode & 0o777, 0o755, "the runtime directory is not repaired");
	});

	it("without a runtime directory, temporary extension installs use the agent cache", async () => {
		const root = await getNpmInstallRoot(context, "temporary", true);

		assert.ok(isPathInside(join(agentDir, "cache", "tmp"), root), `${root} is inside the agent cache`);
		assertPrivateChain(root, agentDir);
	});

	it("temporary git checkouts share the same per-user directory", async () => {
		const npm = await getNpmInstallRoot(context, "temporary", true);
		const checkout = await getGitInstallPath(context, { host: "github.com", path: "owner/repo" }, "temporary");
		assert.equal(dirname(dirname(dirname(dirname(checkout)))), dirname(dirname(npm)));
	});

	it.skipIf(!isPosix)("a shared runtime directory is not used", async () => {
		const runtime = mkdtempSync(join(sandbox, "run-"));
		chmodSync(runtime, 0o777);
		process.env.XDG_RUNTIME_DIR = runtime;

		const root = await getNpmInstallRoot(context, "temporary", true);

		assert.ok(!isPathInside(runtime, root));
		assert.deepEqual(readdirSync(runtime), [], "nothing is created in it");
	});

	it.skipIf(!isPosix)("the shared temp directory is used when the agent cache is unusable", async () => {
		const elsewhere = plantAgentCacheLink();

		const root = await getNpmInstallRoot(context, "temporary", true);

		assert.ok(isPathInside(getTempRootDir(), root), `${root} is inside the per-user temp root`);
		assertPrivateChain(root, shared);
		assert.deepEqual(readdirSync(elsewhere), [], "nothing is created through the planted link");
	});

	it.skipIf(!isPosix)("a pre-existing directory owned by another account is neither used nor blocking", async () => {
		plantAgentCacheLink();
		const realUid = process.getuid!();
		vi.spyOn(process, "getuid").mockReturnValue(realUid + 1);
		resetSessionTempDirStateForTesting();
		// The directory exists under the name the (other) account expects but is not owned by it.
		const planted = getTempRootDir();
		mkdirSync(planted, { mode: 0o700 });

		const root = await getNpmInstallRoot(context, "temporary", true);

		assert.ok(!isPathInside(planted, root), `${root} is not inside the planted directory`);
		assert.ok(isPathInside(shared, root));
		assert.ok(statSync(dirname(dirname(root))).isDirectory());
		assert.deepEqual(readdirSync(planted), [], "nothing is created in it");
		const nested = ensurePrivateTempDir("nested", "deeper");
		assert.ok(statSync(nested).isDirectory(), "nested names work in the fallback directory too");
		assert.ok(!isPathInside(planted, nested));
	});

	it.skipIf(!isPosix)(
		"a symbolic link in place of the per-user directory is neither followed nor blocking",
		async () => {
			plantAgentCacheLink();
			const elsewhere = mkdtempSync(join(sandbox, "planted-"));
			symlinkSync(elsewhere, getTempRootDir(), "dir");

			const root = await getNpmInstallRoot(context, "temporary", true);

			assert.ok(!isPathInside(getTempRootDir(), root));
			assertPrivateChain(root, shared);
			assert.deepEqual(readdirSync(elsewhere), [], "nothing is created through the planted link");
		},
	);

	it.skipIf(!isPosix)("a group-writable directory is neither repaired nor blocking", async () => {
		plantAgentCacheLink();
		mkdirSync(getTempRootDir(), { mode: 0o700 });
		chmodSync(getTempRootDir(), 0o770);

		const root = await getNpmInstallRoot(context, "temporary", true);

		assert.ok(!isPathInside(getTempRootDir(), root));
		assertPrivateChain(root, shared);
		assert.equal(statSync(getTempRootDir()).mode & 0o777, 0o770, "the refused directory is left as found");
		assert.deepEqual(readdirSync(getTempRootDir()), []);
	});

	it.runIf(process.platform === "win32")("uses a directory inside the account's own profile on Windows", async () => {
		const root = await getNpmInstallRoot(context, "temporary", true);
		assert.ok(isPathInside(agentDir, root) || isPathInside(tmpdir(), root), root);
		assert.ok(statSync(dirname(dirname(root))).isDirectory());
	});

	it.skipIf(!isPosix)("a runtime directory that is a link, a file or another account's is not used", async () => {
		const real = mkdtempSync(join(sandbox, "run-real-"));
		const link = join(sandbox, `run-link-${Date.now()}`);
		symlinkSync(real, link, "dir");
		const file = join(sandbox, `run-file-${Date.now()}`);
		writeFileSync(file, "");
		for (const runtime of [link, file]) {
			process.env.XDG_RUNTIME_DIR = runtime;
			const root = await getNpmInstallRoot(context, "temporary", true);
			assert.ok(isPathInside(agentDir, root), `${runtime}: ${root} falls back to the agent cache`);
		}
		assert.deepEqual(readdirSync(real), [], "nothing is created through the linked runtime directory");

		process.env.XDG_RUNTIME_DIR = real;
		vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
		resetSessionTempDirStateForTesting();
		const root = await getNpmInstallRoot(context, "temporary", true);
		assert.ok(!isPathInside(real, root), `${root} avoids a runtime directory owned by another account`);
		assert.deepEqual(readdirSync(real), []);
	});

	it("only plain relative names are accepted below the private directory", async () => {
		for (const segment of ["..", ".", "", "a//b", "a/../b"]) {
			assert.throws(() => ensurePrivateTempDir(segment), /not a plain relative path/, JSON.stringify(segment));
			await assert.rejects(ensurePrivateTempDirAsync(segment), /not a plain relative path/, JSON.stringify(segment));
		}
		assert.ok((await ensurePrivateTempDirAsync("a/b")).endsWith(join("a", "b")));
		assert.ok(ensurePrivateTempDir("a/b").endsWith(join("a", "b")));
	});

	it("reports clearly when no private directory can be created", async () => {
		const file = join(sandbox, `not-a-dir-${Date.now()}`);
		writeFileSync(file, "");
		for (const key of ["TMPDIR", "TEMP", "TMP"]) process.env[key] = join(file, "tmp");
		process.env[ENV_AGENT_DIR] = join(file, "agent");
		resetSessionTempDirStateForTesting();

		assert.throws(() => ensurePrivateTempDir("extensions"), /no directory private to this account could be created/);
		await assert.rejects(
			ensurePrivateTempDirAsync("extensions"),
			/no directory private to this account could be created/,
		);
	});

	it.skipIf(!isPosix)("a directory is private only when it is this account's own real directory", async () => {
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
		await assert.rejects(assertPrivateDirectoryAsync(own), /owned by another account/);
	});

	it.runIf(process.platform === "win32")(
		"a directory already in use is not re-read from its security descriptor on every call",
		async () => {
			let reads = 0;
			setWindowsDirectorySecurityReaderForTesting((path) => {
				reads++;
				return readWindowsDirectorySecurityAsync(path);
			});
			const dir = await ensurePrivateTempDirAsync("extensions");
			writeFileSync(join(dir, "in-use.txt"), "");
			const firstReads = reads;
			assert.ok(firstReads > 0);

			for (let call = 0; call < 5; call++) assert.equal(await ensurePrivateTempDirAsync("extensions"), dir);
			assert.equal(ensurePrivateTempDir("extensions"), dir, "a synchronous caller finds it verified");
			assert.equal(reads, firstReads, "repeat calls cost no PowerShell security reads");
		},
	);

	it.each(["synchronous", "asynchronous"] as const)(
		"%s callers refuse a remembered private directory below a replaced ancestor (#5285)",
		async (caller) => {
			const dir = await ensurePrivateTempDirAsync("nested", "extensions");
			const root = dirname(dirname(dir));
			const movedRoot = `${root}-original`;
			await renameWithRetry(root, movedRoot);
			symlinkSync(movedRoot, root, isPosix ? "dir" : "junction");

			const reopened =
				caller === "synchronous"
					? ensurePrivateTempDir("nested", "extensions")
					: await ensurePrivateTempDirAsync("nested", "extensions");

			assert.notEqual(reopened, dir, "the cached leaf does not make a linked ancestor trustworthy");
			assert.ok(!isPathInside(root, reopened), "the replacement link is not followed");
			assertPrivateChain(reopened, sandbox);
		},
	);

	it.skipIf(!isPosix).each(["synchronous", "asynchronous"] as const)(
		"%s callers recheck a runtime directory configured with trailing separators (#5285)",
		async (caller) => {
			const runtime = mkdtempSync(join(sandbox, "run-"));
			process.env.XDG_RUNTIME_DIR = `${runtime}//`;
			const dir = await ensurePrivateTempDirAsync("nested", "extensions");
			assert.ok(isPathInside(runtime, dir), "the private runtime directory is preferred initially");
			assert.equal(await ensurePrivateTempDirAsync("nested", "extensions"), dir);
			chmodSync(runtime, 0o755);

			const reopened =
				caller === "synchronous"
					? ensurePrivateTempDir("nested", "extensions")
					: await ensurePrivateTempDirAsync("nested", "extensions");

			assert.ok(!isPathInside(runtime, reopened), "the opened runtime directory is not reused");
			assert.ok(isPathInside(join(agentDir, "cache", "tmp"), reopened), "the agent cache is used instead");
			assertPrivateChain(reopened, agentDir);
			assert.equal(statSync(runtime).mode & 0o777, 0o755, "the runtime directory is not repaired");
		},
	);

	it.skipIf(!isPosix)(
		"refuses a remembered path whose ancestor becomes accessible to other accounts (#5285)",
		async () => {
			const dir = await ensurePrivateTempDirAsync("nested", "extensions");
			const ancestor = dirname(dir);
			chmodSync(ancestor, 0o770);

			const reopened = await ensurePrivateTempDirAsync("nested", "extensions");
			assert.notEqual(reopened, dir);
			assert.ok(!isPathInside(ancestor, reopened));
			assert.equal(statSync(ancestor).mode & 0o777, 0o770, "the refused ancestor is not repaired");
		},
	);

	it.skipIf(isPosix)("refuses a replaced cached private root with the same creation time (#5285)", async () => {
		const sid = "S-1-5-21-1001";
		const root = await ensurePrivateTempDirAsync();
		const original = lstatSync(root, { bigint: true });
		await renameWithRetry(root, `${root}-original`);
		mkdirSync(root);
		const ticks = original.birthtimeNs / 100n + 621355968000000000n;
		const restored = spawnSyncCollect(
			[
				powershellCandidates()[0]!,
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`[IO.Directory]::SetCreationTimeUtc($env:ATOMIC_SECURITY_QUERY_PATH, [datetime]::new(${ticks}L, [DateTimeKind]::Utc))`,
			],
			{ env: { ...process.env, ATOMIC_SECURITY_QUERY_PATH: root } },
		);
		assert.equal(restored.exitCode, 0, restored.stderr.toString());
		const replacement = lstatSync(root, { bigint: true });
		assert.equal(replacement.birthtimeNs, original.birthtimeNs, "the fixture reproduces creation-time tunneling");
		assert.notEqual(replacement.ino, original.ino, "the replacement has a new file ID");
		setWindowsDirectorySecurityReaderForTesting((path) => ({
			currentSid: sid,
			ownerSid: path === root ? "S-1-5-21-1002" : sid,
			dacl: "D:",
			accessRules: [],
		}));

		assert.notEqual(ensurePrivateTempDir(), root);
		assert.notEqual(await ensurePrivateTempDirAsync(), root);
	});

	it.each(["synchronous", "asynchronous"] as const)(
		"%s callers retire a fallback root replaced by a link (#5285)",
		async (caller) => {
			mkdirSync(join(agentDir, "cache"), { recursive: true });
			writeFileSync(join(agentDir, "cache", "tmp"), "not a directory");
			writeFileSync(getTempRootDir(), "not a directory");
			const dir = await ensurePrivateTempDirAsync("nested", "extensions");
			const root = dirname(dirname(dir));
			const movedRoot = `${root}-original`;
			await renameWithRetry(root, movedRoot);
			symlinkSync(movedRoot, root, isPosix ? "dir" : "junction");

			for (const name of ["fresh", "extensions"]) {
				const reopened =
					caller === "synchronous"
						? ensurePrivateTempDir("nested", name)
						: await ensurePrivateTempDirAsync("nested", name);
				assert.ok(!isPathInside(root, reopened), "neither a new name nor a cached one follows the fallback link");
				assertPrivateChain(reopened, sandbox);
			}
			assert.equal(existsSync(join(movedRoot, "nested", "fresh")), false, "nothing was created through the link");
		},
	);

	it.skipIf(!isPosix)("a directory already in use is checked again on every call", async () => {
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
