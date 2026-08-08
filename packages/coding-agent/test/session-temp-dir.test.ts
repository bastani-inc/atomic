/**
 * Session-scoped temp storage: path scoping, traversal-safe sanitization, and
 * owner-only permissions for the directories and files tools spill into.
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
import { dirname, join, relative, sep } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../../../test/helpers/runtime.ts";
import { redirectOversizedToolResult } from "../src/core/tools/oversized-tool-result.ts";
import { PersistedOutputFile } from "../src/core/tools/persisted-output-file.ts";
import {
	deriveOwnerComponent,
	ensureTempDir,
	getSessionTempDir,
	getTempRootDir,
	resetSessionTempDirStateForTesting,
	resolveSessionTempDirPath,
	SESSION_TEMP_DIR_MODE,
	SESSION_TEMP_FILE_MODE,
	sanitizeTempPathComponent,
	setActiveSessionTempId,
	TempDirRefusedError,
	windowsPrincipal,
} from "../src/core/tools/session-temp-dir.ts";
import { DEFAULT_MAX_RESULT_SIZE_CHARS, TOOL_RESULTS_SUBDIR } from "../src/core/tools/tool-limits.ts";

const isPosix = process.platform !== "win32";

const envKeys = ["TMPDIR", "TEMP", "TMP"] as const;
const savedEnv = new Map<string, string | undefined>();
let sandbox: string;

/** Point os.tmpdir() at a sandbox so the suite never writes into the real temp root. */
function useSandboxTmpdir(dir: string): void {
	for (const key of envKeys) {
		savedEnv.set(key, process.env[key]);
		process.env[key] = dir;
	}
}

beforeAll(() => {
	// Use a stable real sandbox for the main suite. The isolated symlink-base
	// regression below preserves a lexical TMPDIR spelling on purpose.
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-session-temp-dir-")));
	useSandboxTmpdir(sandbox);
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
});

/** True when `child` resolves inside `parent`. */
function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`${sep}..`);
}

/** Restore an env var to its exact prior state, including having been unset. */
function restoreEnv(name: string, saved: string | undefined): void {
	if (saved === undefined) delete process.env[name];
	else process.env[name] = saved;
}

describe("session temp directory scoping", () => {
	it("puts every session under one owner-scoped root inside the temp directory", () => {
		const root = getTempRootDir();
		assert.ok(isInside(sandbox, root), `${root} is not inside ${sandbox}`);
		assert.ok(isInside(root, resolveSessionTempDirPath("session-abc")));
	});

	it("keeps a session id containing path separators inside the root", () => {
		for (const hostile of [
			"../../escape",
			"..",
			".",
			"../..",
			"a/../../b",
			"C:\\Windows\\Temp",
			"/etc/passwd",
			"..\\..\\escape",
			"....//....//escape",
		]) {
			const dir = resolveSessionTempDirPath(hostile);
			assert.ok(isInside(getTempRootDir(), dir), `${hostile} escaped to ${dir}`);
			assert.equal(relative(getTempRootDir(), dir).includes(sep), false, `${hostile} added a path level`);
		}
	});

	it("gives accounts whose names sanitize alike their own owner roots", () => {
		// `aliceé` and `aliceø` both reduce to the same safe component, so before
		// the digest was added they selected one shared root. On a machine-wide,
		// shared-accessible temp directory that put one account's persisted tool
		// output inside another account's tree.
		const colliding = ["aliceé", "aliceø", "alice*", "alice"];
		const components = colliding.map(deriveOwnerComponent);
		assert.equal(
			new Set(components).size,
			colliding.length,
			`distinct accounts shared an owner root: ${components.join(", ")}`,
		);

		for (const component of components) {
			assert.equal(component.includes(sep), false, `${component} added a path level`);
			assert.equal(component.includes("/"), false, `${component} added a path level`);
		}
	});

	it("keeps one Windows account on one root across case spellings", () => {
		// Windows account names are case-insensitive, so these are one account and
		// must not be handed two trees.
		assert.equal(deriveOwnerComponent("Alice"), deriveOwnerComponent("alice"));
		assert.equal(deriveOwnerComponent("ALICE"), deriveOwnerComponent("alice"));
	});

	it("still yields a usable component for an unnameable account", () => {
		const component = deriveOwnerComponent("");
		assert.ok(component.length > 0, "an empty identity still needs a root");
		assert.equal(component.includes(sep), false);
		// Two processes that both fail to name the account agree on one root
		// rather than scattering trees the sweeper would have to chase.
		assert.equal(component, deriveOwnerComponent(""));
	});

	it("separates domain principals that share a bare account name", () => {
		// userInfo().username returns only `Alice`, so a digest over the bare name
		// left CONTOSO\Alice and FABRIKAM\Alice on one tree.
		const savedDomain = process.env.USERDOMAIN;
		const savedDnsDomain = process.env.USERDNSDOMAIN;
		const savedUsername = process.env.USERNAME;
		const roots: string[] = [];
		try {
			delete process.env.USERDNSDOMAIN;
			process.env.USERNAME = "Alice";
			for (const domain of ["CONTOSO", "FABRIKAM"]) {
				process.env.USERDOMAIN = domain;
				roots.push(deriveOwnerComponent(windowsPrincipal("Alice")));
			}
		} finally {
			restoreEnv("USERDOMAIN", savedDomain);
			restoreEnv("USERDNSDOMAIN", savedDnsDomain);
			restoreEnv("USERNAME", savedUsername);
		}
		assert.equal(new Set(roots).size, 2, `domain principals shared a root: ${roots.join(", ")}`);
	});

	it("separates forests that share a NetBIOS domain name", () => {
		const savedDomain = process.env.USERDOMAIN;
		const savedDnsDomain = process.env.USERDNSDOMAIN;
		const roots: string[] = [];
		try {
			process.env.USERDOMAIN = "CONTOSO";
			for (const dns of ["eu.contoso.com", "us.contoso.com"]) {
				process.env.USERDNSDOMAIN = dns;
				roots.push(deriveOwnerComponent(windowsPrincipal("Alice")));
			}
		} finally {
			restoreEnv("USERDOMAIN", savedDomain);
			restoreEnv("USERDNSDOMAIN", savedDnsDomain);
		}
		assert.equal(new Set(roots).size, 2, `two forests shared a root: ${roots.join(", ")}`);
	});

	it("keeps one principal on one root across invocations and case", () => {
		const savedDomain = process.env.USERDOMAIN;
		const savedDnsDomain = process.env.USERDNSDOMAIN;
		try {
			delete process.env.USERDNSDOMAIN;
			process.env.USERDOMAIN = "CONTOSO";
			const first = deriveOwnerComponent(windowsPrincipal("Alice"));
			process.env.USERDOMAIN = "contoso";
			assert.equal(deriveOwnerComponent(windowsPrincipal("alice")), first);
		} finally {
			restoreEnv("USERDOMAIN", savedDomain);
			restoreEnv("USERDNSDOMAIN", savedDnsDomain);
		}
	});

	it("never produces a dot-only or hidden component", () => {
		assert.equal(sanitizeTempPathComponent("..", "fallback"), "fallback");
		assert.equal(sanitizeTempPathComponent(".", "fallback"), "fallback");
		assert.equal(sanitizeTempPathComponent("///", "fallback"), "fallback");
		assert.equal(sanitizeTempPathComponent("", "fallback"), "fallback");
		assert.equal(sanitizeTempPathComponent(".last-cleanup", "fallback"), "last-cleanup");
		assert.equal(sanitizeTempPathComponent("2026-01-01_session-1", "fallback"), "2026-01-01_session-1");
	});

	it("distinguishes sessions and reuses one directory per session id", () => {
		assert.notEqual(resolveSessionTempDirPath("a"), resolveSessionTempDirPath("b"));
		assert.equal(resolveSessionTempDirPath("a"), resolveSessionTempDirPath("a"));
	});

	it("falls back to a process-scoped directory when no session id is known", () => {
		const dir = resolveSessionTempDirPath();
		assert.ok(isInside(getTempRootDir(), dir));
		assert.ok(dir.endsWith(`pid-${process.pid}`));
	});

	it("uses the active session id for writers without a session handle", () => {
		setActiveSessionTempId("live-session");
		assert.equal(resolveSessionTempDirPath(), resolveSessionTempDirPath("live-session"));
	});

	it("creates the directory lazily with owner-only permissions", () => {
		const dir = getSessionTempDir("mode-check");
		const stat = statSync(dir);
		assert.ok(stat.isDirectory());
		if (isPosix) {
			assert.equal(stat.mode & 0o777, SESSION_TEMP_DIR_MODE);
			assert.equal(statSync(getTempRootDir()).mode & 0o777, SESSION_TEMP_DIR_MODE);
		}
	});

	it("recreates a memoized directory that was removed out of band", () => {
		const dir = getSessionTempDir("reaped");
		writeFileSync(join(dir, "spill.log"), "before");
		rmSync(dir, { recursive: true, force: true });
		assert.equal(existsSync(dir), false);

		const again = getSessionTempDir("reaped");

		assert.equal(again, dir);
		assert.equal(statSync(dir).isDirectory(), true, "a cache hit must not hand back a deleted directory");
		if (isPosix) {
			assert.equal(statSync(dir).mode & 0o777, SESSION_TEMP_DIR_MODE, "the mode is reapplied on recreation");
		}
		writeFileSync(join(dir, "spill.log"), "after");
	});

	it.skipIf(!isPosix)("refuses a symlink squatting on a session directory path", () => {
		const outside = join(sandbox, "outside-target");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "keep.txt"), "keep");

		const dir = resolveSessionTempDirPath("symlinked");
		mkdirSync(getTempRootDir(), { recursive: true });
		symlinkSync(outside, dir, "dir");

		const created = getSessionTempDir("symlinked");

		assert.equal(created, dir);
		assert.equal(lstatSync(dir).isSymbolicLink(), false, "the link must be replaced by a real directory");
		assert.equal(statSync(dir).isDirectory(), true);
		assert.equal(existsSync(join(outside, "keep.txt")), true, "the link target is left untouched");
		assert.equal(existsSync(join(dir, "keep.txt")), false, "writes no longer reach the link target");
	});

	it.skipIf(!isPosix)("refuses a symlinked owner root instead of writing through it", () => {
		const outside = join(sandbox, "attacker-target");
		mkdirSync(outside, { recursive: true });
		const root = getTempRootDir();
		rmSync(root, { recursive: true, force: true });
		symlinkSync(outside, root, "dir");

		assert.throws(() => getSessionTempDir("through-root-link"), TempDirRefusedError);

		assert.equal(lstatSync(root).isSymbolicLink(), true, "the planted link is left alone");
		assert.equal(existsSync(join(outside, "through-root-link")), false, "no session directory outside the tree");
		assert.deepEqual(readdirSync(outside), [], "nothing at all is written through the link");

		rmSync(root, { force: true });
	});

	it.skipIf(!isPosix)("tightens a same-owner root that was left world-accessible", () => {
		const root = getTempRootDir();
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true });
		chmodSync(root, 0o777);

		const dir = getSessionTempDir("loose-root");

		assert.equal(statSync(root).mode & 0o777, SESSION_TEMP_DIR_MODE, "the root is tightened before use");
		assert.equal(statSync(dir).mode & 0o777, SESSION_TEMP_DIR_MODE);
	});

	it.skipIf(!isPosix)("refuses a symlinked intermediate component below the root", () => {
		const outside = join(sandbox, "attacker-nested");
		mkdirSync(outside, { recursive: true });
		const root = getTempRootDir();
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true, mode: SESSION_TEMP_DIR_MODE });
		const nestedParent = join(root, "linked-parent");
		symlinkSync(outside, nestedParent, "dir");

		assert.throws(() => ensureTempDir(join(nestedParent, "leaf")), TempDirRefusedError);

		assert.equal(lstatSync(nestedParent).isSymbolicLink(), true);
		assert.equal(existsSync(join(outside, "leaf")), false);
	});

	it.skipIf(!isPosix)("never lets a memoized session path bypass owner-root validation", () => {
		const sessionId = "memoized-root-link";
		const sessionDir = getSessionTempDir(sessionId);
		const root = getTempRootDir();
		const outside = join(sandbox, "memoized-attacker-target");
		rmSync(root, { recursive: true, force: true });
		mkdirSync(join(outside, sessionId), { recursive: true, mode: SESSION_TEMP_DIR_MODE });
		symlinkSync(outside, root, "dir");

		try {
			assert.equal(lstatSync(sessionDir).isDirectory(), true, "the cached leaf exists through the planted link");
			assert.throws(() => getSessionTempDir(sessionId), TempDirRefusedError);
			assert.equal(lstatSync(root).isSymbolicLink(), true);
			assert.deepEqual(readdirSync(join(outside, sessionId)), []);
		} finally {
			rmSync(root, { force: true });
		}
	});

	it.skipIf(!isPosix)("preserves the literal tmpdir spelling while refusing an owner-root symlink", () => {
		const packageRoot = dirname(moduleDir(import.meta.url));
		const scriptPath = join(sandbox, "lexical-tmpdir.ts");
		writeFileSync(
			scriptPath,
			`
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-lexical-tmp-"));
const actual = path.join(sandbox, "actual");
const alias = path.join(sandbox, "alias");
const outside = path.join(sandbox, "outside");
fs.mkdirSync(actual, { mode: 0o700 });
fs.mkdirSync(outside, { mode: 0o700 });
fs.symlinkSync(actual, alias, "dir");
for (const key of ["TMPDIR", "TEMP", "TMP"]) process.env[key] = alias;

const temp = await import(${JSON.stringify(join(dirname(moduleDir(import.meta.url)), "src/core/tools/session-temp-dir.ts"))});
temp.resetSessionTempDirStateForTesting();
const session = temp.resolveSessionTempDirPath("sample");
const expected = path.join(os.tmpdir(), "atomic-" + process.getuid(), "sample");
const root = temp.getTempRootDir();
fs.symlinkSync(outside, root, "dir");
let errorName;
try {
	temp.getSessionTempDir("through-root-link");
} catch (error) {
	errorName = error?.name;
}
const result = {
	session,
	expected,
	equal: session === expected,
	errorName,
	rootIsLink: fs.lstatSync(root).isSymbolicLink(),
	outsideEntries: fs.readdirSync(outside),
};
fs.rmSync(sandbox, { recursive: true, force: true });
process.stdout.write(JSON.stringify(result));
`,
		);

		const child = spawnSyncCollect([bunExecutable(), scriptPath], { cwd: packageRoot });
		assert.equal(child.exitCode, 0, child.stderr.toString());
		const result = JSON.parse(child.stdout.toString()) as {
			session: string;
			expected: string;
			equal: boolean;
			errorName?: string;
			rootIsLink: boolean;
			outsideEntries: string[];
		};
		assert.equal(result.equal, true, `${result.session} !== ${result.expected}`);
		assert.equal(result.errorName, "TempDirRefusedError");
		assert.equal(result.rootIsLink, true);
		assert.deepEqual(result.outsideEntries, []);
	});
});

describe("persisted tool-output files", () => {
	it("creates spill files owner-only", async () => {
		const dir = getSessionTempDir("file-mode");
		const file = new PersistedOutputFile(join(dir, "spill.log"));
		file.write("hello");
		await file.close();
		if (isPosix) {
			assert.equal(statSync(file.path).mode & 0o777, SESSION_TEMP_FILE_MODE);
		}
	});

	it("routes an in-memory session's oversized tool result into the session temp tree", async () => {
		const sessionId = "in-memory-session";
		const replacement = await redirectOversizedToolResult({
			toolName: "bash",
			toolCallId: "call-1",
			result: { content: [{ type: "text", text: "x".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1) }], details: {} },
			isError: false,
			sessionId,
		});
		assert.ok(replacement, "expected the oversized result to be persisted");
		const match = replacement.content[0]?.text.match(/Full output saved to: (.+)\n/);
		assert.ok(match, "expected a 'Full output saved to:' path");
		const savedPath = match[1]!;
		const expectedDir = join(resolveSessionTempDirPath(sessionId), TOOL_RESULTS_SUBDIR);
		assert.ok(isInside(expectedDir, savedPath), `${savedPath} is not inside ${expectedDir}`);
		if (isPosix) {
			assert.equal(statSync(savedPath).mode & 0o777, SESSION_TEMP_FILE_MODE);
			assert.equal(statSync(expectedDir).mode & 0o777, SESSION_TEMP_DIR_MODE);
		}
	});

	it("keeps disk-backed sessions writing under the session directory", async () => {
		const sessionDir = join(sandbox, "disk-session");
		const replacement = await redirectOversizedToolResult({
			toolName: "bash",
			toolCallId: "call-2",
			result: { content: [{ type: "text", text: "y".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1) }], details: {} },
			isError: false,
			sessionId: "disk-backed",
			sessionDir,
		});
		assert.ok(replacement);
		const savedPath = replacement.content[0]?.text.match(/Full output saved to: (.+)\n/)?.[1];
		assert.ok(savedPath);
		assert.ok(isInside(join(sessionDir, TOOL_RESULTS_SUBDIR), savedPath));
	});
});
