/**
 * Windows owner-SID and DACL verification for the session temp tree
 * (bastani-inc/atomic#2245): an existing root is adopted only when its owner
 * is a trusted principal and its DACL grants access to trusted principals
 * only; anything unverifiable is refused rather than trusted.
 */
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import { longestMainThreadBlockMs } from "../../../test/helpers/main-thread-work.ts";
import { type RecordedProcess, recordProcess, signalRecordedProcess } from "../../../test/helpers/recorded-process.js";
import {
	bunExecutable,
	moduleDir,
	readStreamText,
	sleep,
	spawnProcess,
	spawnSyncCollect,
} from "../../../test/helpers/runtime.ts";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import {
	assertPrivateDirectoryAsync,
	ensurePrivateTempDir,
	ensurePrivateTempDirAsync,
	ensureSessionTempDirAsync,
	getSessionTempDir,
	getSessionTempDirAsync,
	getTempRootDir,
	resetSessionTempDirStateForTesting,
	resolveSessionTempDirPath,
	setActiveSessionTempId,
	TempDirRefusedError,
} from "../src/core/tools/session-temp-dir.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";
import {
	evaluateWindowsDirectorySecurity,
	getLastWindowsSecurityReadFailureForTesting,
	readWindowsDirectorySecurityAsync,
	resetWindowsDirectorySecurityStateForTesting,
	setWindowsDirectorySecurityReaderForTesting,
	verifyWindowsDirectorySecurity,
	verifyWindowsDirectorySecurityAsync,
	type WindowsDirectorySecurity,
	waitForWindowsDirectorySecurityReadsForTesting,
} from "../src/core/tools/windows-directory-security.ts";

const isWindows = process.platform === "win32";
const RESOLVE_TS_SOURCES = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`;
const NODE_SOURCE_RUNTIME = [
	process.execPath,
	"--experimental-strip-types",
	"--import",
	`data:text/javascript,${encodeURIComponent(RESOLVE_TS_SOURCES)}`,
	"--no-warnings",
];
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

	it("serves an unchanged directory from the cache", async () => {
		let reads = 0;
		setWindowsDirectorySecurityReaderForTesting(() => {
			reads += 1;
			return security();
		});
		assert.equal(await verifyWindowsDirectorySecurityAsync(dir), undefined);
		assert.equal(await verifyWindowsDirectorySecurityAsync(dir), undefined);
		assert.equal(reads, 1, "an unchanged directory is not re-read");
	});

	it("keeps a verified directory verified when entries are created inside it", async () => {
		let reads = 0;
		setWindowsDirectorySecurityReaderForTesting(() => {
			reads += 1;
			return security();
		});
		assert.equal(await verifyWindowsDirectorySecurityAsync(dir), undefined);
		writeFileSync(join(dir, "spill.log"), "content");
		utimesSync(dir, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
		assert.equal(await verifyWindowsDirectorySecurityAsync(dir), undefined);
		assert.equal(reads, 1, "a verified directory is read once per process");
	});

	it("trusts a directory inside a verified one without reading it", async () => {
		const reads: string[] = [];
		setWindowsDirectorySecurityReaderForTesting((path) => {
			reads.push(path);
			return security();
		});
		assert.equal(await verifyWindowsDirectorySecurityAsync(dir), undefined);
		const child = join(dir, "session");
		mkdirSync(child);
		assert.equal(await verifyWindowsDirectorySecurityAsync(child), undefined);
		const grandchild = join(child, "tool-results");
		mkdirSync(grandchild);
		assert.equal(await verifyWindowsDirectorySecurityAsync(grandchild), undefined);
		assert.deepEqual(reads, [dir], "only the verified root was read");
	});

	it("reads, and refuses, a foreign directory whose parent was never verified", async () => {
		const reads: string[] = [];
		setWindowsDirectorySecurityReaderForTesting((path) => {
			reads.push(path);
			return security({ ownerSid: FOREIGN_SID });
		});
		const child = join(dir, "planted");
		mkdirSync(child);
		assert.equal(await verifyWindowsDirectorySecurityAsync(child), "it is owned by another account");
		// Failures are never cached: the next call reads again.
		assert.equal(await verifyWindowsDirectorySecurityAsync(child), "it is owned by another account");
		assert.deepEqual(reads, [child, child]);
	});

	// Windows only: a POSIX file system may give a recreated directory its old inode and report no creation time.
	it.skipIf(!isWindows)(
		"reads a verified directory again once it is recreated, and refuses it when it grants another account",
		async () => {
			let descriptor = security();
			let reads = 0;
			setWindowsDirectorySecurityReaderForTesting(() => {
				reads += 1;
				return descriptor;
			});
			assert.equal(await verifyWindowsDirectorySecurityAsync(dir), undefined);

			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir);
			descriptor = security({
				dacl: `D:(A;OICI;FA;;;${FOREIGN_SID})(A;;FA;;;${CURRENT_SID})`,
				accessRules: [
					{ allow: true, sid: FOREIGN_SID },
					{ allow: true, sid: CURRENT_SID },
				],
			});
			assert.equal(await verifyWindowsDirectorySecurityAsync(dir), "it grants access to another account");
			assert.equal(reads, 2, "a directory with a new creation time is read again");
		},
	);
});

describe("windows session temp root verification", () => {
	const envKeys = ["TMPDIR", "TEMP", "TMP"] as const;
	const savedEnv = new Map<string, string | undefined>();
	let sandbox: string;

	function readSecurityWithPowerShell(path: string): WindowsDirectorySecurity {
		const result = spawnSyncCollect(
			[
				"powershell.exe",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				[
					"$ErrorActionPreference = 'Stop'",
					"$acl = Get-Acl -LiteralPath $env:ATOMIC_TEST_SECURITY_PATH",
					"$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ allow = ($_.AccessControlType -eq 'Allow'); sid = $_.IdentityReference.Value } })",
					"@{ currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; dacl = $acl.GetSecurityDescriptorSddlForm('Access'); accessRules = $rules } | ConvertTo-Json -Depth 4 -Compress",
				].join("; "),
			],
			{
				// A PowerShell 7 parent's module path keeps Windows PowerShell from loading Get-Acl's module.
				env: {
					...Object.fromEntries(
						Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"),
					),
					ATOMIC_TEST_SECURITY_PATH: path,
				},
				timeout: 30_000,
			},
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		return JSON.parse(result.stdout.toString()) as WindowsDirectorySecurity;
	}

	function withNativeDacl(sddl: string | null, inspect: (descriptor: WindowsDirectorySecurity) => void): void {
		const dir = mkdtempSync(join(sandbox, "native-dacl-"));
		const backup = `${dir}.acl`;
		const saved = spawnSyncCollect(["icacls", dir, "/save", backup]);
		assert.equal(saved.exitCode, 0, saved.stderr.toString());
		try {
			const applied = spawnSyncCollect(
				[
					"powershell.exe",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AtomicDaclFixture {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint SetNamedSecurityInfoW(string path, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    public static uint SetDacl(string path, IntPtr dacl) {
        return SetNamedSecurityInfoW(path, 1, 0x80000004, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
    }
}
'@
$pointer = [IntPtr]::Zero
try {
    if ($env:ATOMIC_TEST_DACL_SDDL) {
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $sddl = $env:ATOMIC_TEST_DACL_SDDL.Replace('{currentSid}', $sid)
        $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($sddl)
        $acl = $descriptor.DiscretionaryAcl
        $bytes = [byte[]]::new($acl.BinaryLength)
        $acl.GetBinaryForm($bytes, 0)
        $pointer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
        [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
    }
    $status = [AtomicDaclFixture]::SetDacl($env:ATOMIC_TEST_DACL_PATH, $pointer)
    if ($status -ne 0) { throw "SetNamedSecurityInfoW failed: $status" }
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pointer) }
}
`,
				],
				{ env: { ...process.env, ATOMIC_TEST_DACL_PATH: dir, ATOMIC_TEST_DACL_SDDL: sddl ?? "" } },
			);
			assert.equal(applied.exitCode, 0, applied.stderr.toString());
			const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
				windowsDirectorySecurity: (path: string) => WindowsDirectorySecurity | null;
			};
			const descriptor = binding.windowsDirectorySecurity(dir);
			assert.ok(descriptor, "the native module reads the fixture's descriptor");
			inspect(descriptor);
		} finally {
			const restored = spawnSyncCollect(["icacls", sandbox, "/restore", backup]);
			assert.equal(restored.exitCode, 0, restored.stderr.toString());
		}
	}

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

	it.skipIf(!isWindows)("adopts its own restrictive root and spills into it", async () => {
		const dir = await getSessionTempDirAsync("own-root");
		writeFileSync(join(dir, "spill.log"), "content");
		assert.ok(existsSync(join(dir, "spill.log")));
	});

	it.skipIf(!isWindows)("reads a real descriptor for an owned directory", async () => {
		const dir = await getSessionTempDirAsync("descriptor-read");
		const descriptor = await readWindowsDirectorySecurityAsync(dir);
		assert.ok(
			descriptor,
			`the descriptor of an owned directory must be readable: ${getLastWindowsSecurityReadFailureForTesting()}`,
		);
		assert.match(descriptor.currentSid, /^S-1-/);
		assert.match(descriptor.ownerSid, /^S-1-/);
		assert.equal(evaluateWindowsDirectorySecurity(descriptor), undefined);
	});

	it.skipIf(!isWindows)(
		"the native module reads the owner, user, rules and verdict PowerShell's Get-Acl reads (#5324)",
		async () => {
			const binding = createRequire(import.meta.url)("@bastani/atomic-natives") as {
				windowsDirectorySecurity: (path: string) => WindowsDirectorySecurity | null;
			};
			const own = await getSessionTempDirAsync("native-parity");
			const shared = join(sandbox, "shared-parity");
			mkdirSync(shared);
			const granted = spawnSyncCollect(["icacls", shared, "/grant", "*S-1-1-0:(OI)(CI)F"]);
			assert.equal(granted.exitCode, 0, granted.stderr.toString());
			const rules = (security: WindowsDirectorySecurity) =>
				new Set(security.accessRules.map((rule) => `${rule.allow ? "allow" : "deny"} ${rule.sid}`));

			for (const [path, verdict] of [
				[own, undefined],
				[shared, "it grants access to another account"],
			] as const) {
				const native = binding.windowsDirectorySecurity(path);
				const powershell = readSecurityWithPowerShell(path);
				assert.ok(native, `the native module reads ${path}`);
				assert.ok(powershell, `PowerShell reads ${path}: ${getLastWindowsSecurityReadFailureForTesting()}`);
				assert.equal(native.currentSid, powershell.currentSid);
				assert.equal(native.ownerSid, powershell.ownerSid);
				assert.deepEqual(rules(native), rules(powershell));
				assert.equal(evaluateWindowsDirectorySecurity(native), verdict);
				assert.equal(evaluateWindowsDirectorySecurity(powershell), verdict);
			}
			assert.equal(binding.windowsDirectorySecurity(join(sandbox, "missing")), null);
		},
	);

	it.skipIf(!isWindows)("the native module distinguishes a null DACL from an empty DACL (#5324)", () => {
		withNativeDacl(null, (descriptor) => {
			assert.equal(descriptor.dacl, "");
			assert.deepEqual(descriptor.accessRules, []);
			assert.equal(evaluateWindowsDirectorySecurity(descriptor), "it has no access control list");
		});
		withNativeDacl("D:P", (descriptor) => {
			assert.match(descriptor.dacl, /^D:[A-Z]*$/);
			assert.deepEqual(descriptor.accessRules, []);
			assert.equal(evaluateWindowsDirectorySecurity(descriptor), undefined);
		});
	});

	it.skipIf(!isWindows)("the native module preserves deny ACEs and their SIDs (#5324)", () => {
		withNativeDacl("D:P(D;;0x2;;;WD)(A;;FA;;;{currentSid})", (descriptor) => {
			assert.deepEqual(descriptor.accessRules, [
				{ allow: false, sid: "S-1-1-0" },
				{ allow: true, sid: descriptor.currentSid },
			]);
			assert.equal(evaluateWindowsDirectorySecurity(descriptor), undefined);
		});
	});

	it.skipIf(!isWindows)("refuses a pre-created root whose DACL grants Everyone access", async () => {
		const root = getTempRootDir();
		mkdirSync(root, { recursive: true });
		const granted = spawnSyncCollect(["icacls", root, "/grant", "*S-1-1-0:(OI)(CI)F"]);
		assert.equal(granted.exitCode, 0, granted.stderr.toString());

		await assert.rejects(getSessionTempDirAsync("through-shared-root"), TempDirRefusedError);
		assert.equal(existsSync(join(root, "through-shared-root")), false, "nothing is written below a shared root");
	});

	it.skipIf(!isWindows)("refuses a root owned by another account", async () => {
		const root = getTempRootDir();
		mkdirSync(root, { recursive: true });
		setWindowsDirectorySecurityReaderForTesting(async (path) => {
			const real = await readWindowsDirectorySecurityAsync(path);
			assert.ok(real);
			return { ...real, ownerSid: FOREIGN_SID };
		});

		await assert.rejects(
			getSessionTempDirAsync("through-foreign-root"),
			(error: unknown) =>
				error instanceof TempDirRefusedError && error.message.includes("it is owned by another account"),
		);
		assert.equal(existsSync(join(root, "through-foreign-root")), false);
	});

	it.skipIf(!isWindows)("refuses a root whose descriptor cannot be read", async () => {
		mkdirSync(getTempRootDir(), { recursive: true });
		setWindowsDirectorySecurityReaderForTesting(() => undefined);

		await assert.rejects(
			getSessionTempDirAsync("unverifiable-root"),
			(error: unknown) =>
				error instanceof TempDirRefusedError && error.message.includes("its ownership could not be verified"),
		);
	});

	it.skipIf(!isWindows)("verifies unchanged components once, keeping the subprocess off the spill path", async () => {
		const reads: string[] = [];
		setWindowsDirectorySecurityReaderForTesting((path) => {
			reads.push(path);
			return readWindowsDirectorySecurityAsync(path);
		});

		const dir = await getSessionTempDirAsync("hot-path");
		assert.ok(reads.length >= 1, "the first creation verifies through the reader");
		// Creating the session leaf changed the owner root's metadata once, so
		// the next call re-verifies the root; after that, nothing changes.
		assert.equal(await getSessionTempDirAsync("hot-path"), dir);
		const settledReads = reads.length;
		for (let spill = 0; spill < 25; spill++) {
			assert.equal(await getSessionTempDirAsync("hot-path"), dir);
		}
		assert.equal(
			reads.length,
			settledReads,
			"repeat creations of unchanged directories must not re-run the subprocess",
		);
	});

	it.skipIf(!isWindows)(
		"a burst of new session temp directories reads the private root's descriptor once, not once per directory (#4640)",
		async () => {
			const reads: string[] = [];
			setWindowsDirectorySecurityReaderForTesting((path) => {
				reads.push(path);
				return readWindowsDirectorySecurityAsync(path);
			});

			for (let session = 0; session < SESSION_BURST; session++) await getSessionTempDirAsync(`burst-${session}`);

			// Each read is a PowerShell subprocess; on a loaded host each took seconds.
			assert.deepEqual(reads, [getTempRootDir()], "only the private root is read, once");
		},
	);

	it.skipIf(!isWindows)("re-verifies a private root swapped underneath a verified path", async () => {
		const dir = await getSessionTempDirAsync("swap-detect");
		const root = getTempRootDir();
		const reads: string[] = [];
		setWindowsDirectorySecurityReaderForTesting((path) => {
			reads.push(path);
			return readWindowsDirectorySecurityAsync(path);
		});
		assert.equal(await getSessionTempDirAsync("swap-detect"), dir);
		assert.equal(reads.length, 0, "the unchanged root is served from the cache");

		rmSync(root, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		assert.equal(await getSessionTempDirAsync("swap-detect"), dir);
		assert.deepEqual(reads, [root], "a recreated root must be re-verified");
	});

	it.skipIf(!isWindows)("refuses a verified root swapped for one whose DACL grants Everyone access", async () => {
		await getSessionTempDirAsync("acl-swap");
		const root = getTempRootDir();
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root);
		const granted = spawnSyncCollect(["icacls", root, "/grant", "*S-1-1-0:(OI)(CI)F"]);
		assert.equal(granted.exitCode, 0, granted.stderr.toString());

		await assert.rejects(
			getSessionTempDirAsync("acl-swap"),
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

const MAIN_THREAD_BLOCK_LIMIT_MS = 50;
const BACKGROUND_EXIT_BOUND_MS = 8_000;
const SECURITY_MODULE = join(moduleDir(import.meta.url), "..", "src", "core", "tools", "windows-directory-security.ts");
const SESSION_TEMP_DIR_MODULE = join(moduleDir(import.meta.url), "..", "src", "core", "tools", "session-temp-dir.ts");
const FAKE_READ_SECONDS = 0.3;

type FakePowerShellMode = "answer" | "hang" | "garbage" | "fail" | "ownerAtStart";

interface FakePowerShell {
	readonly logPath: string;
	launches(): Array<{ pid: number; host: string; path: string }>;
	argumentsOf(host: string): string[];
	modulePathOf(host: string): string;
	restore(): void;
}

function fakeHostScript(host: string, mode: FakePowerShellMode, bin: string): string {
	const descriptor = (owner: string) =>
		`printf '%s\\n%s\\n%s\\n%s' '${CURRENT_SID}' ${owner} 'D:(A;OICI;FA;;;${CURRENT_SID})' 'Allow;${CURRENT_SID}'`;
	const body: Record<FakePowerShellMode, string[]> = {
		answer: [`sleep ${FAKE_READ_SECONDS}`, descriptor(`'${CURRENT_SID}'`)],
		hang: ["exec sleep 60"],
		garbage: ["printf 'not a descriptor'"],
		fail: [descriptor(`'${CURRENT_SID}'`), "exit 1"],
		ownerAtStart: [`sleep ${FAKE_READ_SECONDS}`, descriptor('"$owner"')],
	};
	return [
		"#!/bin/sh",
		...(mode === "ownerAtStart"
			? [`owner=$(cat "$ATOMIC_SECURITY_QUERY_PATH/.owner-sid" 2>/dev/null || printf '%s' '${CURRENT_SID}')`]
			: []),
		`echo "$$ ${host} $ATOMIC_SECURITY_QUERY_PATH" >> '${join(bin, "launches.log")}'`,
		`printf '%s\\n' "$@" > '${join(bin, `${host}.args`)}'`,
		`printf '%s' "\${PSModulePath-unset}" > '${join(bin, `${host}.psmodulepath`)}'`,
		...body[mode],
	].join("\n");
}

function installFakePowerShell(mode: FakePowerShellMode, pwshMode: FakePowerShellMode = mode): FakePowerShell {
	const bin = mkdtempSync(join(tmpdir(), "atomic-fake-pwsh-"));
	const logPath = join(bin, "launches.log");
	writeFileSync(logPath, "");
	for (const [host, hostMode] of [
		["powershell.exe", mode],
		["pwsh.exe", pwshMode],
	] as const) {
		writeFileSync(join(bin, host), `${fakeHostScript(host, hostMode, bin)}\n`, { mode: 0o755 });
	}
	const savedPath = process.env.PATH;
	process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
	return {
		logPath,
		launches: () =>
			readFileSync(logPath, "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => {
					const [pid, host, ...path] = line.split(" ");
					return { pid: Number(pid), host: host ?? "", path: path.join(" ") };
				}),
		argumentsOf: (host) =>
			readFileSync(join(bin, `${host}.args`), "utf8")
				.split("\n")
				.slice(0, -1),
		modulePathOf: (host) => readFileSync(join(bin, `${host}.psmodulepath`), "utf8"),
		restore() {
			process.env.PATH = savedPath;
			rmSync(bin, { recursive: true, force: true });
		},
	};
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition never held");
		await sleep(10);
	}
}

function oversizedOutput(): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			onData(Buffer.alloc(DEFAULT_MAX_BYTES * 2, 0x61), "stdout");
			return { exitCode: 0 };
		},
	};
}

describe("asynchronous windows directory security reader (#5285)", () => {
	let fake: FakePowerShell | undefined;
	let dir: string;

	beforeEach(() => {
		resetWindowsDirectorySecurityStateForTesting();
		dir = mkdtempSync(join(tmpdir(), "atomic-win-acl-async-"));
	});

	afterEach(() => {
		resetWindowsDirectorySecurityStateForTesting();
		fake?.restore();
		fake = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	it.skipIf(isWindows)("reads a descriptor without blocking the main thread (#5285)", async () => {
		fake = installFakePowerShell("answer");
		let descriptor: WindowsDirectorySecurity | undefined;
		const blockedMs = await longestMainThreadBlockMs(async () => {
			descriptor = await readWindowsDirectorySecurityAsync(dir);
		});

		assert.deepEqual(
			descriptor,
			security({ dacl: `D:(A;OICI;FA;;;${CURRENT_SID})`, accessRules: [{ allow: true, sid: CURRENT_SID }] }),
		);
		assert.deepEqual(
			fake.launches().map((launch) => launch.path),
			[dir],
		);
		const [noProfile, nonInteractive, command, script] = fake.argumentsOf("powershell.exe");
		assert.deepEqual([noProfile, nonInteractive, command], ["-NoProfile", "-NonInteractive", "-Command"]);
		assert.match(script ?? "", /Get-Acl -LiteralPath \$env:ATOMIC_SECURITY_QUERY_PATH/);
		assert.ok(blockedMs < MAIN_THREAD_BLOCK_LIMIT_MS, `the main thread was blocked for ${blockedMs} ms`);
	});

	it.skipIf(isWindows)(
		"starts the PowerShell read without the parent's PSModulePath, which breaks Get-Acl under a PowerShell 7 parent (#5324)",
		async () => {
			fake = installFakePowerShell("answer");
			const saved = process.env.PSModulePath;
			process.env.PSModulePath = "C:\\Program Files\\PowerShell\\7\\Modules";
			try {
				assert.equal((await readWindowsDirectorySecurityAsync(dir))?.ownerSid, CURRENT_SID);
			} finally {
				if (saved === undefined) delete process.env.PSModulePath;
				else process.env.PSModulePath = saved;
			}
			assert.equal(fake.modulePathOf("powershell.exe"), "unset");
		},
	);

	it.skipIf(isWindows)("shares one subprocess among concurrent reads of one path (#5285)", async () => {
		fake = installFakePowerShell("answer");
		const descriptors = await Promise.all(Array.from({ length: 5 }, () => readWindowsDirectorySecurityAsync(dir)));

		assert.equal(fake.launches().length, 1, "one PowerShell read serves every concurrent caller");
		for (const descriptor of descriptors) assert.equal(descriptor?.ownerSid, CURRENT_SID);
	});

	it.skipIf(isWindows)("kills the read when its signal aborts (#5285)", async () => {
		fake = installFakePowerShell("hang");
		const controller = new AbortController();
		const read = readWindowsDirectorySecurityAsync(dir, { signal: controller.signal });
		await waitFor(() => fake?.launches().length === 1);
		const [{ pid }] = fake.launches();

		const abortedAt = performance.now();
		controller.abort();
		assert.equal(await read, undefined);
		assert.ok(performance.now() - abortedAt < 1_000, "an aborted read settles at once");
		await waitFor(() => !processIsAlive(pid));
		assert.equal(fake.launches().length, 1, "no other PowerShell candidate is tried after an abort");
	});

	it.skipIf(isWindows)("kills the read at its timeout (#5285)", async () => {
		fake = installFakePowerShell("hang");
		const startedAt = performance.now();
		assert.equal(await readWindowsDirectorySecurityAsync(dir, { timeoutMs: 300 }), undefined);
		const elapsedMs = performance.now() - startedAt;
		assert.ok(elapsedMs >= 250 && elapsedMs < 5_000, `the timeout bounds the read (${elapsedMs} ms)`);
		const [{ pid }] = fake.launches();
		await waitFor(() => !processIsAlive(pid));
	});

	it.skipIf(isWindows)("keeps a shared read going for the callers still waiting when one aborts (#5285)", async () => {
		fake = installFakePowerShell("answer");
		const controller = new AbortController();
		const abandoned = readWindowsDirectorySecurityAsync(dir, { signal: controller.signal });
		const timedOut = readWindowsDirectorySecurityAsync(dir, { timeoutMs: 50 });
		const kept = readWindowsDirectorySecurityAsync(dir);
		controller.abort();

		assert.equal(await abandoned, undefined);
		assert.equal(await timedOut, undefined);
		assert.equal((await kept)?.ownerSid, CURRENT_SID);
		assert.equal(fake.launches().length, 1);
	});

	it.skipIf(isWindows)("does not start a read whose signal already aborted (#5285)", async () => {
		fake = installFakePowerShell("answer");
		const controller = new AbortController();
		controller.abort();
		assert.equal(await readWindowsDirectorySecurityAsync(dir, { signal: controller.signal }), undefined);
		assert.deepEqual(fake.launches(), []);
	});

	it.skipIf(isWindows)(
		"refuses the output of a PowerShell host that failed and tries the next one (#5285)",
		async () => {
			fake = installFakePowerShell("fail", "answer");
			assert.equal((await readWindowsDirectorySecurityAsync(dir))?.ownerSid, CURRENT_SID);
			assert.deepEqual(
				fake.launches().map((launch) => launch.host),
				["powershell.exe", "pwsh.exe"],
			);
		},
	);

	it.skipIf(isWindows)("tries the next PowerShell host after unparseable output (#5285)", async () => {
		fake = installFakePowerShell("garbage", "answer");
		assert.equal((await readWindowsDirectorySecurityAsync(dir))?.ownerSid, CURRENT_SID);
		assert.deepEqual(
			fake.launches().map((launch) => launch.host),
			["powershell.exe", "pwsh.exe"],
		);
	});

	it.skipIf(isWindows)("shares the read started after an abandoned one with every later caller (#5285)", async () => {
		fake = installFakePowerShell("hang");
		const abandon = new AbortController();
		const abandoned = readWindowsDirectorySecurityAsync(dir, { signal: abandon.signal });
		await waitFor(() => fake?.launches().length === 1);
		abandon.abort();
		assert.equal(await abandoned, undefined);

		const stop = new AbortController();
		const second = readWindowsDirectorySecurityAsync(dir, { signal: stop.signal });
		await waitFor(() => fake?.launches().length === 2);
		await sleep(50);
		const third = readWindowsDirectorySecurityAsync(dir, { signal: stop.signal });
		await sleep(50);
		assert.equal(fake.launches().length, 2, "a later caller joins the read in flight");
		stop.abort();
		assert.deepEqual(await Promise.all([second, third]), [undefined, undefined]);
	});

	it.skipIf(isWindows)(
		"refuses an unverified directory synchronously without reading it, and adopts it once the background read verified it (#5285)",
		async () => {
			fake = installFakePowerShell("answer");
			const startedAt = performance.now();
			assert.equal(verifyWindowsDirectorySecurity(dir), "its ownership is still being verified");
			assert.ok(performance.now() - startedAt < MAIN_THREAD_BLOCK_LIMIT_MS, "the synchronous check never waits");

			assert.equal(await verifyWindowsDirectorySecurityAsync(dir), undefined);
			assert.equal(verifyWindowsDirectorySecurity(dir), undefined);
			assert.equal(fake.launches().length, 1, "the synchronous check started the read the asynchronous one joined");
		},
	);

	it.skipIf(isWindows)("a read the process awaits keeps it alive until the read answers (#5285)", async () => {
		fake = installFakePowerShell("answer");
		const probe = join(dir, "probe.mjs");
		writeFileSync(
			probe,
			[
				`const { readWindowsDirectorySecurityAsync } = await import(${JSON.stringify(pathToFileURL(SECURITY_MODULE).href)});`,
				`readWindowsDirectorySecurityAsync(${JSON.stringify(dir)}).then((security) => process.stdout.write(String(security?.ownerSid)));`,
			].join("\n"),
		);
		for (const runtime of [[bunExecutable()], NODE_SOURCE_RUNTIME]) {
			const child = spawnProcess([...runtime, probe], { stdout: "pipe", stderr: "pipe" });
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				readStreamText(child.stdout),
				readStreamText(child.stderr),
			]);
			assert.equal(exitCode, 0, `${runtime[0]}: ${stderr}`);
			assert.equal(stdout, CURRENT_SID, `${runtime[0]} exited before the read answered`);
		}
	});

	it.skipIf(isWindows)("a background read does not keep a finished process alive (#5285)", async () => {
		fake = installFakePowerShell("hang");
		const probe = join(dir, "probe.mjs");
		writeFileSync(
			probe,
			[
				`const { verifyWindowsDirectorySecurity } = await import(${JSON.stringify(pathToFileURL(SECURITY_MODULE).href)});`,
				`process.stdout.write(String(verifyWindowsDirectorySecurity(${JSON.stringify(dir)})));`,
			].join("\n"),
		);
		for (const runtime of [[bunExecutable()], NODE_SOURCE_RUNTIME]) {
			const child = spawnProcess([...runtime, probe], { stdout: "pipe", stderr: "pipe" });
			const output = Promise.all([readStreamText(child.stdout), readStreamText(child.stderr)]);
			const exitedInTime = await Promise.race([
				child.exited.then(() => true),
				sleep(BACKGROUND_EXIT_BOUND_MS).then(() => false),
			]);
			if (!exitedInTime) child.kill();
			const [stdout, stderr] = await output;

			assert.ok(exitedInTime, `${runtime[0]} stayed alive for the read`);
			assert.equal(child.exitCode, 0, `${runtime[0]}: ${stderr}`);
			assert.equal(stdout, "its ownership is still being verified");
		}
		await waitFor(() => fake?.launches().length === 2);
		// #6125: each hung read, recorded while it hangs, and ended only while its pid still names it.
		for (const { pid } of fake.launches()) await signalRecordedProcess(await recordProcess(pid), "SIGTERM");
	});

	it.skipIf(isWindows)(
		"a caller that finds a replaced directory never joins the read of the directory it replaced (#5285)",
		async () => {
			fake = installFakePowerShell("ownerAtStart");
			const first = verifyWindowsDirectorySecurityAsync(dir);
			await waitFor(() => fake?.launches().length === 1);
			renameSync(dir, `${dir}-replaced`);
			mkdirSync(dir);
			writeFileSync(join(dir, ".owner-sid"), FOREIGN_SID);
			const second = verifyWindowsDirectorySecurityAsync(dir);

			try {
				assert.equal(await first, "its ownership could not be verified");
				assert.equal(await second, "it is owned by another account");
				assert.equal(
					verifyWindowsDirectorySecurity(dir, { startVerification: false }),
					"its ownership is still being verified",
				);
				assert.equal(fake.launches().length, 2, "the replacement directory gets its own read");
			} finally {
				rmSync(`${dir}-replaced`, { recursive: true, force: true });
			}

			const probe = join(dir, "swap-probe.mjs");
			writeFileSync(
				probe,
				[
					`import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";`,
					`import { join } from "node:path";`,
					`const { verifyWindowsDirectorySecurity, verifyWindowsDirectorySecurityAsync } = await import(${JSON.stringify(pathToFileURL(SECURITY_MODULE).href)});`,
					`const target = process.argv[2];`,
					`const first = verifyWindowsDirectorySecurityAsync(target);`,
					`while (!readFileSync(${JSON.stringify(fake.logPath)}, "utf8").includes(target)) {`,
					`	await new Promise((resolve) => setTimeout(resolve, 10));`,
					`}`,
					`renameSync(target, \`\${target}-old\`);`,
					`mkdirSync(target);`,
					`writeFileSync(join(target, ".owner-sid"), ${JSON.stringify(FOREIGN_SID)});`,
					`const second = verifyWindowsDirectorySecurityAsync(target);`,
					`const results = await Promise.all([first, second]);`,
					`const cached = verifyWindowsDirectorySecurity(target, { startVerification: false });`,
					`rmSync(\`\${target}-old\`, { recursive: true, force: true });`,
					`process.stdout.write(JSON.stringify([...results, cached]));`,
				].join("\n"),
			);
			for (const [index, runtime] of [[bunExecutable()], NODE_SOURCE_RUNTIME].entries()) {
				const target = join(dir, `runtime-${index}`);
				mkdirSync(target);
				const child = spawnProcess([...runtime, probe, target], { stdout: "pipe", stderr: "pipe" });
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					readStreamText(child.stdout),
					readStreamText(child.stderr),
				]);
				assert.equal(exitCode, 0, `${runtime[0]}: ${stderr}`);
				assert.deepEqual(JSON.parse(stdout), [
					"its ownership could not be verified",
					"it is owned by another account",
					"its ownership is still being verified",
				]);
			}
		},
	);

	it.skipIf(isWindows)(
		"resolves a relative path against the caller's working directory rather than the neutral PowerShell cwd (#5285)",
		async () => {
			fake = installFakePowerShell("ownerAtStart");
			const callerDir = join(dir, "caller");
			const neutralDir = join(dir, "neutral");
			const relativeTarget = "target [literal]";
			mkdirSync(join(callerDir, relativeTarget), { recursive: true });
			mkdirSync(join(neutralDir, relativeTarget), { recursive: true });
			writeFileSync(join(callerDir, relativeTarget, ".owner-sid"), FOREIGN_SID);
			const probe = join(dir, "relative-probe.mjs");
			writeFileSync(
				probe,
				[
					`const { readWindowsDirectorySecurityAsync, verifyWindowsDirectorySecurityAsync } = await import(${JSON.stringify(pathToFileURL(SECURITY_MODULE).href)});`,
					`const target = process.argv[2];`,
					`const refusal = await verifyWindowsDirectorySecurityAsync(target);`,
					`const descriptor = await readWindowsDirectorySecurityAsync(target);`,
					`process.stdout.write(JSON.stringify({ refusal, ownerSid: descriptor?.ownerSid }));`,
				].join("\n"),
			);
			for (const runtime of [[bunExecutable()], NODE_SOURCE_RUNTIME]) {
				const child = spawnProcess([...runtime, probe, relativeTarget], {
					cwd: callerDir,
					env: { ...process.env, SystemRoot: neutralDir, windir: neutralDir },
					stdout: "pipe",
					stderr: "pipe",
				});
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					readStreamText(child.stdout),
					readStreamText(child.stderr),
				]);
				assert.equal(exitCode, 0, `${runtime[0]}: ${stderr}`);
				assert.deepEqual(JSON.parse(stdout), {
					refusal: "it is owned by another account",
					ownerSid: FOREIGN_SID,
				});
			}
			for (const launch of fake.launches()) {
				assert.equal(launch.path, join(callerDir, relativeTarget));
			}
		},
	);

	it.skipIf(!isWindows)(
		"resolves a relative path against the caller's working directory on Windows (#5285)",
		async () => {
			const callerDir = join(dir, "caller");
			const neutralDir = join(dir, "neutral");
			const relativeTarget = "target [literal]";
			mkdirSync(join(callerDir, relativeTarget), { recursive: true });
			mkdirSync(join(neutralDir, relativeTarget), { recursive: true });
			const granted = spawnSyncCollect(["icacls", join(callerDir, relativeTarget), "/grant", "*S-1-1-0:(OI)(CI)F"]);
			assert.equal(granted.exitCode, 0, granted.stderr.toString());
			await assert.rejects(assertPrivateDirectoryAsync(join(callerDir, relativeTarget)), TempDirRefusedError);
			const probe = join(dir, "win-relative-probe.mjs");
			writeFileSync(
				probe,
				[
					`const { evaluateWindowsDirectorySecurity, readWindowsDirectorySecurityAsync, verifyWindowsDirectorySecurityAsync } = await import(${JSON.stringify(pathToFileURL(SECURITY_MODULE).href)});`,
					`const target = process.argv[2];`,
					`const refusal = await verifyWindowsDirectorySecurityAsync(target);`,
					`const descriptor = await readWindowsDirectorySecurityAsync(target);`,
					`const evaluated = descriptor ? evaluateWindowsDirectorySecurity(descriptor) : "unreadable";`,
					`process.stdout.write(JSON.stringify({ refusal, evaluated }));`,
				].join("\n"),
			);
			for (const runtime of [[bunExecutable()], NODE_SOURCE_RUNTIME]) {
				const child = spawnProcess([...runtime, probe, relativeTarget], {
					cwd: callerDir,
					env: { ...process.env, SystemRoot: neutralDir, windir: neutralDir },
					stdout: "pipe",
					stderr: "pipe",
				});
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					readStreamText(child.stdout),
					readStreamText(child.stderr),
				]);
				assert.equal(exitCode, 0, `${runtime[0]}: ${stderr}`);
				assert.deepEqual(JSON.parse(stdout), {
					refusal: "it grants access to another account",
					evaluated: "it grants access to another account",
				});
			}
		},
	);

	it("does not evict a replacement directory's verified entry when the old directory's read later refuses (#5285)", async () => {
		let finishOld: (security: WindowsDirectorySecurity) => void = () => {};
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let reads = 0;
		setWindowsDirectorySecurityReaderForTesting(() => {
			reads += 1;
			if (reads === 1) {
				markStarted();
				return new Promise<WindowsDirectorySecurity>((resolve) => {
					finishOld = resolve;
				});
			}
			return security();
		});
		const oldRead = verifyWindowsDirectorySecurityAsync(dir);
		await started;
		renameSync(dir, `${dir}-old`);
		mkdirSync(dir);
		try {
			assert.equal(await verifyWindowsDirectorySecurityAsync(dir), undefined);
			assert.equal(verifyWindowsDirectorySecurity(dir, { startVerification: false }), undefined);
			finishOld(security({ ownerSid: FOREIGN_SID }));
			assert.equal(await oldRead, "it is owned by another account");
			assert.equal(verifyWindowsDirectorySecurity(dir, { startVerification: false }), undefined);
			assert.equal(await verifyWindowsDirectorySecurityAsync(dir), undefined);
			assert.equal(reads, 2);
		} finally {
			rmSync(`${dir}-old`, { recursive: true, force: true });
		}
	});

	it("does not cache a directory replaced while it was read (#5285)", async () => {
		const reads: string[] = [];
		setWindowsDirectorySecurityReaderForTesting(async (path) => {
			reads.push(path);
			if (reads.length === 1) {
				renameSync(path, `${path}-verified`);
				mkdirSync(path);
			}
			return security();
		});
		assert.equal(await verifyWindowsDirectorySecurityAsync(dir), "its ownership could not be verified");
		assert.equal(await verifyWindowsDirectorySecurityAsync(dir), undefined);
		assert.deepEqual(reads, [dir, dir], "the directory found after the read is read again");
		rmSync(`${dir}-verified`, { recursive: true, force: true });
	});

	it("does not cache a verification that a state reset overtook (#5285)", async () => {
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		setWindowsDirectorySecurityReaderForTesting(async () => {
			markStarted();
			await released;
			return security();
		});
		const overtaken = verifyWindowsDirectorySecurityAsync(dir);
		await started;
		resetWindowsDirectorySecurityStateForTesting();
		let reads = 0;
		setWindowsDirectorySecurityReaderForTesting(() => {
			reads += 1;
			return security();
		});
		release();
		assert.equal(await overtaken, "its ownership could not be verified");
		assert.equal(await verifyWindowsDirectorySecurityAsync(dir), undefined);
		assert.equal(reads, 1, "the overtaken verification left nothing cached");
	});

	it("refuses a missing directory synchronously without starting a read (#5285)", () => {
		let reads = 0;
		setWindowsDirectorySecurityReaderForTesting(() => {
			reads += 1;
			return security();
		});
		assert.equal(verifyWindowsDirectorySecurity(join(dir, "missing")), "its ownership could not be verified");
		assert.equal(reads, 0);
	});

	it("never caches a refusal or a failed read (#5285)", async () => {
		const reads: string[] = [];
		let descriptor: WindowsDirectorySecurity | undefined = security({ ownerSid: FOREIGN_SID });
		setWindowsDirectorySecurityReaderForTesting(async (path) => {
			reads.push(path);
			return descriptor;
		});
		assert.equal(await verifyWindowsDirectorySecurityAsync(dir), "it is owned by another account");
		descriptor = undefined;
		assert.equal(await verifyWindowsDirectorySecurityAsync(dir), "its ownership could not be verified");
		descriptor = security();
		assert.equal(await verifyWindowsDirectorySecurityAsync(dir), undefined);
		assert.equal(await verifyWindowsDirectorySecurityAsync(dir), undefined);
		assert.deepEqual(reads, [dir, dir, dir], "a refusal and a failed read are read again; a verification is not");
	});
});

describe("windows temp directories verified off the main thread (#5285)", () => {
	const envKeys = ["TMPDIR", "TEMP", "TMP", "ATOMIC_CODING_AGENT_DIR"] as const;
	const savedEnv = new Map<string, string | undefined>();
	let sandbox: string;
	let restorePlatform: (() => void) | undefined;
	let fake: FakePowerShell | undefined;

	beforeEach(() => {
		sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-win-acl-off-main-")));
		mkdirSync(join(sandbox, "tmp"));
		mkdirSync(join(sandbox, "agent"));
		for (const key of envKeys) savedEnv.set(key, process.env[key]);
		process.env.TMPDIR = process.env.TEMP = process.env.TMP = join(sandbox, "tmp");
		process.env.ATOMIC_CODING_AGENT_DIR = join(sandbox, "home", "agent");
		resetSessionTempDirStateForTesting();
	});

	afterEach(() => {
		restorePlatform?.();
		restorePlatform = undefined;
		resetSessionTempDirStateForTesting();
		fake?.restore();
		fake = undefined;
		for (const key of envKeys) {
			const saved = savedEnv.get(key);
			if (saved === undefined) delete process.env[key];
			else process.env[key] = saved;
		}
		rmSync(sandbox, { recursive: true, force: true });
	});

	function simulateWindows(): void {
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		restorePlatform = () => {
			if (descriptor) Object.defineProperty(process, "platform", descriptor);
		};
	}

	async function spillBurst(): Promise<void> {
		for (let session = 0; session < SESSION_BURST; session++) {
			const sessionTempDir = resolveSessionTempDirPath(`burst-${session}`);
			const result = await executeBashWithOperations("produce output", process.cwd(), oversizedOutput(), {
				sessionTempDir,
			});
			assert.ok(result.fullOutputPath?.startsWith(sessionTempDir), `session ${session} spilled outside its tree`);
		}
	}

	it.skipIf(isWindows)(
		"a burst of new session spills reads the private root once without blocking the main thread (simulated on POSIX) (#5285)",
		async () => {
			fake = installFakePowerShell("answer");
			simulateWindows();
			const reads: string[] = [];
			setWindowsDirectorySecurityReaderForTesting((path, options) => {
				reads.push(path);
				return readWindowsDirectorySecurityAsync(path, options);
			});
			const blockedMs = await longestMainThreadBlockMs(spillBurst);

			assert.deepEqual(reads, [getTempRootDir()], "only the private root is read, once");
			assert.deepEqual(
				fake.launches().map((launch) => launch.path),
				[getTempRootDir()],
				"one PowerShell process reads it",
			);
			assert.ok(blockedMs < MAIN_THREAD_BLOCK_LIMIT_MS, `the main thread was blocked for ${blockedMs} ms`);
		},
	);

	it.skipIf(!isWindows)(
		"a burst of new session temp directories reads the private root once without blocking the main thread (#5285)",
		async () => {
			const reads: string[] = [];
			setWindowsDirectorySecurityReaderForTesting((path, options) => {
				reads.push(path);
				return readWindowsDirectorySecurityAsync(path, options);
			});
			const blockedMs = await longestMainThreadBlockMs(async () => {
				for (let session = 0; session < SESSION_BURST; session++) {
					await getSessionTempDirAsync(`burst-${session}`);
				}
			});

			assert.deepEqual(reads, [getTempRootDir()], "only the private root is read, once");
			assert.ok(blockedMs < MAIN_THREAD_BLOCK_LIMIT_MS, `the main thread was blocked for ${blockedMs} ms`);
		},
	);

	it("each asynchronous Windows temp-directory creation gives other queued work a turn (#5324)", async () => {
		if (!isWindows) simulateWindows();
		setWindowsDirectorySecurityReaderForTesting(() => security());
		await getSessionTempDirAsync("prewarmed-root");
		for (let session = 0; session < SESSION_BURST; session++) {
			let yielded = false;
			const turn = new Promise<void>((resolve) =>
				setImmediate(() => {
					yielded = true;
					resolve();
				}),
			);
			await getSessionTempDirAsync(`yielding-${session}`);
			const yieldedBeforeCompletion = yielded;
			await turn;
			assert.equal(yieldedBeforeCompletion, true);
		}
	});

	it("session start verifies the private roots in the background, so a later synchronous caller finds them verified (#5285)", async () => {
		const reads: Array<{ path: string; background: boolean | undefined }> = [];
		const agentDir = process.env.ATOMIC_CODING_AGENT_DIR ?? "";
		const ownerRoot = getTempRootDir();
		const cacheRoot = join(agentDir, "cache", "tmp");
		setWindowsDirectorySecurityReaderForTesting(async (path, options) => {
			reads.push({ path, background: options.background });
			if (path === cacheRoot) await sleep(20);
			return security();
		});
		if (!isWindows) simulateWindows();

		setActiveSessionTempId("first-session");
		await waitForWindowsDirectorySecurityReadsForTesting();
		assert.equal(existsSync(agentDir), false, "session start never creates the agent directory's cache");

		mkdirSync(cacheRoot, { recursive: true });
		setActiveSessionTempId("prewarmed-session");
		await waitForWindowsDirectorySecurityReadsForTesting();

		const settledReads = reads.length;
		assert.ok(getSessionTempDir("prewarmed-session").startsWith(`${ownerRoot}${sep}`));
		assert.ok(ensurePrivateTempDir("extensions").startsWith(`${cacheRoot}${sep}`));
		assert.deepEqual(
			reads.slice(0, 2).sort((left, right) => left.path.localeCompare(right.path)),
			[
				{ path: cacheRoot, background: true },
				{ path: ownerRoot, background: true },
			].sort((left, right) => left.path.localeCompare(right.path)),
		);
		assert.equal(reads.length, settledReads, "nothing is read again once the roots are verified");

		const explicitDir = join(sandbox, "explicit-private");
		mkdirSync(explicitDir);
		await assertPrivateDirectoryAsync(explicitDir);
		const callerDir = join(sandbox, "caller-temp", "leaf");
		await ensureSessionTempDirAsync(callerDir);
		assert.deepEqual(reads.slice(settledReads), [
			{ path: explicitDir, background: undefined },
			{ path: callerDir, background: undefined },
		]);
	});

	it.skipIf(isWindows)(
		"session-start private root verification does not keep a finished process alive (#5324)",
		async () => {
			fake = installFakePowerShell("hang");
			const cacheRoot = join(process.env.ATOMIC_CODING_AGENT_DIR ?? "", "cache", "tmp");
			mkdirSync(cacheRoot, { recursive: true });
			const probe = join(sandbox, "session-start-probe.mjs");
			writeFileSync(
				probe,
				[
					`Object.defineProperty(process, "platform", { value: "win32", configurable: true });`,
					`const { setActiveSessionTempId } = await import(${JSON.stringify(pathToFileURL(SESSION_TEMP_DIR_MODULE).href)});`,
					`process.stdout.write(setActiveSessionTempId("short-lived-session"));`,
				].join("\n"),
			);
			const child = spawnProcess([...NODE_SOURCE_RUNTIME, probe], { stdout: "pipe", stderr: "pipe" });
			const reads: RecordedProcess[] = [];
			try {
				const output = Promise.all([readStreamText(child.stdout), readStreamText(child.stderr)]);
				const exitedInTime = await Promise.race([
					child.exited.then(() => true),
					sleep(BACKGROUND_EXIT_BOUND_MS).then(() => false),
				]);
				if (!exitedInTime) child.kill();
				const [stdout, stderr] = await output;

				assert.ok(exitedInTime, "session-start verification kept the process alive");
				assert.equal(child.exitCode, 0, stderr);
				assert.ok(stdout.endsWith(`${sep}short-lived-session`));
				await waitFor(() => (fake?.launches().length ?? 0) >= 1);
				// #6125: each read, recorded while it hangs, so the cleanup never ends a later process given its pid.
				for (const { pid } of fake.launches()) reads.push(await recordProcess(pid));
			} finally {
				for (const read of reads) await signalRecordedProcess(read, "SIGTERM");
			}
		},
	);

	it.skipIf(isWindows)("session start creates and reads nothing on POSIX (#5285)", () => {
		let reads = 0;
		setWindowsDirectorySecurityReaderForTesting(() => {
			reads += 1;
			return security();
		});
		setActiveSessionTempId("posix-session");
		assert.equal(existsSync(getTempRootDir()), false);
		assert.equal(existsSync(join(process.env.ATOMIC_CODING_AGENT_DIR ?? "", "cache")), false);
		assert.equal(reads, 0);
	});

	it("an asynchronous caller gets the refusal of an untrusted root and falls back past it (#5285)", async () => {
		setWindowsDirectorySecurityReaderForTesting(async () => security({ ownerSid: FOREIGN_SID }));
		if (!isWindows) simulateWindows();

		await assert.rejects(
			getSessionTempDirAsync("foreign-root"),
			(error: unknown) =>
				error instanceof TempDirRefusedError && error.message.includes("it is owned by another account"),
		);
		const fallback = await ensurePrivateTempDirAsync("extensions");
		assert.equal(fallback.startsWith(`${getTempRootDir()}${sep}`), false);
		assert.equal(fallback.startsWith(`${join(process.env.ATOMIC_CODING_AGENT_DIR ?? "", "cache")}${sep}`), false);
	});

	it("a synchronous caller falls back while the private root is still being verified, and uses the root on a later call (#5285)", async () => {
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		setWindowsDirectorySecurityReaderForTesting(async () => {
			await released;
			return security();
		});
		if (!isWindows) simulateWindows();
		const cacheRoot = join(process.env.ATOMIC_CODING_AGENT_DIR ?? "", "cache", "tmp");

		const early = ensurePrivateTempDir("extensions");
		assert.equal(early.startsWith(cacheRoot), false, "an unverified root is never used");
		assert.throws(
			() => getSessionTempDir("unverified-root"),
			(error: unknown) =>
				error instanceof TempDirRefusedError && error.message.includes("its ownership is still being verified"),
		);

		release();
		assert.ok((await ensurePrivateTempDirAsync("extensions")).startsWith(cacheRoot));
		assert.ok(ensurePrivateTempDir("extensions").startsWith(cacheRoot), "the next synchronous call uses the root");
		assert.ok((await getSessionTempDirAsync("unverified-root")).startsWith(getTempRootDir()));
	});
});
