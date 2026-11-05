import assert from "node:assert/strict";
import { spawnSync as runProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import type { SpawnSyncReturns } from "child_process";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_OFFLINE, VERSION } from "../src/config.ts";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";

type GitErrors = typeof import("../src/utils/git-errors.ts");

type ToolsManager = typeof import("../src/utils/tools-manager.ts");
type ProbeAnswer = { readonly status: number; readonly stdout: string };

const mocks = vi.hoisted(() => ({
	arch: vi.fn<typeof import("node:os").arch>(),
	platform: vi.fn<typeof import("node:os").platform>(),
	probes: new Map<string, ProbeAnswer>(),
	spawnSyncCommands: [] as string[],
	spawnSyncOptions: [] as { command: string; options: { timeout?: number; env?: NodeJS.ProcessEnv } }[],
	readdirSync: vi.fn(),
	rmSync: vi.fn(),
	renameSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(),
	osRelease: undefined as import("../src/utils/git-install-command.ts").OsRelease | undefined,
	osReleaseReads: 0,
	lock: undefined as
		| ((
				actual: typeof import("proper-lockfile"),
				file: string,
				options: import("proper-lockfile").LockOptions,
		  ) => Promise<() => Promise<void>>)
		| undefined,
	writeFile: vi.fn(),
	actualFs: undefined as typeof import("fs") | undefined,
}));

vi.mock("os", async () => {
	const actual = await vi.importActual<typeof import("os")>("os");
	return { ...actual, arch: mocks.arch, platform: mocks.platform };
});

vi.mock("child_process", async () => {
	const actual = await vi.importActual<typeof import("child_process")>("child_process");
	const spawnSync = (command: string, args: readonly string[], options: object): SpawnSyncReturns<string> => {
		mocks.spawnSyncCommands.push(command);
		mocks.spawnSyncOptions.push({ command, options });
		const probe = mocks.probes.get(command);
		if (probe !== undefined && args[0] === "--version")
			return { pid: 1, output: [], stdout: probe.stdout, stderr: "", status: probe.status, signal: null };
		return actual.spawnSync(command, [...args], options) as SpawnSyncReturns<string>;
	};
	return { ...actual, spawnSync };
});

vi.mock("../src/utils/git-install-command.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/git-install-command.ts")>()),
	readOsRelease: () => {
		mocks.osReleaseReads += 1;
		return mocks.osRelease;
	},
}));

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
	mocks.writeFile.mockImplementation(actual.writeFile);
	return { ...actual, writeFile: mocks.writeFile };
});

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs");
	mocks.actualFs = actual;
	return {
		...actual,
		existsSync: mocks.existsSync,
		readdirSync: mocks.readdirSync,
		rmSync: mocks.rmSync,
		renameSync: mocks.renameSync,
		writeFileSync: mocks.writeFileSync,
	};
});

vi.mock("proper-lockfile", async () => {
	const actual = await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile");
	const real = (actual as typeof actual & { default?: typeof actual }).default ?? actual;
	const lock = (file: string, options: import("proper-lockfile").LockOptions) =>
		mocks.lock === undefined ? real.lock(file, options) : mocks.lock(real, file, options);
	return { ...real, lock, default: { ...real, lock } };
});

const isWindows = process.platform === "win32";
function hostTag(): string {
	const pidNamespace = existsSync("/proc/self/ns/pid") ? readlinkSync("/proc/self/ns/pid") : "";
	return createHash("sha256").update(`${hostname()}\0${pidNamespace}`).digest("hex").slice(0, 8);
}
/** Node timers may fire up to a millisecond before `Date.now()` shows the full delay. */
const TIMER_EARLY_FIRE_TOLERANCE_MS = 2;
const ORIGINAL_PATH = process.env.PATH ?? "";
const HELPER_TOOLS = ["tar", "gzip", "sleep", "rm", "dirname", "touch"] as const;

function helperToolsDir(): string {
	const dir = join(tempDir, "helper-tools");
	mkdirSync(dir, { recursive: true });
	if (isWindows) return dir;
	for (const tool of HELPER_TOOLS) {
		const located = runProcess("sh", ["-c", `command -v ${tool}`], {
			encoding: "utf-8",
			env: { PATH: ORIGINAL_PATH },
		});
		const target = String(located.stdout).trim();
		if (target.startsWith("/") && !existsSync(join(dir, tool))) symlinkSync(target, join(dir, tool));
	}
	return dir;
}
const executableName = isWindows ? "git.exe" : "git";

let tempDir: string;
let agentDir: string;
let installDir: string;
let tools: ToolsManager;
let GitProvisionConfigError: GitErrors["GitProvisionConfigError"];
let GitProvisionTimeoutError: GitErrors["GitProvisionTimeoutError"];
let GitUnavailableError: GitErrors["GitUnavailableError"];
let isGitProvisionError: GitErrors["isGitProvisionError"];
let isGitUnavailableError: GitErrors["isGitUnavailableError"];
let rehydrateGitProvisionError: GitErrors["rehydrateGitProvisionError"];

function makeSystemGit(version: string | undefined, status = 0): string {
	const dir = mkdtempSync(join(tempDir, "system-"));
	const path = join(dir, executableName);
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, 0o755);
	mocks.probes.set(path, { status, stdout: version === undefined ? "not git\n" : `git version ${version}\n` });
	return path;
}

function usePath(...dirs: string[]): void {
	vi.stubEnv("PATH", dirs.join(delimiter));
}

function provisionedExecutable(root = installDir): string {
	return isWindows ? join(root, "cmd", "git.exe") : join(root, "bin", "git");
}

/** Record that the install under test is the pinned release, as a finished install does. */
function markCurrentInstall(): void {
	const marker = tools.getGitReleaseMarker();
	if (marker !== undefined) writeFileSync(join(installDir, ".atomic-git-release.json"), JSON.stringify(marker));
}

function makeProvisionedGit(version = "2.56.0"): string {
	const executable = provisionedExecutable();
	mkdirSync(join(executable, ".."), { recursive: true });
	writeFileSync(executable, "#!/bin/sh\nexit 0\n");
	chmodSync(executable, 0o755);
	mocks.probes.set(executable, { status: 0, stdout: `git version ${version}\n` });
	markCurrentInstall();
	return executable;
}

interface FakeRelease {
	readonly bytes: Buffer;
	readonly release: import("../src/utils/tools-manager.ts").GitRelease;
}

function archiveOf(populate: (root: string) => void): Buffer {
	const source = mkdtempSync(join(tempDir, "archive-src-"));
	populate(source);
	const archive = join(tempDir, `archive-${Math.random().toString(36).slice(2)}.tar.gz`);
	const result = runProcess("tar", ["czf", archive, "-C", source, "."], {
		env: { ...process.env, PATH: ORIGINAL_PATH },
	});
	assert.equal(result.status, 0, String(result.stderr));
	return readFileSync(archive);
}

function gitScript(body: string): (root: string) => void {
	return (root) => {
		for (const dir of ["bin", "libexec/git-core", "share/git-core/templates", "etc", "ssl"])
			mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(join(root, "bin", "git"), `#!/bin/sh\n[ "$1" = "--version" ] || exit 64\n${body}\n`);
		chmodSync(join(root, "bin", "git"), 0o755);
		writeFileSync(join(root, "etc", "gitconfig"), "");
		writeFileSync(join(root, "ssl", "cacert.pem"), "");
	};
}

function releaseFor(
	bytes: Buffer,
	sha256 = createHash("sha256").update(bytes).digest("hex"),
	tag = "v0.0.0-test",
): FakeRelease {
	const asset = { name: "fake-git.tar.gz", sha256 };
	return {
		bytes,
		release: {
			repo: "example/fake-git",
			tag,
			version: "2.56.0",
			assets: {
				"darwin-x64": asset,
				"darwin-arm64": asset,
				"linux-x64": asset,
				"linux-arm64": asset,
				"linux-arm": asset,
				"win32-x64": asset,
				"win32-arm64": asset,
				"win32-ia32": asset,
			},
		},
	};
}

function serveArchive(bytes: Buffer) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		if (
			/^https:\/\/github\.com\/example\/fake-git\/releases\/download\/[^/]+\/fake-git\.tar\.gz$/.test(String(input))
		)
			return new Response(new Uint8Array(bytes));
		return new Response("unexpected", { status: 404 });
	});
}

function leftovers(): string[] {
	const binDir = join(agentDir, "bin");
	return existsSync(binDir) ? readdirSync(binDir).filter((name) => name !== "git") : [];
}

beforeEach(async () => {
	tempDir = mkdtempSync(join(tmpdir(), "atomic-git-provision-"));
	agentDir = join(tempDir, "agent");
	installDir = join(agentDir, "bin", "git");
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv(ENV_OFFLINE, "");
	vi.stubEnv("PI_OFFLINE", "");
	vi.stubEnv("GIT_SSL_CAINFO", undefined);
	vi.stubEnv("GIT_CONFIG_SYSTEM", undefined);
	vi.stubEnv("GIT_EXEC_PATH", undefined);
	usePath(helperToolsDir());
	mocks.arch.mockReset();
	mocks.arch.mockReturnValue(process.arch);
	mocks.platform.mockReset();
	mocks.platform.mockReturnValue(process.platform);
	mocks.probes.clear();
	mocks.spawnSyncCommands.length = 0;
	vi.resetModules();
	tools = await import("../src/utils/tools-manager.ts");
	({
		GitProvisionConfigError,
		GitProvisionTimeoutError,
		GitUnavailableError,
		isGitProvisionError,
		isGitUnavailableError,
		rehydrateGitProvisionError,
	} = await import("../src/utils/git-errors.ts"));
	const actualFs = mocks.actualFs ?? (await vi.importActual<typeof import("fs")>("fs"));
	mocks.readdirSync.mockReset();
	mocks.readdirSync.mockImplementation(actualFs.readdirSync);
	mocks.rmSync.mockReset();
	mocks.rmSync.mockImplementation(actualFs.rmSync);
	mocks.renameSync.mockReset();
	mocks.renameSync.mockImplementation(actualFs.renameSync);
	mocks.osRelease = undefined;
	mocks.osReleaseReads = 0;
	mocks.writeFileSync.mockReset();
	mocks.writeFileSync.mockImplementation(actualFs.writeFileSync);
	mocks.existsSync.mockReset();
	mocks.existsSync.mockImplementation(actualFs.existsSync);
	mocks.spawnSyncOptions.length = 0;
	mocks.lock = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("git target mapping (#4322)", () => {
	it.each([
		["darwin", "x64", "darwin-x64", "dugite-native-v2.56.0-a44aeca-macOS-x64.tar.gz"],
		["darwin", "arm64", "darwin-arm64", "dugite-native-v2.56.0-a44aeca-macOS-arm64.tar.gz"],
		["linux", "x64", "linux-x64", "dugite-native-v2.56.0-a44aeca-ubuntu-x64.tar.gz"],
		["linux", "arm64", "linux-arm64", "dugite-native-v2.56.0-a44aeca-ubuntu-arm64.tar.gz"],
		["linux", "arm", "linux-arm", "dugite-native-v2.56.0-a44aeca-ubuntu-arm.tar.gz"],
		["win32", "x64", "win32-x64", "dugite-native-v2.56.0-a44aeca-windows-x64.tar.gz"],
		["win32", "arm64", "win32-arm64", "dugite-native-v2.56.0-a44aeca-windows-arm64.tar.gz"],
		["win32", "ia32", "win32-ia32", "dugite-native-v2.56.0-a44aeca-windows-x86.tar.gz"],
	])("maps %s/%s to the pinned %s asset", (plat, architecture, key, asset) => {
		const resolution = tools.getGitDistributionTarget(plat, architecture, { family: "glibc", version: "2.39" });
		assert.ok(resolution.supported);
		assert.equal(resolution.target.key, key);
		assert.equal(resolution.target.asset, asset);
		assert.equal(
			resolution.target.url,
			`https://github.com/desktop/dugite-native/releases/download/v2.56.0-2/${asset}`,
		);
		assert.match(resolution.target.sha256, /^[0-9a-f]{64}$/);
	});

	it("pins every SHA-256 in source", () => {
		assert.deepEqual(
			Object.fromEntries(Object.entries(tools.GIT_RELEASE.assets).map(([key, asset]) => [key, asset.sha256])),
			{
				"darwin-x64": "52cc663281e1ec2f1d76ba781193ca4847e62dbbf767f6c99ec9ec5b978a7659",
				"darwin-arm64": "1110de343de11cc6f469b782b60f36217b9199b5e06875dd65baa26dd60563c7",
				"linux-x64": "1efd8ce0516b670b6b6d0f49ecaf395ceb8cf7fff3f5857259763d97a1238df9",
				"linux-arm64": "d5ce120515bf3013a014e6a918aa87ec0f7a6f5f9687c48d50127e637cb9b6c2",
				"linux-arm": "7a14edae189f791e64f8d037c8e3830acd648cd1ad891db40c8d6469d33b36cd",
				"win32-x64": "f1e17876337d7be143e5d51976da36643d65528125cfbc14d57f171de0fd5f14",
				"win32-arm64": "1834e7817589f25f97ae0f309ef4733578a6b8dbd438ed29f898d075e6ead4c2",
				"win32-ia32": "ef98c4e84c916e95ee1b3c894240f37db264b06265999e841a6eb54822899da4",
			},
		);
		assert.equal(tools.GIT_RELEASE.tag, "v2.56.0-2");
	});

	it.each([
		["linux", "x64", { family: "musl" }, { reason: "musl", libc: "musl", installCommand: "apk add git" }],
		["linux", "riscv64", { family: "musl" }, { reason: "musl", libc: "musl", installCommand: "apk add git" }],
		["linux", "x64", { family: "glibc", version: "2.31" }, { reason: "glibc-too-old", libc: "glibc 2.31" }],
		["linux", "arm64", { family: "glibc", version: "2.4" }, { reason: "glibc-too-old", libc: "glibc 2.4" }],
		["linux", "ia32", { family: "glibc" }, { reason: "architecture" }],
		["linux", "ppc64", { family: "glibc", version: "2.39" }, { reason: "architecture" }],
		["darwin", "ia32", undefined, { reason: "architecture", installCommand: "xcode-select --install" }],
		[
			"win32",
			"arm",
			undefined,
			{ reason: "architecture", installCommand: "winget install --id Git.Git -e --source winget" },
		],
		["android", "arm64", undefined, { reason: "platform", installCommand: "pkg install git" }],
		["freebsd", "x64", undefined, { reason: "platform", installCommand: "pkg install git" }],
		["openbsd", "x64", undefined, { reason: "platform", installCommand: "pkg_add git" }],
		["aix", "ppc64", undefined, { reason: "platform" }],
		["sunos", "x64", undefined, { reason: "platform", installCommand: "pkg install developer/versioning/git" }],
	] as const)("refuses %s/%s (%o) without falling back to another build", (plat, architecture, libc, expected) => {
		const resolution = tools.getGitDistributionTarget(plat, architecture, libc);
		assert.equal(resolution.supported, false);
		assert.deepEqual(resolution.supported ? undefined : resolution.fields, {
			code: "unsupported-platform",
			platform: plat,
			arch: architecture,
			...expected,
		});
	});

	it.each(["2.34", "2.35", "3.0"])("accepts glibc %s", (version) => {
		assert.ok(tools.getGitDistributionTarget("linux", "x64", { family: "glibc", version }).supported);
	});

	it.each([
		["git version 2.39.5 (Apple Git-154)", "2.39.5"],
		["git version 2.45.1.windows.1", "2.45.1"],
		["git version 2.30", "2.30.0"],
		["  git version 2.56.0\n", "2.56.0"],
		["version 2.30.0", undefined],
		["fatal: not a git version", undefined],
		["", undefined],
	])("parses %j as %s", (output, expected) => {
		assert.equal(tools.parseGitVersion(output), expected);
	});
});

describe("git resolution (#4322)", () => {
	it("prefers a system git at the minimum over the provisioned copy, without networking", async () => {
		const systemGit = makeSystemGit("2.30.0");
		makeProvisionedGit();
		usePath(join(systemGit, ".."));
		const fetchMock = vi.spyOn(globalThis, "fetch");

		const git = await tools.resolveGit();

		assert.equal(git.source, "system");
		assert.equal(git.path, systemGit);
		assert.equal(git.version, "2.30.0");
		assert.equal(git.env.GIT_EXEC_PATH, undefined);
		assert.deepEqual(await tools.getToolEnv("git"), {});
		assert.equal(await tools.getToolPath("git"), systemGit);
		assert.equal(fetchMock.mock.calls.length, 0);
	});

	it.each([
		["below the minimum", "2.29.9", 0, { problem: "below-minimum", version: "2.29.9" }],
		["failing its probe", "2.40.0", 1, { problem: "probe-failed" }],
		["printing no version", undefined, 0, { problem: "probe-failed" }],
	] as const)("uses the provisioned copy over a system git %s", async (_label, version, status, rejected) => {
		const systemGit = makeSystemGit(version, status);
		const executable = makeProvisionedGit();
		usePath(join(systemGit, ".."));

		const git = await tools.resolveGit();

		assert.equal(git.source, "provisioned");
		assert.equal(git.path, executable);
		assert.equal(git.version, "2.56.0");
		vi.stubEnv(ENV_OFFLINE, "1");
		rmSync(installDir, { recursive: true });
		const error = await tools.resolveGit().then(
			() => undefined,
			(caught: Error) => caught,
		);
		assert.ok(isGitUnavailableError(error));
		assert.deepEqual(error.fields.systemGit, { path: systemGit, ...rejected });
	});

	it("returns the portable environment for a provisioned git and keeps caller CA and config", async () => {
		const executable = makeProvisionedGit();
		const git = await tools.resolveGit();
		const layoutRoot = installDir;
		const expected: Record<string, string> = isWindows
			? {
					GIT_EXEC_PATH: join(
						layoutRoot,
						process.arch === "arm64" ? "clangarm64" : process.arch === "ia32" ? "mingw32" : "ucrt64",
						"libexec",
						"git-core",
					),
					GIT_TEMPLATE_DIR: join(
						layoutRoot,
						process.arch === "arm64" ? "clangarm64" : process.arch === "ia32" ? "mingw32" : "ucrt64",
						"share",
						"git-core",
						"templates",
					),
					GIT_SSL_CAINFO: join(
						layoutRoot,
						process.arch === "arm64" ? "clangarm64" : process.arch === "ia32" ? "mingw32" : "ucrt64",
						"etc",
						"ssl",
						"certs",
						"ca-bundle.crt",
					),
				}
			: {
					GIT_EXEC_PATH: join(layoutRoot, "libexec", "git-core"),
					GIT_TEMPLATE_DIR: join(layoutRoot, "share", "git-core", "templates"),
					GIT_CONFIG_SYSTEM: join(layoutRoot, "etc", "gitconfig"),
					...(process.platform === "linux" ? { GIT_SSL_CAINFO: join(layoutRoot, "ssl", "cacert.pem") } : {}),
				};
		assert.equal(git.path, executable);
		assert.deepEqual(await tools.getToolEnv("git"), expected);
		for (const [key, value] of Object.entries(expected)) assert.equal(git.env[key], value);
		assert.deepEqual(Object.keys(git.env).sort(), Object.keys({ ...process.env, ...expected }).sort());

		vi.stubEnv("GIT_SSL_CAINFO", "/etc/corp-ca.pem");
		vi.stubEnv("GIT_CONFIG_SYSTEM", "/etc/corp-gitconfig");
		const env = await tools.getToolEnv("git");
		assert.equal(env.GIT_SSL_CAINFO, undefined);
		assert.equal(env.GIT_CONFIG_SYSTEM, undefined);
		assert.equal((await tools.resolveGit()).env.GIT_SSL_CAINFO, "/etc/corp-ca.pem");
		assert.deepEqual(await tools.getToolEnv("fd"), {});
	});

	it("does not mistake Atomic's own portable git on PATH for a system git", async () => {
		const executable = makeProvisionedGit();
		usePath(join(executable, ".."));
		const git = await tools.resolveGit();
		assert.equal(git.source, "provisioned");
		assert.equal(tools.getGitShellEnvironment(process.env)?.pathEntry, join(executable, ".."));
	});

	it("rejects with an offline GitUnavailableError before any download or extra probe", async () => {
		vi.stubEnv(ENV_OFFLINE, "1");
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const error = await tools.resolveGit().catch((caught: Error) => caught);
		assert.ok(error instanceof GitUnavailableError);
		assert.equal(error.code, "offline");
		assert.deepEqual(error.fields, {
			code: "offline",
			offlineVariable: "ATOMIC_OFFLINE",
			platform: process.platform,
			arch: process.arch,
		});
		assert.equal(
			error.hint,
			"Unset ATOMIC_OFFLINE so Atomic can download a portable git, or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
		);
		assert.equal(fetchMock.mock.calls.length, 0);
		assert.equal(mocks.spawnSyncCommands.length, 0);
		assert.equal(existsSync(join(agentDir, "bin")), false);
	});

	it("still resolves an installed portable git offline", async () => {
		vi.stubEnv(ENV_OFFLINE, "1");
		const executable = makeProvisionedGit();
		assert.equal((await tools.resolveGit()).path, executable);
		assert.equal(tools.resolveGitSync().path, executable);
	});

	it("fails fast on Alpine with the apk install command and downloads nothing", async () => {
		mocks.platform.mockReturnValue("linux");
		mocks.arch.mockReturnValue("x64");
		vi.spyOn(process.report, "getReport").mockReturnValue({ header: {} });
		mocks.readdirSync.mockImplementation((path: string) =>
			path === "/lib" ? ["ld-musl-x86_64.so.1", "libc.musl-x86_64.so.1"] : [],
		);
		const fetchMock = vi.spyOn(globalThis, "fetch");

		const error = await tools.resolveGit().catch((caught: Error) => caught);

		assert.ok(isGitUnavailableError(error));
		assert.equal(error.code, "unsupported-platform");
		assert.deepEqual(error.fields, {
			code: "unsupported-platform",
			reason: "musl",
			platform: "linux",
			arch: "x64",
			libc: "musl",
			installCommand: "apk add git",
		});
		assert.equal(error.hint, "Install git 2.30.0 or newer with `apk add git`.");
		assert.equal(fetchMock.mock.calls.length, 0);
		assert.equal(mocks.spawnSyncCommands.length, 0);
		assert.throws(
			() => tools.resolveGitSync(),
			(thrown: Error) => isGitUnavailableError(thrown) && thrown.code === "unsupported-platform",
		);
	});

	it("uses a system git on Alpine", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.spyOn(process.report, "getReport").mockReturnValue({ header: {} });
		mocks.readdirSync.mockImplementation((path: string) => (path === "/lib" ? ["ld-musl-x86_64.so.1"] : []));
		const systemGit = makeSystemGit("2.47.1");
		usePath(join(systemGit, ".."));
		assert.equal((await tools.resolveGit()).path, systemGit);
	});

	it("detects glibc from the runtime report before looking for a musl loader", () => {
		vi.spyOn(process.report, "getReport").mockReturnValue({ header: { glibcVersionRuntime: "2.36" } });
		mocks.readdirSync.mockImplementation(() => ["ld-musl-x86_64.so.1"]);
		assert.deepEqual(tools.detectLinuxLibc(), { family: "glibc", version: "2.36" });
	});

	it("assumes glibc when neither the report nor a musl loader says otherwise", () => {
		vi.spyOn(process.report, "getReport").mockReturnValue({ header: {} });
		mocks.readdirSync.mockImplementation(() => ["ld-linux-x86-64.so.2"]);
		assert.deepEqual(tools.detectLinuxLibc(), { family: "glibc" });
		mocks.readdirSync.mockImplementation(() => ["ld-musl-aarch64.so.1"]);
		assert.deepEqual(tools.detectLinuxLibc(), { family: "glibc" });
	});

	it("rejects a too-old glibc before downloading", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.spyOn(process.report, "getReport").mockReturnValue({ header: { glibcVersionRuntime: "2.31" } });
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const error = await tools.resolveGit().catch((caught: Error) => caught);
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.code, "unsupported-platform");
		assert.equal(error.fields.code === "unsupported-platform" ? error.fields.reason : undefined, "glibc-too-old");
		assert.equal(fetchMock.mock.calls.length, 0);
	});

	it("reports a missing install synchronously and never downloads from resolveGitSync", () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		assert.throws(
			() => tools.resolveGitSync(),
			(error: Error) =>
				error instanceof GitUnavailableError &&
				error.code === "not-installed" &&
				error.fields.code === "not-installed" &&
				error.fields.installDir === installDir,
		);
		assert.equal(fetchMock.mock.calls.length, 0);
		assert.deepEqual(tools.getGitStatus(), {
			source: "unavailable",
			error: new GitUnavailableError({
				code: "not-installed",
				installDir,
				platform: process.platform,
				arch: process.arch,
			}).toJSON(),
		});
	});

	it("reports git in the status surface", () => {
		const systemGit = makeSystemGit("2.43.0");
		usePath(join(systemGit, ".."));
		assert.deepEqual(tools.getGitStatus(), { source: "system", version: "2.43.0", path: systemGit });
		usePath(join(tempDir, "none"));
		const executable = makeProvisionedGit("2.56.0");
		assert.deepEqual(tools.getGitStatus(), { source: "provisioned", version: "2.56.0", path: executable });
	});

	it("caches the system probe per PATH", () => {
		const systemGit = makeSystemGit("2.43.0");
		usePath(join(systemGit, ".."));
		tools.resolveGitSync();
		tools.resolveGitSync();
		tools.getGitStatus();
		assert.equal(mocks.spawnSyncCommands.filter((command) => command === systemGit).length, 1);
	});

	it.each([
		[null, "options", "an options object"],
		[{ signal: "stop" }, "signal", "an AbortSignal"],
		[{ onStatus: "log" }, "onStatus", "a function"],
	])("validates options %o before any probe", async (options, field, expected) => {
		const error = await tools
			.resolveGit(options as unknown as import("../src/utils/tools-manager.ts").ResolveGitOptions)
			.catch((caught: Error) => caught);
		assert.ok(error instanceof GitProvisionConfigError);
		assert.equal(error.code, "invalid-option");
		assert.deepEqual(error.fields, { source: "sdk", field, expected });
		assert.equal(mocks.spawnSyncCommands.length, 0);
	});

	it("propagates an already-aborted signal's reason without probing", async () => {
		const reason = new Error("caller stopped");
		const controller = new AbortController();
		controller.abort(reason);
		await assert.rejects(tools.resolveGit({ signal: controller.signal }), (error) => error === reason);
		assert.equal(mocks.spawnSyncCommands.length, 0);
	});
});

describe("git download verification (#4322)", () => {
	it("rejects a checksum mismatch with nothing installed", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("not the archive"));
		const target = tools.getGitDistributionTarget(process.platform, process.arch, {
			family: "glibc",
			version: "2.39",
		});
		assert.ok(target.supported);

		const error = await tools.resolveGit().catch((caught: Error) => caught);

		assert.ok(error instanceof GitUnavailableError);
		assert.equal(error.code, "checksum-mismatch");
		assert.deepEqual(error.fields, {
			code: "checksum-mismatch",
			asset: target.target.asset,
			url: target.target.url,
			expectedSha256: target.target.sha256,
			actualSha256: createHash("sha256").update("not the archive").digest("hex"),
			platform: process.platform,
			arch: process.arch,
		});
		assert.equal(error.platform, process.platform);
		assert.equal(error.retryable, false);
		assert.equal(fetchMock.mock.calls.length, 1);
		assert.equal(existsSync(installDir), false);
		assert.deepEqual(leftovers(), []);
		assert.equal(
			tools.resolveGitSync.bind(tools) &&
				(() => {
					try {
						tools.resolveGitSync();
						return undefined;
					} catch (thrown) {
						return thrown;
					}
				})(),
			error,
		);
	});

	it.each([
		[404, false],
		[503, true],
	])("reports HTTP %s as a typed download failure (retryable=%s)", async (status, retryable) => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("no", { status }));
		const error = await tools.resolveGit().catch((caught: Error) => caught);
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.code, "download-failed");
		assert.equal(error.fields.code === "download-failed" ? error.fields.httpStatus : undefined, status);
		assert.equal(error.retryable, retryable);
		assert.deepEqual(leftovers(), []);
	});

	it("wraps a transport failure with its cause", async () => {
		const transport = new TypeError("fetch failed");
		vi.spyOn(globalThis, "fetch").mockRejectedValue(transport);
		const error = await tools.resolveGit().catch((caught: Error) => caught);
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.code, "download-failed");
		assert.equal(error.cause, transport);
		assert.equal(error.retryable, true);
	});

	it("keeps the checksum error when removing the staging directory fails", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("not the archive"));
		const cleanup = new Error("EBUSY: staging in use");
		const actualRm = mocks.actualFs!.rmSync;
		mocks.rmSync.mockImplementation((path: string, options: object) => {
			if (String(path).includes(".git-staging-")) throw cleanup;
			return actualRm(path, options);
		});
		const error = await tools.resolveGit().catch((caught: Error) => caught);
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.code, "checksum-mismatch");
		assert.equal(error.cleanupCause, cleanup);
	});
});

describe.skipIf(isWindows)("git installation (#4322)", () => {
	it("installs a verified distribution under getBinDir()/git and reuses it offline", async () => {
		const fake = releaseFor(archiveOf(gitScript('echo "git version 2.56.0"')));
		const fetchMock = serveArchive(fake.bytes);
		const statuses: import("../src/utils/tools-manager.ts").ToolStatus[] = [];

		const git = await tools.withGitProvisionSettingsForTest({ release: fake.release }, () =>
			tools.resolveGit({ onStatus: (status) => statuses.push(status) }),
		);

		assert.equal(git.source, "provisioned");
		assert.equal(git.path, join(installDir, "bin", "git"));
		assert.equal(git.version, "2.56.0");
		assert.equal(git.env.GIT_EXEC_PATH, join(installDir, "libexec", "git-core"));
		assert.deepEqual(statuses, [
			{ type: "info", message: "git not found. Downloading portable git 2.56.0..." },
			{ type: "info", message: `git 2.56.0 installed to ${installDir}` },
		]);
		assert.equal(fetchMock.mock.calls.length, 1);
		assert.deepEqual(leftovers(), []);

		vi.stubEnv(ENV_OFFLINE, "1");
		vi.resetModules();
		const fresh: ToolsManager = await import("../src/utils/tools-manager.ts");
		assert.equal((await fresh.resolveGit()).path, git.path);
		assert.equal(fetchMock.mock.calls.length, 1);
	});

	it("shares one download between concurrent callers and survives one of them cancelling", async () => {
		const fake = releaseFor(archiveOf(gitScript('echo "git version 2.56.0"')));
		const fetchMock = serveArchive(fake.bytes);
		const cancelled = new AbortController();
		const reason = new Error("first caller left");
		const [first, second] = await tools.withGitProvisionSettingsForTest({ release: fake.release }, () => {
			const firstCall = tools.resolveGit({ signal: cancelled.signal }).catch((error: Error) => error);
			const secondCall = tools.resolveGit();
			cancelled.abort(reason);
			return Promise.all([firstCall, secondCall]);
		});
		assert.equal(first, reason);
		assert.ok(!(second instanceof Error));
		assert.equal(second.source, "provisioned");
		assert.equal(fetchMock.mock.calls.length, 1);
	});

	it("cancels the download when every caller cancels, installing nothing", async () => {
		const fake = releaseFor(archiveOf(gitScript('echo "git version 2.56.0"')));
		vi.spyOn(globalThis, "fetch").mockImplementation(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		const controller = new AbortController();
		const reason = new Error("user pressed escape");
		const pending = tools.withGitProvisionSettingsForTest({ release: fake.release }, () =>
			tools.resolveGit({ signal: controller.signal }),
		);
		await vi.waitFor(() => assert.ok(leftovers().some((name) => name.startsWith(".git-staging-"))));
		controller.abort(reason);
		await assert.rejects(pending, (error) => error === reason);
		await vi.waitFor(() => assert.deepEqual(leftovers(), []));
		assert.equal(existsSync(installDir), false);
		assert.throws(
			() => tools.resolveGitSync(),
			(error: Error) => isGitUnavailableError(error) && error.code === "not-installed",
		);
	});

	it("times out a stalled download with a typed timeout", async () => {
		const fake = releaseFor(archiveOf(gitScript('echo "git version 2.56.0"')));
		vi.spyOn(globalThis, "fetch").mockImplementation(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		const error = await tools
			.withGitProvisionSettingsForTest({ release: fake.release, downloadTimeoutMs: 50 }, () => tools.resolveGit())
			.catch((caught: Error) => caught);
		assert.ok(error instanceof GitProvisionTimeoutError);
		assert.equal(error.fields.phase, "download");
		assert.equal(error.fields.timeoutMs, 50);
		assert.ok(error.fields.elapsedMs >= 50 - TIMER_EARLY_FIRE_TOLERANCE_MS, String(error.fields.elapsedMs));
		assert.equal(error.retryable, true);
		assert.deepEqual(leftovers(), []);
	});

	it.each([
		["a corrupt archive", () => Buffer.from("not gzip"), "extract", /^tar exited with status \d+/],
		[
			"an archive without git",
			() => archiveOf((root) => mkdirSync(join(root, "share"))),
			"verify",
			/^bin\/git is missing from the archive$/,
		],
		[
			"a git that prints no version",
			() => archiveOf(gitScript('echo "hello"')),
			"verify",
			/^git --version printed no version$/,
		],
		[
			"a git that cannot run",
			() => archiveOf(gitScript("echo broken >&2; exit 3")),
			"verify",
			/^git exited with status 3: broken$/,
		],
	] as const)(
		"rejects %s as install-failed (%s) with nothing installed",
		async (_label, makeArchive, phase, detail) => {
			const fake = releaseFor(makeArchive());
			serveArchive(fake.bytes);
			const error = await tools
				.withGitProvisionSettingsForTest({ release: fake.release }, () => tools.resolveGit())
				.catch((caught: Error) => caught);
			assert.ok(isGitUnavailableError(error));
			assert.equal(error.code, "install-failed");
			assert.ok(error.fields.code === "install-failed");
			assert.equal(error.fields.phase, phase);
			assert.equal(error.fields.installDir, installDir);
			assert.match(error.fields.detail ?? "", detail);
			assert.equal(existsSync(installDir), false);
			assert.deepEqual(leftovers(), []);
		},
	);

	it("times out a hanging verification with a typed timeout", async () => {
		const fake = releaseFor(archiveOf(gitScript("sleep 30")));
		serveArchive(fake.bytes);
		const error = await tools
			.withGitProvisionSettingsForTest({ release: fake.release, verifyTimeoutMs: 200 }, () => tools.resolveGit())
			.catch((caught: Error) => caught);
		assert.ok(error instanceof GitProvisionTimeoutError);
		assert.deepEqual(
			{ phase: error.fields.phase, timeoutMs: error.fields.timeoutMs },
			{ phase: "verify", timeoutMs: 200 },
		);
		assert.equal(existsSync(installDir), false);
	});

	it("waits for another process's install lock and times out with a typed timeout", async () => {
		const fake = releaseFor(archiveOf(gitScript('echo "git version 2.56.0"')));
		const fetchMock = serveArchive(fake.bytes);
		const binDir = join(agentDir, "bin");
		mkdirSync(binDir, { recursive: true });
		const release = await lockfile.lock(binDir, { lockfilePath: join(binDir, "git.install.lock"), realpath: false });
		const statuses: string[] = [];
		try {
			const error = await tools
				.withGitProvisionSettingsForTest({ release: fake.release, lockWaitTimeoutMs: 300, lockPollMs: 20 }, () =>
					tools.resolveGit({ onStatus: (status) => statuses.push(`${status.type}: ${status.message}`) }),
				)
				.catch((caught: Error) => caught);
			assert.ok(error instanceof GitProvisionTimeoutError);
			assert.equal(error.fields.phase, "lock");
			assert.equal(error.fields.timeoutMs, 300);
			assert.equal(fetchMock.mock.calls.length, 0);
			assert.deepEqual(statuses, ["info: Another Atomic process is installing git. Waiting for it to finish..."]);
		} finally {
			await release();
		}
	});

	it("uses the install another process finishes while it waits for the lock", async () => {
		const fake = releaseFor(archiveOf(gitScript('echo "git version 2.56.0"')));
		const fetchMock = serveArchive(fake.bytes);
		const binDir = join(agentDir, "bin");
		mkdirSync(binDir, { recursive: true });
		const release = await lockfile.lock(binDir, { lockfilePath: join(binDir, "git.install.lock"), realpath: false });
		const pending = tools.withGitProvisionSettingsForTest({ release: fake.release, lockPollMs: 20 }, () =>
			tools.resolveGit(),
		);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
		const executable = makeProvisionedGit("2.56.0");
		const git = await pending;
		await release();
		assert.equal(git.path, executable);
		assert.equal(fetchMock.mock.calls.length, 0);
	});

	it("ignores a lock stamped in the future by a skewed clock", async () => {
		const fake = releaseFor(archiveOf(gitScript('echo "git version 2.56.0"')));
		serveArchive(fake.bytes);
		const lockPath = join(agentDir, "bin", "git.install.lock");
		mkdirSync(lockPath, { recursive: true });
		const future = new Date(Date.now() + 3_600_000);
		utimesSync(lockPath, future, future);
		const git = await tools.withGitProvisionSettingsForTest(
			{ release: fake.release, lockPollMs: 20, lockStaleMs: 200 },
			() => tools.resolveGit(),
		);
		assert.equal(git.source, "provisioned");
		assert.equal(existsSync(lockPath), false);
	});

	it("keeps a healthy install another process published first and replaces a broken one", async () => {
		const fake = releaseFor(archiveOf(gitScript('echo "git version 2.56.0"')));
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			makeProvisionedGit("2.55.0");
			return new Response(new Uint8Array(fake.bytes));
		});
		const winner = await tools.withGitProvisionSettingsForTest({ release: fake.release }, () => tools.resolveGit());
		assert.equal(winner.version, "2.55.0");
		assert.deepEqual(leftovers(), []);

		rmSync(installDir, { recursive: true });
		vi.resetModules();
		const fresh: ToolsManager = await import("../src/utils/tools-manager.ts");
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			mkdirSync(join(installDir, "broken-leftover"), { recursive: true });
			return new Response(new Uint8Array(fake.bytes));
		});
		const replaced = await fresh.withGitProvisionSettingsForTest({ release: fake.release }, () => fresh.resolveGit());
		assert.equal(replaced.version, "2.56.0");
		assert.ok(existsSync(join(installDir, "bin", "git")));
		assert.equal(existsSync(join(installDir, "broken-leftover")), false);
	});

	it("reports a full disk as install-failed with nothing installed", async () => {
		const fake = releaseFor(archiveOf(gitScript('echo "git version 2.56.0"')));
		serveArchive(fake.bytes);
		const diskFull = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
		mocks.writeFile.mockRejectedValueOnce(diskFull);
		const error = await tools
			.withGitProvisionSettingsForTest({ release: fake.release }, () => tools.resolveGit())
			.catch((caught: Error) => caught);
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.code, "install-failed");
		assert.equal(error.fields.code === "install-failed" ? error.fields.phase : undefined, "stage");
		assert.equal(error.cause, diskFull);
		assert.equal(existsSync(installDir), false);
		assert.deepEqual(leftovers(), []);
	});

	it("removes staging left by exited installers and keeps a live installer's, whatever its timestamps", async () => {
		const fake = releaseFor(archiveOf(gitScript('echo "git version 2.56.0"')));
		serveArchive(fake.bytes);
		const binDir = join(agentDir, "bin");
		const exitedPid = runProcess(process.execPath, ["-e", ""]).pid;
		const abandoned = join(binDir, `.git-staging-${hostTag()}-${exitedPid}-abandoned`);
		const live = join(binDir, `.git-staging-${hostTag()}-${process.pid}-live`);
		const foreign = join(binDir, ".git-staging-unowned");
		const otherHost = join(
			binDir,
			`.git-staging-${hostTag() === "00000000" ? "11111111" : "00000000"}-${exitedPid}-x`,
		);
		for (const dir of [abandoned, live, foreign, otherHost]) mkdirSync(dir, { recursive: true });
		const skewedPast = new Date(Date.now() - 48 * 3_600_000);
		utimesSync(live, skewedPast, skewedPast);
		await tools.withGitProvisionSettingsForTest({ release: fake.release }, () => tools.resolveGit());
		assert.equal(existsSync(abandoned), false);
		assert.equal(existsSync(live), true);
		assert.equal(existsSync(foreign), true);
		assert.equal(existsSync(otherHost), true);
	});

	it("never publishes a staged tree that lost archive entries after extraction", async () => {
		const fake = releaseFor(
			archiveOf((root) => {
				gitScript('rm -f "$(dirname "$0")/../share/git-core/templates/marker"; echo "git version 2.56.0"')(root);
				writeFileSync(join(root, "share", "git-core", "templates", "marker"), "x");
			}),
		);
		serveArchive(fake.bytes);
		const error = await tools
			.withGitProvisionSettingsForTest({ release: fake.release }, () => tools.resolveGit())
			.catch((caught: Error) => caught);
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.code, "install-failed");
		assert.deepEqual(error.fields.code === "install-failed" ? [error.fields.phase, error.fields.detail] : [], [
			"verify",
			"1 archive entries are missing from the staged tree, including ./share/git-core/templates/marker",
		]);
		assert.equal(existsSync(installDir), false);
		assert.deepEqual(leftovers(), []);
	});

	it("records a failed provisioning as the reason resolveGitSync and ensureTool report", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("no", { status: 404 }));
		const statuses: import("../src/utils/tools-manager.ts").ToolStatus[] = [];
		assert.equal(await tools.ensureTool("git", (status) => statuses.push(status)), undefined);
		const reported = statuses.at(-1);
		assert.equal(reported?.type, "warning");
		let thrown: Error | undefined;
		try {
			tools.resolveGitSync();
		} catch (error) {
			thrown = error as Error;
		}
		assert.ok(isGitUnavailableError(thrown));
		assert.equal(thrown.code, "download-failed");
		assert.equal(reported?.message, thrown.message);
		const status = tools.getGitStatus();
		assert.equal(status.source, "unavailable");
		assert.equal(status.source === "unavailable" ? status.error.code : undefined, "download-failed");
	});
});

describe("agent shell PATH (#4322)", () => {
	it("adds the provisioned git only when no git is on PATH", () => {
		const executable = makeProvisionedGit();
		const shell = tools.getGitShellEnvironment(process.env);
		assert.equal(shell?.pathEntry, join(executable, ".."));
		assert.equal(
			shell?.env.GIT_EXEC_PATH,
			isWindows ? shell?.env.GIT_EXEC_PATH : join(installDir, "libexec", "git-core"),
		);

		const oldSystemGit = makeSystemGit("2.20.0");
		usePath(join(oldSystemGit, ".."));
		assert.equal(tools.getGitShellEnvironment(process.env), undefined);
	});

	it("adds nothing when no portable git is installed", () => {
		assert.equal(tools.getGitShellEnvironment(process.env), undefined);
	});

	it("ensureTool resolves git like resolveGit", async () => {
		const systemGit = makeSystemGit("2.43.0");
		usePath(join(systemGit, ".."));
		assert.equal(await tools.ensureTool("git"), systemGit);
		assert.ok(!isGitProvisionError(undefined));
		expect(mocks.spawnSyncCommands).toContain(systemGit);
	});
});

function writeGit(dir: string, name: string, mode: number, version: string | undefined): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, mode);
	if (version !== undefined) mocks.probes.set(path, { status: 0, stdout: `git version ${version}\n` });
	return path;
}

function caught(run: () => unknown): Error | undefined {
	try {
		run();
		return undefined;
	} catch (error) {
		return error as Error;
	}
}

describe("git resolution details (#4322)", () => {
	it("pins the portable git version", () => {
		assert.equal(tools.GIT_RELEASE.version, "2.56.0");
	});

	it.each([
		["warning: git version 2.40.0", undefined],
		["git version 10.1.2", "10.1.2"],
		["git version 2.30.10", "2.30.10"],
	])("parses %j as %s", (output, expected) => {
		assert.equal(tools.parseGitVersion(output), expected);
	});

	it.each([
		[{ "/lib": ["libc.so.6"], "/usr/lib": ["ld-musl-aarch64.so.1"] }, "musl"],
		[{ "/lib": ["ld-musl-x86_64.so.1", "libc.so"], "/usr/lib": ["libz.so"] }, "musl"],
		[{ "/lib": ["libc.so.6"], "/usr/lib": ["libz.so"] }, "glibc"],
	] as const)("finds a musl loader in %o", (listing, family) => {
		vi.spyOn(process.report, "getReport").mockReturnValue({ header: {} });
		mocks.readdirSync.mockImplementation((path: string) => listing[path as keyof typeof listing] ?? []);
		assert.equal(tools.detectLinuxLibc().family, family);
	});

	it.each([[{}], [undefined]])("tolerates a runtime report of %o", (report) => {
		vi.spyOn(process.report, "getReport").mockReturnValue(report as object);
		mocks.readdirSync.mockImplementation(() => []);
		assert.deepEqual(tools.detectLinuxLibc(), { family: "glibc" });
	});

	it("detects libc only on Linux", async () => {
		mocks.platform.mockReturnValue("darwin");
		mocks.arch.mockReturnValue("arm64");
		vi.stubEnv(ENV_OFFLINE, "1");
		const report = vi.spyOn(process.report, "getReport").mockReturnValue({ header: {} });
		mocks.readdirSync.mockImplementation(() => ["ld-musl-aarch64.so.1"]);
		const error = await tools.resolveGit().catch((caughtError: Error) => caughtError);
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.code, "offline");
		assert.equal(report.mock.calls.length, 0);
	});

	it("gives macOS its system config and native certificate trust", async () => {
		mocks.platform.mockReturnValue("darwin");
		writeGit(join(installDir, "bin"), "git", 0o755, "2.56.0");
		markCurrentInstall();
		assert.deepEqual(await tools.getToolEnv("git"), {
			GIT_EXEC_PATH: join(installDir, "libexec", "git-core"),
			GIT_TEMPLATE_DIR: join(installDir, "share", "git-core", "templates"),
			GIT_CONFIG_SYSTEM: join(installDir, "etc", "gitconfig"),
		});
	});

	it.each([
		["x64", "ucrt64"],
		["arm64", "clangarm64"],
		["ia32", "mingw32"],
	])("lays out the Windows %s distribution under %s", async (architecture, subfolder) => {
		mocks.platform.mockReturnValue("win32");
		mocks.arch.mockReturnValue(architecture);
		writeGit(join(installDir, "cmd"), "git.exe", 0o644, "2.56.0");
		markCurrentInstall();
		assert.deepEqual(await tools.getToolEnv("git"), {
			GIT_EXEC_PATH: join(installDir, subfolder, "libexec", "git-core"),
			GIT_TEMPLATE_DIR: join(installDir, subfolder, "share", "git-core", "templates"),
			GIT_SSL_CAINFO: join(installDir, subfolder, "etc", "ssl", "certs", "ca-bundle.crt"),
		});
		assert.equal(tools.getGitShellEnvironment({ Path: join(tempDir, "none") })?.pathEntry, join(installDir, "cmd"));
	});

	it("finds git.exe on a Windows PATH without an executable bit", async () => {
		mocks.platform.mockReturnValue("win32");
		const systemGit = writeGit(join(tempDir, "win-system"), "git.exe", 0o644, "2.45.1");
		writeGit(join(tempDir, "win-system"), "git", 0o755, "2.46.0");
		usePath(join(tempDir, "win-system"));
		const git = await tools.resolveGit();
		assert.equal(git.path, systemGit);
		assert.equal(git.version, "2.45.1");
	});

	it("ignores a git on PATH that is not executable", async () => {
		writeGit(join(tempDir, "not-exec"), "git", 0o644, "2.45.1");
		usePath(join(tempDir, "not-exec"));
		const error = caught(() => tools.resolveGitSync());
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.fields.systemGit, undefined);
	});

	it.skipIf(isWindows)("skips Atomic's own directory on PATH but not its parent", async () => {
		writeGit(installDir, "git", 0o755, "2.44.0");
		usePath(installDir);
		assert.equal(caught(() => tools.resolveGitSync())?.name, "GitUnavailableError");
		rmSync(installDir, { recursive: true });
		const parentGit = writeGit(join(agentDir, "bin"), "git", 0o755, "2.44.0");
		usePath(join(agentDir, "bin"));
		assert.equal(tools.resolveGitSync().path, parentGit);
	});

	it("never runs a git from an empty or relative PATH entry", () => {
		const untrusted = writeGit(join(tempDir, "untrusted-repo"), executableName, 0o755, "2.99.0");
		const trusted = writeGit(join(tempDir, "trusted-bin"), executableName, 0o755, "2.40.0");
		usePath("", relative(process.cwd(), join(untrusted, "..")), join(trusted, ".."));
		assert.equal(tools.resolveGitSync().path, trusted);
		assert.equal(mocks.spawnSyncCommands.includes(untrusted), false);
	});

	it("reads PATH case-insensitively and treats a missing PATH as empty", () => {
		makeProvisionedGit();
		const systemGit = makeSystemGit("2.43.0");
		assert.equal(tools.getGitShellEnvironment({ Path: join(systemGit, "..") }), undefined);
		assert.equal(tools.getGitShellEnvironment({})?.pathEntry, join(provisionedExecutable(), ".."));
	});

	it("probes git with a bounded timeout and an environment free of repository bindings", () => {
		vi.stubEnv("GIT_DIR", "/elsewhere.git");
		const executable = makeProvisionedGit();
		tools.resolveGitSync();
		const probe = mocks.spawnSyncOptions.find((call) => call.command === executable);
		assert.equal(probe?.options.timeout, 10_000);
		assert.equal(probe?.options.env?.AI_AGENT, "atomic");
		assert.equal(probe?.options.env?.GIT_DIR, undefined);
		assert.equal(
			probe?.options.env?.GIT_EXEC_PATH,
			isWindows ? probe?.options.env?.GIT_EXEC_PATH : join(installDir, "libexec", "git-core"),
		);
	});

	it("caches the provisioned probe and invalidates it when the executable disappears", () => {
		const executable = makeProvisionedGit("2.56.0");
		assert.equal(tools.resolveGitSync().version, "2.56.0");
		assert.equal(tools.resolveGitSync().version, "2.56.0");
		assert.equal(mocks.spawnSyncCommands.filter((command) => command === executable).length, 1);
		rmSync(executable);
		assert.equal(caught(() => tools.resolveGitSync())?.name, "GitUnavailableError");
		makeProvisionedGit("2.57.0");
		assert.equal(tools.resolveGitSync().version, "2.57.0");
	});

	it("rejects a non-object options value", async () => {
		const error = await tools
			.resolveGit("fast" as unknown as import("../src/utils/tools-manager.ts").ResolveGitOptions)
			.catch((caughtError: Error) => caughtError);
		assert.ok(error instanceof GitProvisionConfigError);
		assert.equal(error.fields.field, "options");
	});

	it("lets unexpected resolution failures escape ensureTool and the status surface", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.spyOn(process.report, "getReport").mockReturnValue({ header: {} });
		const bug = new TypeError("directory listing failed");
		mocks.readdirSync.mockImplementation(() => {
			throw bug;
		});
		await assert.rejects(tools.ensureTool("git"), (error) => error === bug);
		vi.resetModules();
		const fresh: ToolsManager = await import("../src/utils/tools-manager.ts");
		assert.throws(
			() => fresh.getGitStatus(),
			(error) => error === bug,
		);
	});

	it("reports an unavailable git from ensureTool without a status sink", async () => {
		vi.stubEnv(ENV_OFFLINE, "1");
		assert.equal(await tools.ensureTool("git"), undefined);
	});

	it("keeps settings overrides scoped to their callback", async () => {
		const fake = releaseFor(Buffer.from("fake archive"));
		vi.stubEnv(ENV_OFFLINE, "1");
		await tools.withGitProvisionSettingsForTest({ release: fake.release }, async () => undefined);
		vi.stubEnv(ENV_OFFLINE, "");
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("fake archive"));
		const error = await tools.resolveGit().catch((caughtError: Error) => caughtError);
		assert.ok(isGitUnavailableError(error));
		assert.equal(
			error.fields.code === "checksum-mismatch" ? error.fields.expectedSha256 : undefined,
			tools.GIT_RELEASE.assets[
				`${process.platform}-${process.arch}` as import("../src/utils/tools-manager.ts").GitTargetKey
			]?.sha256,
		);
	});
});

describe.skipIf(isWindows)("git installation details (#4322)", () => {
	const healthy = () => releaseFor(archiveOf(gitScript('echo "git version 2.56.0"')));
	const provision = (overrides: Parameters<ToolsManager["withGitProvisionSettingsForTest"]>[0], options = {}) =>
		tools.withGitProvisionSettingsForTest(overrides, () => tools.resolveGit(options));
	const failure = (promise: Promise<unknown>) =>
		promise.then(
			() => undefined,
			(error: Error) => error,
		);

	it("identifies itself and never probes the git it just verified", async () => {
		const fake = healthy();
		const fetchMock = serveArchive(fake.bytes);
		const git = await provision({ release: fake.release });
		const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
		assert.equal(headers["User-Agent"], getPiUserAgent(VERSION));
		tools.resolveGitSync();
		assert.equal(mocks.spawnSyncCommands.filter((command) => command === git.path).length, 0);
	});

	it.each([
		["below the minimum", "2.29.9", 0, (path: string) => `git 2.29.9 at ${path} is older than 2.30.0.`],
		["failing its probe", "2.40.0", 1, (path: string) => `git at ${path} did not report a usable version.`],
	] as const)("explains a system git %s before downloading", async (_label, version, status, explain) => {
		const systemGit = makeSystemGit(version, status);
		usePath(join(systemGit, ".."), helperToolsDir());
		const fake = healthy();
		serveArchive(fake.bytes);
		const statuses: string[] = [];
		await provision(
			{ release: fake.release },
			{ onStatus: (entry: { message: string }) => statuses.push(entry.message) },
		);
		assert.equal(statuses[0], `${explain(systemGit)} Downloading portable git 2.56.0...`);
	});

	it("retries a failed download on the next call", async () => {
		const fake = healthy();
		let attempts = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			attempts += 1;
			return attempts === 1 ? new Response("gone", { status: 404 }) : new Response(new Uint8Array(fake.bytes));
		});
		const first = await failure(provision({ release: fake.release }));
		assert.equal((first as InstanceType<GitErrors["GitUnavailableError"]>).code, "download-failed");
		assert.equal((await provision({ release: fake.release })).source, "provisioned");
	});

	it("streams one download's progress to every concurrent caller", async () => {
		const fake = healthy();
		const fetchMock = serveArchive(fake.bytes);
		const first: string[] = [];
		const second: string[] = [];
		await tools.withGitProvisionSettingsForTest({ release: fake.release }, () =>
			Promise.all([
				tools.resolveGit({ onStatus: (status) => first.push(status.message) }),
				tools.resolveGit({ onStatus: (status) => second.push(status.message) }),
			]),
		);
		assert.deepEqual(first, [
			"git not found. Downloading portable git 2.56.0...",
			`git 2.56.0 installed to ${installDir}`,
		]);
		assert.deepEqual(second, first);
		assert.equal(fetchMock.mock.calls.length, 1);
	});

	it("stops reporting to a caller that cancelled while the others continue", async () => {
		const fake = healthy();
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
			return new Response(new Uint8Array(fake.bytes));
		});
		const controller = new AbortController();
		const cancelled: string[] = [];
		const reason = new Error("left early");
		await tools.withGitProvisionSettingsForTest({ release: fake.release }, async () => {
			const leaving = tools.resolveGit({
				signal: controller.signal,
				onStatus: (status) => cancelled.push(status.message),
			});
			const staying = tools.resolveGit();
			controller.abort(reason);
			await assert.rejects(leaving, (error) => error === reason);
			await staying;
		});
		assert.deepEqual(cancelled, []);
	});

	it("cancels while waiting for another installer's lock", async () => {
		const fake = healthy();
		serveArchive(fake.bytes);
		const binDir = join(agentDir, "bin");
		mkdirSync(binDir, { recursive: true });
		const release = await lockfile.lock(binDir, { lockfilePath: join(binDir, "git.install.lock"), realpath: false });
		try {
			const controller = new AbortController();
			const reason = new Error("stop waiting");
			const pending = provision({ release: fake.release, lockPollMs: 5_000 }, { signal: controller.signal });
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
			const startedAt = Date.now();
			controller.abort(reason);
			await assert.rejects(pending, (error) => error === reason);
			assert.ok(Date.now() - startedAt < 1_000);
		} finally {
			await release();
		}
	});

	it("reports a lock failure other than contention as install-failed", async () => {
		const fake = healthy();
		const fetchMock = serveArchive(fake.bytes);
		const denied = Object.assign(new Error("EACCES: permission denied, mkdir"), { code: "EACCES" });
		mocks.lock = async () => {
			throw denied;
		};
		const error = await failure(provision({ release: fake.release }));
		assert.ok(isGitUnavailableError(error));
		assert.deepEqual(error.fields.code === "install-failed" ? [error.fields.phase, error.fields.detail] : [], [
			"stage",
			"install lock",
		]);
		assert.equal(error.cause, denied);
		assert.equal(fetchMock.mock.calls.length, 0);
	});

	it("keeps waiting when a contended lock disappears before it can be inspected", async () => {
		const fake = healthy();
		mocks.lock = async () => {
			throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
		};
		const error = await failure(provision({ release: fake.release, lockWaitTimeoutMs: 100, lockPollMs: 10 }));
		assert.ok(error instanceof GitProvisionTimeoutError);
		assert.equal(error.fields.phase, "lock");
	});

	it("uses an install that finished just before it acquired the lock", async () => {
		const fake = healthy();
		const fetchMock = serveArchive(fake.bytes);
		mocks.lock = async (real, file, options) => {
			makeProvisionedGit("2.55.1");
			return real.lock(file, options);
		};
		assert.equal((await provision({ release: fake.release })).version, "2.55.1");
		assert.equal(fetchMock.mock.calls.length, 0);
	});

	it("warns once when releasing the lock fails after a successful install", async () => {
		const fake = healthy();
		serveArchive(fake.bytes);
		mocks.lock = async (real, file, options) => {
			const release = await real.lock(file, options);
			return async () => {
				await release();
				throw new Error("ENOENT: lock already gone");
			};
		};
		const statuses: { type: string; message: string }[] = [];
		await provision(
			{ release: fake.release },
			{ onStatus: (status: { type: string; message: string }) => statuses.push(status) },
		);
		assert.deepEqual(statuses.at(-1), {
			type: "warning",
			message: "Could not release the git install lock: Error: ENOENT: lock already gone",
		});
	});

	it("attaches a lock release failure to the primary error", async () => {
		const fake = healthy();
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("tampered"));
		const releaseFailure = new Error("EIO: release failed");
		mocks.lock = async (real, file, options) => {
			const release = await real.lock(file, options);
			return async () => {
				await release();
				throw releaseFailure;
			};
		};
		const error = await failure(provision({ release: fake.release }));
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.code, "checksum-mismatch");
		assert.equal(error.cleanupCause, releaseFailure);
	});

	it("finishes without releasing a lock another process took over", async () => {
		const fake = healthy();
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			rmSync(join(agentDir, "bin", "git.install.lock"), { recursive: true, force: true });
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
			return new Response(new Uint8Array(fake.bytes));
		});
		const statuses: string[] = [];
		const git = await provision(
			{ release: fake.release, lockUpdateMs: 1_000, lockStaleMs: 2_000 },
			{ onStatus: (status: { message: string }) => statuses.push(status.message) },
		);
		assert.equal(git.source, "provisioned");
		assert.ok(
			statuses.every((message) => !message.startsWith("Could not release")),
			statuses.join("\n"),
		);
	});

	it("reports an agent directory it cannot create as install-failed", async () => {
		writeFileSync(join(tempDir, "blocker"), "");
		vi.stubEnv(ENV_AGENT_DIR, join(tempDir, "blocker", "agent"));
		vi.resetModules();
		const fresh: ToolsManager = await import("../src/utils/tools-manager.ts");
		const fake = healthy();
		serveArchive(fake.bytes);
		const error = await failure(
			fresh.withGitProvisionSettingsForTest({ release: fake.release }, () => fresh.resolveGit()),
		);
		assert.ok(isGitProvisionError(error));
		const fields = (error as InstanceType<GitErrors["GitUnavailableError"]>).fields;
		assert.deepEqual(fields.code === "install-failed" ? [fields.phase, fields.detail] : [], ["stage", undefined]);
		assert.equal((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code, "ENOTDIR");
	});

	it("reports an unreadable install directory as install-failed", async () => {
		const fake = healthy();
		serveArchive(fake.bytes);
		const binDir = join(agentDir, "bin");
		const unreadable = Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
		const actualReaddir = mocks.actualFs!.readdirSync;
		mocks.readdirSync.mockImplementation((path: string, options?: object) => {
			if (path === binDir) throw unreadable;
			return actualReaddir(path, options as never);
		});
		const error = await failure(provision({ release: fake.release }));
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.fields.code === "install-failed" ? error.fields.phase : undefined, "stage");
		assert.equal(error.cause, unreadable);
	});

	it("reports an install-failed with exactly its documented fields and no cause when tar fails", async () => {
		const fake = releaseFor(Buffer.from("not gzip"));
		serveArchive(fake.bytes);
		const error = await failure(provision({ release: fake.release }));
		assert.ok(isGitUnavailableError(error));
		assert.equal("cause" in error, false);
		assert.deepEqual(Object.keys(error.fields).sort(), [
			"arch",
			"asset",
			"code",
			"detail",
			"installDir",
			"phase",
			"platform",
		]);
	});

	it("omits the detail field when a step has none", async () => {
		const fake = healthy();
		serveArchive(fake.bytes);
		mocks.writeFile.mockRejectedValueOnce(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));
		const error = await failure(provision({ release: fake.release }));
		assert.ok(isGitUnavailableError(error));
		assert.deepEqual(Object.keys(error.fields).sort(), ["arch", "asset", "code", "installDir", "phase", "platform"]);
	});

	it.each([
		["a git without stderr", "exit 3", "git exited with status 3"],
		[
			"a git whose stderr starts with blank lines",
			"printf '\\n  broken\\nsecond\\n' >&2; exit 3",
			"git exited with status 3: broken",
		],
	])("summarizes %s", async (_label, body, detail) => {
		const fake = releaseFor(archiveOf(gitScript(body)));
		serveArchive(fake.bytes);
		const error = await failure(provision({ release: fake.release }));
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.fields.code === "install-failed" ? error.fields.detail : undefined, detail);
	});

	it("names a spawn failure by its code", async () => {
		const fake = releaseFor(
			archiveOf((root) => {
				gitScript('echo "git version 2.56.0"')(root);
				chmodSync(join(root, "bin", "git"), 0o644);
			}),
		);
		serveArchive(fake.bytes);
		const error = await failure(provision({ release: fake.release }));
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.fields.code === "install-failed" ? error.fields.detail : undefined, "git EACCES");
	});

	it("reports an archive that cannot be listed for verification", async () => {
		const fake = releaseFor(
			archiveOf(gitScript('rm -f "$(dirname "$0")/../../fake-git.tar.gz"; echo "git version 2.56.0"')),
		);
		serveArchive(fake.bytes);
		const error = await failure(provision({ release: fake.release }));
		assert.ok(isGitUnavailableError(error));
		assert.ok(error.fields.code === "install-failed");
		assert.equal(error.fields.phase, "verify");
		assert.match(error.fields.detail ?? "", /^tar exited with status \d+/);
		assert.equal(existsSync(installDir), false);
	});

	it("cancels a running verification with the caller's reason", async () => {
		const marker = join(tempDir, "verifying");
		vi.stubEnv("GIT_TEST_MARKER", marker);
		const fake = releaseFor(archiveOf(gitScript('touch "$GIT_TEST_MARKER"; sleep 30')));
		serveArchive(fake.bytes);
		const controller = new AbortController();
		const reason = new Error("cancelled during verify");
		const pending = provision({ release: fake.release }, { signal: controller.signal });
		await vi.waitFor(() => assert.ok(existsSync(marker)), { timeout: 10_000 });
		const startedAt = Date.now();
		controller.abort(reason);
		await assert.rejects(pending, (error) => error === reason);
		assert.ok(Date.now() - startedAt < 5_000);
		assert.equal(existsSync(installDir), false);
		await vi.waitFor(() => assert.equal(existsSync(join(agentDir, "bin", "git.install.lock")), false));
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
		const status = tools.getGitStatus();
		assert.equal(status.source === "unavailable" ? status.error.code : undefined, "not-installed");
	});

	it("bounds extraction with a typed timeout", async () => {
		const fake = healthy();
		serveArchive(fake.bytes);
		const error = await failure(provision({ release: fake.release, extractTimeoutMs: 1 }));
		assert.ok(error instanceof GitProvisionTimeoutError);
		assert.equal(error.fields.phase, "extract");
		assert.ok(error.cause instanceof Error);
		assert.ok(error.fields.elapsedMs < 10_000);
	});

	it("bounds a stalled download with a typed timeout that keeps its cause", async () => {
		const fake = healthy();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		const error = await failure(provision({ release: fake.release, downloadTimeoutMs: 30 }));
		assert.ok(error instanceof GitProvisionTimeoutError);
		assert.ok(error.cause !== undefined);
		assert.ok(error.fields.elapsedMs < 10_000);
	});

	it("records no failure when every caller cancels", async () => {
		const fake = healthy();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		const controller = new AbortController();
		const pending = provision({ release: fake.release }, { signal: controller.signal });
		await vi.waitFor(() => assert.ok(leftovers().some((name) => name.startsWith(".git-staging-"))));
		controller.abort(new Error("bye"));
		await failure(pending);
		await vi.waitFor(() => assert.equal(existsSync(join(agentDir, "bin", "git.install.lock")), false));
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
		const status = tools.getGitStatus();
		assert.equal(status.source === "unavailable" ? status.error.code : undefined, "not-installed");
	});

	it("warns once when the staging directory cannot be removed after a successful install", async () => {
		const fake = healthy();
		serveArchive(fake.bytes);
		const busy = new Error("EBUSY: staging in use");
		const actualRm = mocks.actualFs!.rmSync;
		mocks.rmSync.mockImplementation((path: string, options: object) => {
			if (String(path).includes(".git-staging-")) throw busy;
			return actualRm(path, options);
		});
		const statuses: { type: string; message: string }[] = [];
		await provision(
			{ release: fake.release },
			{ onStatus: (status: { type: string; message: string }) => statuses.push(status) },
		);
		const warning = statuses.at(-1);
		assert.equal(warning?.type, "warning");
		assert.match(
			warning?.message ?? "",
			/^Could not remove the git staging directory .*\.git-staging-[0-9a-f]{8}-\d+-.*: Error: EBUSY: staging in use$/,
		);
	});

	it("reports a publish that fails before anything is in place", async () => {
		const fake = healthy();
		serveArchive(fake.bytes);
		const denied = Object.assign(new Error("EACCES: rename"), { code: "EACCES" });
		mocks.renameSync.mockImplementationOnce(() => {
			throw denied;
		});
		const error = await failure(provision({ release: fake.release }));
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.fields.code === "install-failed" ? error.fields.phase : undefined, "promote");
		assert.equal(error.cause, denied);
	});

	it("reports a failed replacement of a broken install", async () => {
		const fake = healthy();
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			mkdirSync(join(installDir, "broken"), { recursive: true });
			return new Response(new Uint8Array(fake.bytes));
		});
		const denied = Object.assign(new Error("EACCES: rename"), { code: "EACCES" });
		const actualRename = mocks.actualFs!.renameSync;
		let renames = 0;
		mocks.renameSync.mockImplementation((from: string, to: string) => {
			renames += 1;
			if (renames === 2) throw denied;
			return actualRename(from, to);
		});
		const error = await failure(provision({ release: fake.release }));
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.fields.code === "install-failed" ? error.fields.phase : undefined, "promote");
		assert.equal(error.cause, denied);
	});

	it("keeps a staging directory whose owner is alive but not ours, and one that only resembles staging", async () => {
		const fake = healthy();
		serveArchive(fake.bytes);
		const binDir = join(agentDir, "bin");
		const initOwned = join(binDir, `.git-staging-${hostTag()}-1-init`);
		const lookalike = join(binDir, `old.git-staging-${hostTag()}-${runProcess(process.execPath, ["-e", ""]).pid}-x`);
		for (const dir of [initOwned, lookalike]) mkdirSync(dir, { recursive: true });
		await provision({ release: fake.release });
		assert.equal(existsSync(initOwned), true);
		assert.equal(existsSync(lookalike), true);
	});

	it("uses the Windows tar on Windows", async () => {
		mocks.platform.mockReturnValue("win32");
		vi.stubEnv("SystemRoot", undefined);
		const fake = healthy();
		serveArchive(fake.bytes);
		const error = await failure(provision({ release: fake.release }));
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.fields.code === "install-failed" ? error.fields.detail : undefined, "tar.exe ENOENT");
	});

	it("reinstalls after the portable git was removed", async () => {
		const fake = healthy();
		const fetchMock = serveArchive(fake.bytes);
		await provision({ release: fake.release });
		rmSync(installDir, { recursive: true });
		const again = await provision({ release: fake.release });
		assert.ok(existsSync(again.path));
		assert.equal(fetchMock.mock.calls.length, 2);
	});

	it("keeps the first 200 characters of a failing step's first stderr line", async () => {
		const fake = releaseFor(archiveOf(gitScript(`echo ${"x".repeat(300)} >&2; exit 3`)));
		serveArchive(fake.bytes);
		const error = await failure(provision({ release: fake.release }));
		assert.ok(isGitUnavailableError(error));
		assert.equal(
			error.fields.code === "install-failed" ? error.fields.detail : undefined,
			`git exited with status 3: ${"x".repeat(200)}`,
		);
	});

	it("reports download progress through ensureTool", async () => {
		const fake = healthy();
		serveArchive(fake.bytes);
		const statuses: string[] = [];
		const path = await tools.withGitProvisionSettingsForTest({ release: fake.release }, () =>
			tools.ensureTool("git", (status) => statuses.push(status.message)),
		);
		assert.equal(path, join(installDir, "bin", "git"));
		assert.deepEqual(statuses, [
			"git not found. Downloading portable git 2.56.0...",
			`git 2.56.0 installed to ${installDir}`,
		]);
	});

	it("never takes over a lock whose holder keeps refreshing it, even with a clock far behind", async () => {
		const fake = healthy();
		const fetchMock = serveArchive(fake.bytes);
		const lockPath = join(agentDir, "bin", "git.install.lock");
		mkdirSync(lockPath, { recursive: true });
		let stamp = Date.now() - 6 * 3_600_000;
		const refresh = setInterval(() => {
			stamp += 50;
			utimesSync(lockPath, new Date(stamp), new Date(stamp));
		}, 50);
		try {
			const pending = provision({ release: fake.release, lockPollMs: 20, lockStaleMs: 300 });
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
			assert.equal(fetchMock.mock.calls.length, 0);
			assert.equal(existsSync(lockPath), true);
			clearInterval(refresh);
			assert.equal((await pending).source, "provisioned");
			assert.equal(fetchMock.mock.calls.length, 1);
		} finally {
			clearInterval(refresh);
		}
	});

	it("tags staging by host alone where the PID namespace is not visible", async () => {
		const fake = healthy();
		serveArchive(fake.bytes);
		const actualExists = mocks.actualFs!.existsSync;
		mocks.existsSync.mockImplementation((path: string) => path !== "/proc/self/ns/pid" && actualExists(path));
		const hostOnlyTag = createHash("sha256").update(`${hostname()}\0`).digest("hex").slice(0, 8);
		const abandoned = join(
			agentDir,
			"bin",
			`.git-staging-${hostOnlyTag}-${runProcess(process.execPath, ["-e", ""]).pid}-x`,
		);
		mkdirSync(abandoned, { recursive: true });
		await provision({ release: fake.release });
		assert.equal(actualExists(abandoned), false);
	});
});

describe("git install command on this machine (#4322)", () => {
	const ubuntu = (versionId: string) => ({ id: "ubuntu", idLike: ["debian"], versionId });

	it("names the distribution's command in an offline error, reading os-release once and fetching nothing", async () => {
		mocks.osRelease = ubuntu("24.04");
		vi.stubEnv(ENV_OFFLINE, "1");
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const error = await tools.resolveGit().catch((caught: Error) => caught);
		assert.ok(isGitUnavailableError(error));
		assert.equal(
			error.fields.installCommand,
			process.platform === "linux" ? "apt-get install git" : error.fields.installCommand,
		);
		if (process.platform === "linux") assert.ok(error.hint.endsWith("with `apt-get install git`."), error.hint);
		assert.equal(fetchMock.mock.calls.length, 0);
		assert.equal(mocks.osReleaseReads, process.platform === "linux" ? 2 : 0);
	});

	it("names the command in a too-old-glibc error on an old Ubuntu", async () => {
		mocks.platform.mockReturnValue("linux");
		mocks.osRelease = ubuntu("20.04");
		vi.spyOn(process.report, "getReport").mockReturnValue({ header: { glibcVersionRuntime: "2.31" } });
		const error = await tools.resolveGit().catch((caught: Error) => caught);
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.fields.installCommand, "add-apt-repository ppa:git-core/ppa && apt update && apt install git");
		assert.ok(error.hint.startsWith("Install git 2.30.0 or newer with `add-apt-repository"));
	});

	it("names apk on Alpine whether or not os-release was readable", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.spyOn(process.report, "getReport").mockReturnValue({ header: {} });
		mocks.readdirSync.mockImplementation((path: string) => (path === "/lib" ? ["ld-musl-x86_64.so.1"] : []));
		for (const osRelease of [undefined, { id: "alpine", idLike: [] }]) {
			mocks.osRelease = osRelease;
			vi.resetModules();
			const fresh: ToolsManager = await import("../src/utils/tools-manager.ts");
			const error = fresh.getGitStatus();
			assert.equal(error.source, "unavailable");
			assert.equal(error.source === "unavailable" ? error.error.fields.installCommand : undefined, "apk add git");
		}
	});

	it("carries the command on checksum, download and install failures", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.spyOn(process.report, "getReport").mockReturnValue({ header: { glibcVersionRuntime: "2.39" } });
		mocks.osRelease = { id: "fedora", idLike: [] };
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("tampered"));
		const error = await tools.resolveGit().catch((caught: Error) => caught);
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.code, "checksum-mismatch");
		assert.equal(error.fields.installCommand, "dnf install git");
		assert.ok(error.hint.endsWith("with `dnf install git`."));
	});

	describe.skipIf(isWindows)("a pin bump reaches existing installs", () => {
		const provision = (overrides: Parameters<ToolsManager["withGitProvisionSettingsForTest"]>[0], options = {}) =>
			tools.withGitProvisionSettingsForTest(overrides, () => tools.resolveGit(options));
		const bytes = () => archiveOf(gitScript('echo "git version 2.56.0"'));
		const markerPath = () => join(installDir, ".atomic-git-release.json");
		const readMarker = () => JSON.parse(readFileSync(markerPath(), "utf-8"));
		const marked = (fake: FakeRelease) => ({
			tag: fake.release.tag,
			asset: "fake-git.tar.gz",
			sha256: fake.release.assets["linux-x64"].sha256,
		});

		async function installAs(fake: FakeRelease) {
			return provision({ release: fake.release });
		}

		it("records the release it installed from, and installs it again only when the pin changes", async () => {
			const first = releaseFor(bytes(), undefined, "v2.56.0-2");
			const fetchMock = serveArchive(first.bytes);
			await installAs(first);
			assert.deepEqual(readMarker(), { ...marked(first), sha256: readMarker().sha256 });
			assert.equal(readMarker().tag, "v2.56.0-2");
			assert.equal(fetchMock.mock.calls.length, 1);

			await installAs(first);
			assert.equal(fetchMock.mock.calls.length, 1);

			const rebuild = releaseFor(first.bytes, undefined, "v2.56.0-3");
			await installAs(rebuild);
			assert.equal(fetchMock.mock.calls.length, 2);
			assert.equal(readMarker().tag, "v2.56.0-3");
			await installAs(rebuild);
			assert.equal(fetchMock.mock.calls.length, 2);
			assert.deepEqual(leftovers(), []);
		});

		it("keeps using the older install offline, and from resolveGitSync, without a request", async () => {
			const first = releaseFor(bytes(), undefined, "v2.56.0-2");
			const fetchMock = serveArchive(first.bytes);
			await installAs(first);
			const newer = releaseFor(first.bytes, undefined, "v2.56.0-3");
			fetchMock.mockClear();
			vi.stubEnv(ENV_OFFLINE, "1");
			const git = await provision({ release: newer.release });
			assert.equal(git.source, "provisioned");
			assert.equal(tools.resolveGitSync().path, git.path);
			assert.equal(fetchMock.mock.calls.length, 0);
			assert.equal(readMarker().tag, "v2.56.0-2");
		});

		it("keeps the working install and warns once when the newer release cannot be downloaded", async () => {
			const first = releaseFor(bytes(), undefined, "v2.56.0-2");
			serveArchive(first.bytes);
			await installAs(first);
			const newer = releaseFor(first.bytes, undefined, "v2.56.0-3");
			vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("gone", { status: 404 }));
			const statuses: { type: string; message: string }[] = [];
			const git = await tools.withGitProvisionSettingsForTest({ release: newer.release }, () =>
				tools.resolveGit({ onStatus: (status) => statuses.push(status) }),
			);
			assert.equal(git.source, "provisioned");
			assert.equal(readMarker().tag, "v2.56.0-2");
			assert.equal(statuses.filter((status) => status.type === "warning").length, 1);
			assert.match(
				statuses.find((status) => status.type === "warning")?.message ?? "",
				/^Could not update the portable git to 2\.56\.0; using git 2\.56\.0\. Git is unavailable: .* could not be downloaded \(HTTP 404\) \(download-failed\)/,
			);
		});

		it.each([
			["a missing marker", () => rmSync(markerPath())],
			["a corrupt marker", () => writeFileSync(markerPath(), "{not json")],
			[
				"a marker of another asset",
				() => writeFileSync(markerPath(), JSON.stringify({ ...readMarker(), asset: "other.tar.gz" })),
			],
			[
				"a marker of another checksum",
				() => writeFileSync(markerPath(), JSON.stringify({ ...readMarker(), sha256: "0".repeat(64) })),
			],
		])("treats %s as an older release", async (_label, damage) => {
			const first = releaseFor(bytes(), undefined, "v2.56.0-2");
			const fetchMock = serveArchive(first.bytes);
			await installAs(first);
			damage();
			await installAs(first);
			assert.equal(fetchMock.mock.calls.length, 2);
			assert.equal(readMarker().tag, "v2.56.0-2");
			assert.deepEqual(leftovers(), []);
		});

		it("restores the older install when the new one cannot be put in place", async () => {
			const first = releaseFor(bytes(), undefined, "v2.56.0-2");
			serveArchive(first.bytes);
			await installAs(first);
			const newer = releaseFor(first.bytes, undefined, "v2.56.0-3");
			const denied = Object.assign(new Error("EACCES: rename"), { code: "EACCES" });
			const actualRename = mocks.actualFs!.renameSync;
			let intoPlace = 0;
			mocks.renameSync.mockImplementation((from: string, to: string) => {
				if (String(from).includes(".git-staging-") && to === installDir && ++intoPlace === 2) throw denied;
				return actualRename(from, to);
			});
			const statuses: { type: string; message: string }[] = [];
			const git = await provision(
				{ release: newer.release },
				{ onStatus: (status: { type: string; message: string }) => statuses.push(status) },
			);
			assert.equal(git.source, "provisioned");
			const warnings = statuses.filter((status) => status.type === "warning");
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!.message, /could not be installed into .*\(install-failed\)/);
			assert.equal(readMarker().tag, "v2.56.0-2");
			assert.ok(existsSync(join(installDir, "bin", "git")));
			assert.deepEqual(leftovers(), []);
		});

		it("sweeps a killed upgrade's leftovers on the next resolve even when no install is needed", async () => {
			const fake = releaseFor(bytes());
			const fetchMock = serveArchive(fake.bytes);
			await installAs(fake);
			fetchMock.mockClear();
			const binDir = join(agentDir, "bin");
			const exitedPid = runProcess(process.execPath, ["-e", ""]).pid;
			const replaced = join(binDir, `.git-replaced-${hostTag()}-${exitedPid}-1`);
			const staging = join(binDir, `.git-staging-${hostTag()}-${exitedPid}-1`);
			const live = join(binDir, `.git-staging-${hostTag()}-${process.pid}-1`);
			for (const dir of [replaced, staging, live]) mkdirSync(dir, { recursive: true });
			vi.resetModules();
			const fresh: ToolsManager = await import("../src/utils/tools-manager.ts");
			await fresh.withGitProvisionSettingsForTest({ release: fake.release }, () => fresh.resolveGit());
			assert.equal(fetchMock.mock.calls.length, 0);
			assert.equal(existsSync(replaced), false);
			assert.equal(existsSync(staging), false);
			assert.equal(existsSync(live), true);
		});

		it("reports a sweep that fails once and still resolves", async () => {
			const fake = releaseFor(bytes());
			serveArchive(fake.bytes);
			await installAs(fake);
			const binDir = join(agentDir, "bin");
			const actualReaddir = mocks.actualFs!.readdirSync;
			mocks.readdirSync.mockImplementation((path: string, options?: object) => {
				if (path === binDir) throw Object.assign(new Error("EIO: sweep failed"), { code: "EIO" });
				return actualReaddir(path, options as never);
			});
			vi.resetModules();
			const fresh: ToolsManager = await import("../src/utils/tools-manager.ts");
			const statuses: { type: string; message: string }[] = [];
			const git = await fresh.withGitProvisionSettingsForTest({ release: fake.release }, () =>
				fresh.resolveGit({ onStatus: (status) => statuses.push(status) }),
			);
			assert.equal(git.source, "provisioned");
			assert.deepEqual(statuses, [
				{
					type: "warning",
					message: `Could not remove abandoned git installs from ${binDir}: Error: EIO: sweep failed`,
				},
			]);
			await fresh.withGitProvisionSettingsForTest({ release: fake.release }, () =>
				fresh.resolveGit({ onStatus: (status) => statuses.push(status) }),
			);
			assert.equal(statuses.length, 1);

			vi.resetModules();
			const quiet: ToolsManager = await import("../src/utils/tools-manager.ts");
			const silent = await quiet.withGitProvisionSettingsForTest({ release: fake.release }, () =>
				quiet.resolveGit(),
			);
			assert.equal(silent.source, "provisioned");
		});

		it("sweeps replaced installs left by exited processes only", async () => {
			const fake = releaseFor(bytes());
			serveArchive(fake.bytes);
			const binDir = join(agentDir, "bin");
			const exitedPid = runProcess(process.execPath, ["-e", ""]).pid;
			const abandoned = join(binDir, `.git-replaced-${hostTag()}-${exitedPid}-1`);
			const live = join(binDir, `.git-replaced-${hostTag()}-${process.pid}-1`);
			for (const dir of [abandoned, live]) mkdirSync(dir, { recursive: true });
			await installAs(fake);
			assert.equal(existsSync(abandoned), false);
			assert.equal(existsSync(live), true);
		});
	});

	describe.skipIf(isWindows)("replacement details", () => {
		const provision = (overrides: Parameters<ToolsManager["withGitProvisionSettingsForTest"]>[0], options = {}) =>
			tools.withGitProvisionSettingsForTest(overrides, () => tools.resolveGit(options));
		const bytes = () => archiveOf(gitScript('echo "git version 2.56.0"'));
		const markerPath = () => join(installDir, ".atomic-git-release.json");

		async function installOlder() {
			const first = releaseFor(bytes(), undefined, "v2.56.0-2");
			const fetchMock = serveArchive(first.bytes);
			await provision({ release: first.release });
			return { first, fetchMock, newer: releaseFor(first.bytes, undefined, "v2.56.0-3") };
		}

		it("returns the replacement install, not the older one", async () => {
			const { newer } = await installOlder();
			const git = await provision({ release: newer.release });
			assert.equal(git.source, "provisioned");
			assert.equal(git.path, join(installDir, "bin", "git"));
			assert.equal(git.version, "2.56.0");
			assert.equal(git.env.GIT_EXEC_PATH, join(installDir, "libexec", "git-core"));
		});

		it("reinstalls over a marker that cannot be read as a file", async () => {
			const { first, fetchMock } = await installOlder();
			rmSync(markerPath());
			mkdirSync(markerPath());
			await provision({ release: first.release });
			assert.equal(fetchMock.mock.calls.length, 2);
			assert.equal(JSON.parse(readFileSync(markerPath(), "utf-8")).tag, "v2.56.0-2");
		});

		it("warns once and keeps the new install when the replaced one cannot be removed", async () => {
			const { newer } = await installOlder();
			const busy = new Error("EBUSY: replaced install in use");
			const actualRm = mocks.actualFs!.rmSync;
			mocks.rmSync.mockImplementation((path: string, options: object) => {
				if (String(path).includes(".git-replaced-")) throw busy;
				return actualRm(path, options);
			});
			const statuses: { type: string; message: string }[] = [];
			const git = await provision(
				{ release: newer.release },
				{ onStatus: (status: { type: string; message: string }) => statuses.push(status) },
			);
			assert.equal(JSON.parse(readFileSync(markerPath(), "utf-8")).tag, "v2.56.0-3");
			assert.equal(git.source, "provisioned");
			const warnings = statuses.filter((status) => status.type === "warning");
			assert.equal(warnings.length, 1);
			assert.match(
				warnings[0]!.message,
				/^Could not remove the replaced git install .*\/\.git-replaced-[0-9a-f]{8}-\d+-\d+: Error: EBUSY: replaced install in use$/,
			);
		});

		it("rejects with the caller's reason when cancelled while a newer release downloads", async () => {
			const { newer } = await installOlder();
			vi.spyOn(globalThis, "fetch").mockImplementation(
				(_input, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
					}),
			);
			const controller = new AbortController();
			const reason = new Error("stop updating");
			const pending = provision({ release: newer.release }, { signal: controller.signal });
			await vi.waitFor(() => assert.ok(leftovers().some((name) => name.startsWith(".git-staging-"))));
			controller.abort(reason);
			await assert.rejects(pending, (error) => error === reason);
			assert.equal(JSON.parse(readFileSync(markerPath(), "utf-8")).tag, "v2.56.0-2");
		});

		it("keeps the older install without an onStatus sink when the download fails", async () => {
			const { newer } = await installOlder();
			vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("gone", { status: 404 }));
			const git = await provision({ release: newer.release });
			assert.equal(git.source, "provisioned");
		});

		it("restores the older install and attaches the failure when putting the new one in place fails twice", async () => {
			const { first } = await installOlder();
			rmSync(markerPath());
			const denied = Object.assign(new Error("EACCES: rename"), { code: "EACCES" });
			const lost = new Error("EIO: restore failed");
			const actualRename = mocks.actualFs!.renameSync;
			mocks.rmSync.mockImplementation(mocks.actualFs!.rmSync);
			vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array(first.bytes)));
			rmSync(join(installDir, "bin", "git"));
			mkdirSync(join(installDir, "bin"), { recursive: true });
			let intoPlace = 0;
			mocks.renameSync.mockImplementation((from: string, to: string) => {
				if (String(from).includes(".git-staging-") && to === installDir && ++intoPlace === 2) throw denied;
				if (String(from).includes(".git-replaced-") && to === installDir) throw lost;
				return actualRename(from, to);
			});
			const error = await provision({ release: first.release }).catch((caught: Error) => caught);
			assert.ok(isGitUnavailableError(error));
			assert.equal(error.fields.code === "install-failed" ? error.fields.phase : undefined, "promote");
			assert.equal(error.cause, denied);
			assert.equal(error.cleanupCause, lost);
		});

		it("fails the install, publishing nothing, when the release marker cannot be written", async () => {
			const first = releaseFor(bytes(), undefined, "v2.56.0-2");
			serveArchive(first.bytes);
			const denied = Object.assign(new Error("EACCES: write marker"), { code: "EACCES" });
			const actualWrite = mocks.actualFs!.writeFileSync;
			mocks.writeFileSync.mockImplementation((path: string, ...rest: unknown[]) => {
				if (String(path).endsWith(".atomic-git-release.json")) throw denied;
				return (actualWrite as (...args: unknown[]) => unknown)(path, ...rest);
			});
			const error = await provision({ release: first.release }).catch((caught: Error) => caught);
			assert.ok(isGitUnavailableError(error));
			assert.equal(error.fields.code === "install-failed" ? error.fields.phase : undefined, "stage");
			assert.equal(error.cause, denied);
			assert.equal(existsSync(installDir), false);
			assert.deepEqual(leftovers(), []);
		});
	});

	it("names the platform command without reading os-release off Linux", async () => {
		mocks.platform.mockReturnValue("darwin");
		mocks.arch.mockReturnValue("arm64");
		vi.stubEnv(ENV_OFFLINE, "1");
		const error = await tools.resolveGit().catch((caught: Error) => caught);
		assert.ok(isGitUnavailableError(error));
		assert.equal(error.fields.installCommand, "xcode-select --install");
		assert.equal(mocks.osReleaseReads, 0);
	});

	it("forgets probes and the last failure when reset, as a new process would", async () => {
		const systemGit = makeSystemGit("2.43.0");
		usePath(join(systemGit, ".."));
		assert.equal(tools.resolveGitSync().version, "2.43.0");
		mocks.probes.set(systemGit, { status: 0, stdout: "git version 2.50.0\n" });
		assert.equal(tools.resolveGitSync().version, "2.43.0");
		tools.resetGitProvisionStateForTest();
		assert.equal(tools.resolveGitSync().version, "2.50.0");

		usePath(join(tempDir, "none"));
		makeProvisionedGit("2.56.0");
		assert.equal(tools.resolveGitSync().version, "2.56.0");
		mocks.probes.set(provisionedExecutable(), { status: 0, stdout: "git version 2.57.0\n" });
		assert.equal(tools.resolveGitSync().version, "2.56.0");
		tools.resetGitProvisionStateForTest();
		assert.equal(tools.resolveGitSync().version, "2.57.0");

		const exitedPid = runProcess(process.execPath, ["-e", ""]).pid;
		const leftover = join(agentDir, "bin", `.git-staging-${hostTag()}-${exitedPid}-1`);
		mkdirSync(leftover, { recursive: true });
		await tools.resolveGit();
		assert.equal(existsSync(leftover), false);
		mkdirSync(leftover, { recursive: true });
		await tools.resolveGit();
		assert.equal(existsSync(leftover), true);
		tools.resetGitProvisionStateForTest();
		await tools.resolveGit();
		assert.equal(existsSync(leftover), false);

		rmSync(installDir, { recursive: true });
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("gone", { status: 404 }));
		await tools.resolveGit().catch(() => undefined);
		assert.equal((caught(() => tools.resolveGitSync()) as { code?: string }).code, "download-failed");
		tools.resetGitProvisionStateForTest();
		assert.equal((caught(() => tools.resolveGitSync()) as { code?: string }).code, "not-installed");
	});

	describe.skipIf(isWindows)("a refresh that cannot be made is not retried by every resolution", () => {
		const provision = (overrides: Parameters<ToolsManager["withGitProvisionSettingsForTest"]>[0], options = {}) =>
			tools.withGitProvisionSettingsForTest(overrides, () => tools.resolveGit(options));

		async function installOlder() {
			const first = releaseFor(archiveOf(gitScript('echo "git version 2.56.0"')), undefined, "v2.56.0-2");
			serveArchive(first.bytes);
			await provision({ release: first.release });
			return { first, newer: releaseFor(first.bytes, undefined, "v2.56.0-3") };
		}

		/** Every download attempt answers 503, so one provisioning cycle is three requests; earlier calls are forgotten. */
		function failDownloads() {
			const fetchMock = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async () => new Response("busy", { status: 503 }));
			fetchMock.mockClear();
			return fetchMock;
		}

		it("makes one download cycle and one warning however many times git is resolved", async () => {
			const { newer } = await installOlder();
			const fetchMock = failDownloads();
			const warnings: string[] = [];
			const onStatus = (status: { type: string; message: string }) => {
				if (status.type === "warning") warnings.push(status.message);
			};
			await tools.withGitProvisionSettingsForTest({ release: newer.release }, async () => {
				for (const _ of [1, 2, 3, 4]) await tools.resolveGit({ onStatus });
				await tools.getToolPath("git", { onStatus });
				await tools.getToolEnv("git", { onStatus });
			});
			assert.equal(fetchMock.mock.calls.length, 3);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!, /\(HTTP 503\) \(download-failed\)/);

			tools.resetGitProvisionStateForTest();
			await provision({ release: newer.release }, { onStatus });
			assert.equal(fetchMock.mock.calls.length, 6);
			assert.equal(warnings.length, 2);
		});

		it("records the typed reason, shows it in the status, and clears it once the update succeeds", async () => {
			const { newer } = await installOlder();
			const pending = tools.withGitProvisionSettingsForTest({ release: newer.release }, async () =>
				tools.getGitStatus(),
			);
			const before = await pending;
			assert.equal(before.source, "provisioned");
			assert.deepEqual(before.source === "unavailable" ? undefined : before.update, {
				pinnedTag: "v2.56.0-3",
				installedTag: "v2.56.0-2",
			});

			failDownloads();
			const failed = await tools.withGitProvisionSettingsForTest({ release: newer.release }, async () => {
				await tools.resolveGit();
				return tools.getGitStatus();
			});
			assert.ok(failed.source !== "unavailable" && failed.update?.reason !== undefined);
			const reason = rehydrateGitProvisionError(failed.update.reason);
			assert.ok(reason instanceof GitUnavailableError);
			assert.equal(reason.code, "download-failed");
			assert.equal(failed.update.pinnedTag, "v2.56.0-3");
			assert.equal(failed.update.installedTag, "v2.56.0-2");

			tools.resetGitProvisionStateForTest();
			serveArchive(newer.bytes);
			await provision({ release: newer.release });
			const current = await tools.withGitProvisionSettingsForTest({ release: newer.release }, async () =>
				tools.getGitStatus(),
			);
			assert.ok(current.source !== "unavailable");
			assert.equal(current.update, undefined);
		});

		it("records the offline reason with the install command, warns once, and retries when online", async () => {
			const { newer } = await installOlder();
			mocks.osRelease = { id: "debian", idLike: [] };
			mocks.platform.mockReturnValue("linux");
			const fetchMock = vi.spyOn(globalThis, "fetch");
			fetchMock.mockClear();
			vi.stubEnv(ENV_OFFLINE, "1");
			const warnings: string[] = [];
			const onStatus = (status: { type: string; message: string }) => {
				if (status.type === "warning") warnings.push(status.message);
			};
			const status = await tools.withGitProvisionSettingsForTest({ release: newer.release }, async () => {
				await tools.resolveGit({ onStatus });
				await tools.resolveGit({ onStatus });
				return tools.getGitStatus();
			});
			assert.equal(fetchMock.mock.calls.length, 0);
			assert.equal(warnings.length, 1);
			assert.ok(status.source !== "unavailable" && status.update?.reason !== undefined);
			const reason = rehydrateGitProvisionError(status.update.reason);
			assert.ok(reason instanceof GitUnavailableError);
			assert.equal(reason.code, "offline");
			assert.equal(reason.fields.installCommand, "apt-get install git");

			vi.stubEnv(ENV_OFFLINE, "");
			const online = serveArchive(newer.bytes);
			online.mockClear();
			await provision({ release: newer.release });
			assert.equal(online.mock.calls.length, 1);
		});

		it("warns again for a different pinned release while offline, but not twice for the same one", async () => {
			const { newer } = await installOlder();
			vi.stubEnv(ENV_OFFLINE, "1");
			const warnings: string[] = [];
			const onStatus = (status: { type: string; message: string }) => {
				if (status.type === "warning") warnings.push(status.message);
			};
			const later = releaseFor(newer.bytes, undefined, "v2.56.0-4");
			await provision({ release: newer.release }, { onStatus });
			await provision({ release: newer.release }, { onStatus });
			assert.equal(warnings.length, 1);
			await provision({ release: later.release }, { onStatus });
			await provision({ release: later.release }, { onStatus });
			assert.equal(warnings.length, 2);
		});

		it("shows a pending update without an installed tag when the install recorded none", async () => {
			const { newer } = await installOlder();
			rmSync(join(installDir, ".atomic-git-release.json"));
			const status = await tools.withGitProvisionSettingsForTest({ release: newer.release }, async () =>
				tools.getGitStatus(),
			);
			assert.ok(status.source !== "unavailable");
			assert.deepEqual(status.update, { pinnedTag: "v2.56.0-3" });
		});

		it("never takes the install lock to resolve an install of the pinned release", async () => {
			const first = releaseFor(archiveOf(gitScript('echo "git version 2.56.0"')), undefined, "v2.56.0-2");
			serveArchive(first.bytes);
			await provision({ release: first.release });
			let locks = 0;
			mocks.lock = async (real, file, options) => {
				locks += 1;
				return real.lock(file, options);
			};
			await provision({ release: first.release });
			await provision({ release: first.release });
			assert.equal(locks, 0);
		});
	});
});
