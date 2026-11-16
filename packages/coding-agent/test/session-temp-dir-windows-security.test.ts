/**
 * Windows owner-SID and DACL verification for the session temp tree
 * (bastani-inc/atomic#2245): an existing root is adopted only when its owner
 * is a trusted principal and its DACL grants access to trusted principals
 * only; anything unverifiable is refused rather than trusted.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import { spawnSyncCollect } from "../../../test/helpers/runtime.ts";
import {
	getSessionTempDir,
	getTempRootDir,
	resetSessionTempDirStateForTesting,
	TempDirRefusedError,
} from "../src/core/tools/session-temp-dir.ts";
import {
	evaluateWindowsDirectorySecurity,
	getLastWindowsSecurityReadFailureForTesting,
	readWindowsDirectorySecurity,
	resetWindowsDirectorySecurityStateForTesting,
	setWindowsDirectorySecurityReaderForTesting,
	verifyWindowsDirectorySecurity,
	type WindowsDirectorySecurity,
} from "../src/core/tools/windows-directory-security.ts";

const isWindows = process.platform === "win32";
/** New session temp directories created one after another, as a busy process's sessions and subagents create them. */
const SESSION_BURST = 20;

const CURRENT_SID = "S-1-5-21-1000000000-2000000000-3000000000-1001";
const FOREIGN_SID = "S-1-5-21-4000000000-5000000000-6000000000-1002";

function security(overrides: Partial<WindowsDirectorySecurity> = {}): WindowsDirectorySecurity {
	return {
		currentSid: CURRENT_SID,
		ownerSid: CURRENT_SID,
		dacl: `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${CURRENT_SID})`,
		accessRules: [
			{ allow: true, sid: "S-1-5-18" },
			{ allow: true, sid: "S-1-5-32-544" },
			{ allow: true, sid: CURRENT_SID },
		],
		...overrides,
	};
}

describe("windows directory security decision", () => {
	it("adopts a restrictive descriptor owned by the caller", () => {
		assert.equal(evaluateWindowsDirectorySecurity(security()), undefined);
	});

	it("adopts a root created by an elevated process", () => {
		// Elevated processes create directories owned by the Administrators
		// group rather than the user; SYSTEM-owned components appear under
		// service-redirected temp directories.
		for (const ownerSid of ["S-1-5-32-544", "S-1-5-18"]) {
			assert.equal(evaluateWindowsDirectorySecurity(security({ ownerSid })), undefined);
		}
	});

	it("adopts an empty DACL and ignores inherit-only CREATOR OWNER plumbing", () => {
		assert.equal(evaluateWindowsDirectorySecurity(security({ dacl: "D:", accessRules: [] })), undefined);
		assert.equal(evaluateWindowsDirectorySecurity(security({ dacl: "D:PAI", accessRules: [] })), undefined);
		assert.equal(
			evaluateWindowsDirectorySecurity(
				security({
					dacl: "D:(A;OICIIO;FA;;;CO)(A;;FA;;;SY)",
					accessRules: [
						{ allow: true, sid: "S-1-3-0" },
						{ allow: true, sid: "S-1-5-18" },
					],
				}),
			),
			undefined,
		);
	});

	it("ignores deny ACEs, which only ever remove access", () => {
		assert.equal(
			evaluateWindowsDirectorySecurity(
				security({
					dacl: `D:(D;;FA;;;WD)(A;;FA;;;${CURRENT_SID})`,
					accessRules: [
						{ allow: false, sid: "S-1-1-0" },
						{ allow: true, sid: CURRENT_SID },
					],
				}),
			),
			undefined,
		);
	});

	it("refuses a foreign-owned descriptor", () => {
		assert.equal(
			evaluateWindowsDirectorySecurity(security({ ownerSid: FOREIGN_SID })),
			"it is owned by another account",
		);
	});

	it("refuses a DACL granting access to another account", () => {
		for (const trustee of ["S-1-1-0", "S-1-5-11", "S-1-5-32-545", FOREIGN_SID]) {
			assert.equal(
				evaluateWindowsDirectorySecurity(
					security({
						dacl: `D:(A;OICI;FA;;;${trustee})(A;;FA;;;${CURRENT_SID})`,
						accessRules: [
							{ allow: true, sid: trustee },
							{ allow: true, sid: CURRENT_SID },
						],
					}),
				),
				"it grants access to another account",
				`a grant to ${trustee} must refuse the directory`,
			);
		}
	});

	it("refuses a null DACL, which grants everyone full control", () => {
		assert.equal(
			evaluateWindowsDirectorySecurity(security({ dacl: "", accessRules: [] })),
			"it has no access control list",
		);
	});

	it("refuses what it cannot verify instead of guessing", () => {
		const unverifiable: Array<[Partial<WindowsDirectorySecurity>, string]> = [
			[{ ownerSid: "Alice" }, "its owner could not be verified"],
			[
				{ dacl: `D:(XA;;FA;;;${CURRENT_SID};(Member_of {SID(BA)}))`, accessRules: [] },
				"its access control list could not be parsed",
			],
			[
				{ dacl: `D:(OA;;FA;guid;;${CURRENT_SID})`, accessRules: [{ allow: true, sid: CURRENT_SID }] },
				"its access control list could not be verified",
			],
			[{ dacl: "D:garbage", accessRules: [] }, "its access control list could not be parsed"],
			// An ACE the resolved rules do not describe: refuse rather than trust
			// the part that resolved.
			[{ dacl: "D:(A;;FA;;;SY)", accessRules: [] }, "its access control list could not be verified"],
			// A rule whose trustee did not resolve to a SID.
			[
				{ dacl: "D:(A;;FA;;;SY)", accessRules: [{ allow: true, sid: "Everyone" }] },
				"its access control list could not be verified",
			],
		];
		for (const [overrides, reason] of unverifiable) {
			assert.equal(evaluateWindowsDirectorySecurity(security(overrides)), reason, JSON.stringify(overrides));
		}
	});
});

describe("windows directory security cache", () => {
	let dir: string;

	beforeEach(() => {
		resetWindowsDirectorySecurityStateForTesting();
		dir = mkdtempSync(join(tmpdir(), "atomic-win-acl-cache-"));
	});

	afterEach(() => {
		resetWindowsDirectorySecurityStateForTesting();
		rmSync(dir, { recursive: true, force: true });
	});

	it("serves an unchanged directory from the cache", () => {
		let reads = 0;
		setWindowsDirectorySecurityReaderForTesting(() => {
			reads += 1;
			return security();
		});
		assert.equal(verifyWindowsDirectorySecurity(dir), undefined);
		assert.equal(verifyWindowsDirectorySecurity(dir), undefined);
		assert.equal(reads, 1, "an unchanged directory is not re-read");
	});

	it("keeps a verified directory verified when entries are created inside it", () => {
		let reads = 0;
		setWindowsDirectorySecurityReaderForTesting(() => {
			reads += 1;
			return security();
		});
		assert.equal(verifyWindowsDirectorySecurity(dir), undefined);
		writeFileSync(join(dir, "spill.log"), "content");
		utimesSync(dir, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
		assert.equal(verifyWindowsDirectorySecurity(dir), undefined);
		assert.equal(reads, 1, "a verified directory is read once per process");
	});

	it("trusts a directory inside a verified one without reading it", () => {
		const reads: string[] = [];
		setWindowsDirectorySecurityReaderForTesting((path) => {
			reads.push(path);
			return security();
		});
		assert.equal(verifyWindowsDirectorySecurity(dir), undefined);
		const child = join(dir, "session");
		mkdirSync(child);
		assert.equal(verifyWindowsDirectorySecurity(child), undefined);
		const grandchild = join(child, "tool-results");
		mkdirSync(grandchild);
		assert.equal(verifyWindowsDirectorySecurity(grandchild), undefined);
		assert.deepEqual(reads, [dir], "only the verified root was read");
	});

	it("reads, and refuses, a foreign directory whose parent was never verified", () => {
		const reads: string[] = [];
		setWindowsDirectorySecurityReaderForTesting((path) => {
			reads.push(path);
			return security({ ownerSid: FOREIGN_SID });
		});
		const child = join(dir, "planted");
		mkdirSync(child);
		assert.equal(verifyWindowsDirectorySecurity(child), "it is owned by another account");
		// Failures are never cached: the next call reads again.
		assert.equal(verifyWindowsDirectorySecurity(child), "it is owned by another account");
		assert.deepEqual(reads, [child, child]);
	});

	it.skipIf(!isWindows)(
		"reads a verified directory again once it is recreated, and refuses it when it grants another account",
		() => {
			let descriptor = security();
			let reads = 0;
			setWindowsDirectorySecurityReaderForTesting(() => {
				reads += 1;
				return descriptor;
			});
			assert.equal(verifyWindowsDirectorySecurity(dir), undefined);

			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir);
			descriptor = security({
				dacl: `D:(A;OICI;FA;;;${FOREIGN_SID})(A;;FA;;;${CURRENT_SID})`,
				accessRules: [
					{ allow: true, sid: FOREIGN_SID },
					{ allow: true, sid: CURRENT_SID },
				],
			});
			assert.equal(verifyWindowsDirectorySecurity(dir), "it grants access to another account");
			assert.equal(reads, 2, "a directory with a new creation time is read again");
		},
	);
});

describe("windows session temp root verification", () => {
	const envKeys = ["TMPDIR", "TEMP", "TMP"] as const;
	const savedEnv = new Map<string, string | undefined>();
	let sandbox: string;

	beforeAll(() => {
		sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-win-acl-")));
		for (const key of envKeys) {
			savedEnv.set(key, process.env[key]);
			process.env[key] = sandbox;
		}
	});

	afterAll(() => {
		for (const key of envKeys) {
			const saved = savedEnv.get(key);
			if (saved === undefined) delete process.env[key];
			else process.env[key] = saved;
		}
		rmSync(sandbox, { recursive: true, force: true });
	});

	beforeEach(() => {
		resetSessionTempDirStateForTesting();
		rmSync(sandbox, { recursive: true, force: true });
		mkdirSync(sandbox, { recursive: true });
	});

	afterEach(() => {
		setWindowsDirectorySecurityReaderForTesting(undefined);
	});

	it.skipIf(!isWindows)("adopts its own restrictive root and spills into it", () => {
		const dir = getSessionTempDir("own-root");
		writeFileSync(join(dir, "spill.log"), "content");
		assert.ok(existsSync(join(dir, "spill.log")));
	});

	it.skipIf(!isWindows)("reads a real descriptor for an owned directory", () => {
		const dir = getSessionTempDir("descriptor-read");
		const descriptor = readWindowsDirectorySecurity(dir);
		assert.ok(
			descriptor,
			`the descriptor of an owned directory must be readable: ${getLastWindowsSecurityReadFailureForTesting()}`,
		);
		assert.match(descriptor.currentSid, /^S-1-/);
		assert.match(descriptor.ownerSid, /^S-1-/);
		assert.equal(evaluateWindowsDirectorySecurity(descriptor), undefined);
	});

	it.skipIf(!isWindows)("refuses a pre-created root whose DACL grants Everyone access", () => {
		const root = getTempRootDir();
		mkdirSync(root, { recursive: true });
		const granted = spawnSyncCollect(["icacls", root, "/grant", "*S-1-1-0:(OI)(CI)F"]);
		assert.equal(granted.exitCode, 0, granted.stderr.toString());

		assert.throws(() => getSessionTempDir("through-shared-root"), TempDirRefusedError);
		assert.equal(existsSync(join(root, "through-shared-root")), false, "nothing is written below a shared root");
	});

	it.skipIf(!isWindows)("refuses a root owned by another account", () => {
		const root = getTempRootDir();
		mkdirSync(root, { recursive: true });
		setWindowsDirectorySecurityReaderForTesting((path) => {
			const real = readWindowsDirectorySecurity(path);
			assert.ok(real);
			return { ...real, ownerSid: FOREIGN_SID };
		});

		assert.throws(
			() => getSessionTempDir("through-foreign-root"),
			(error: unknown) =>
				error instanceof TempDirRefusedError && error.message.includes("it is owned by another account"),
		);
		assert.equal(existsSync(join(root, "through-foreign-root")), false);
	});

	it.skipIf(!isWindows)("refuses a root whose descriptor cannot be read", () => {
		mkdirSync(getTempRootDir(), { recursive: true });
		setWindowsDirectorySecurityReaderForTesting(() => undefined);

		assert.throws(
			() => getSessionTempDir("unverifiable-root"),
			(error: unknown) =>
				error instanceof TempDirRefusedError && error.message.includes("its ownership could not be verified"),
		);
	});

	it.skipIf(!isWindows)("verifies unchanged components once, keeping the subprocess off the spill path", () => {
		const reads: string[] = [];
		setWindowsDirectorySecurityReaderForTesting((path) => {
			reads.push(path);
			return readWindowsDirectorySecurity(path);
		});

		const dir = getSessionTempDir("hot-path");
		assert.ok(reads.length >= 1, "the first creation verifies through the reader");
		// Creating the session leaf changed the owner root's metadata once, so
		// the next call re-verifies the root; after that, nothing changes.
		assert.equal(getSessionTempDir("hot-path"), dir);
		const settledReads = reads.length;
		for (let spill = 0; spill < 25; spill++) {
			assert.equal(getSessionTempDir("hot-path"), dir);
		}
		assert.equal(
			reads.length,
			settledReads,
			"repeat creations of unchanged directories must not re-run the subprocess",
		);
	});

	it.skipIf(!isWindows)(
		"a burst of new session temp directories reads the private root's descriptor once, not once per directory (#4640)",
		() => {
			const reads: string[] = [];
			setWindowsDirectorySecurityReaderForTesting((path) => {
				reads.push(path);
				return readWindowsDirectorySecurity(path);
			});

			for (let session = 0; session < SESSION_BURST; session++) getSessionTempDir(`burst-${session}`);

			// Each read is a PowerShell subprocess that holds the main thread; on a loaded host each took seconds.
			assert.deepEqual(reads, [getTempRootDir()], "only the private root is read, once");
		},
	);

	it.skipIf(!isWindows)("re-verifies a private root swapped underneath a verified path", () => {
		const dir = getSessionTempDir("swap-detect");
		const root = getTempRootDir();
		const reads: string[] = [];
		setWindowsDirectorySecurityReaderForTesting((path) => {
			reads.push(path);
			return readWindowsDirectorySecurity(path);
		});
		assert.equal(getSessionTempDir("swap-detect"), dir);
		assert.equal(reads.length, 0, "the unchanged root is served from the cache");

		rmSync(root, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		assert.equal(getSessionTempDir("swap-detect"), dir);
		assert.deepEqual(reads, [root], "a recreated root must be re-verified");
	});

	it.skipIf(!isWindows)("refuses a verified root swapped for one whose DACL grants Everyone access", () => {
		getSessionTempDir("acl-swap");
		const root = getTempRootDir();
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root);
		const granted = spawnSyncCollect(["icacls", root, "/grant", "*S-1-1-0:(OI)(CI)F"]);
		assert.equal(granted.exitCode, 0, granted.stderr.toString());

		assert.throws(
			() => getSessionTempDir("acl-swap"),
			(error: unknown) =>
				error instanceof TempDirRefusedError && error.message.includes("it grants access to another account"),
			"a root recreated with a shared DACL must be re-verified and refused",
		);
		assert.equal(existsSync(join(root, "acl-swap")), false, "nothing is written below a shared root");
	});

	it.skipIf(isWindows)("never consults the Windows reader on POSIX", () => {
		let reads = 0;
		setWindowsDirectorySecurityReaderForTesting(() => {
			reads += 1;
			return undefined;
		});
		getSessionTempDir("posix-untouched");
		assert.equal(reads, 0, "POSIX verification is unchanged and never reads a Windows descriptor");
	});
});
