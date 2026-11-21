import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import psFixtures from "./fixtures/ps-lstart.json" with { type: "json" };

vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof childProcess>();
	return { ...actual, execFile: vi.fn(actual.execFile) };
});
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof fsPromises>();
	return {
		...actual,
		copyFile: vi.fn(actual.copyFile),
		opendir: vi.fn(actual.opendir),
		readFile: vi.fn(actual.readFile),
		readlink: vi.fn(actual.readlink),
	};
});
vi.mock("node:os", async (original) => {
	const actual = await original<typeof os>();
	return { ...actual, hostname: vi.fn(actual.hostname) };
});

const root = useTemporaryAgentDir();
let exitListeners = process.listeners("exit");
beforeEach(() => {
	exitListeners = process.listeners("exit");
});
afterEach(() => {
	// Each isolated module import installs its own hook; do not retain test module instances between cases.
	for (const listener of process.listeners("exit")) {
		if (!exitListeners.includes(listener)) process.removeListener("exit", listener);
	}
	vi.restoreAllMocks();
	vi.resetAllMocks();
});

async function owner(namespace: string, boot = "boot-a") {
	vi.resetModules();
	vi.mocked(fsPromises.readlink).mockResolvedValue(`pid:[${namespace}]`);
	const actual = await vi.importActual<typeof fs>("node:fs");
	vi.mocked(fsPromises.readFile).mockImplementation(async (...args: Parameters<typeof fs.readFileSync>) =>
		String(args[0]) === "/proc/sys/kernel/random/boot_id" ? boot : actual.readFileSync(...args),
	);
	return import("../src/core/storage/session/released-history-files.js");
}

test.skipIf(process.platform !== "linux")(
	"host and container PID namespaces and boots never sweep each other's history",
	async () => {
		vi.mocked(os.hostname).mockReturnValue("a".repeat(64));
		const host = await owner("100");
		const a = await host.releasedHistoryFiles(root).createDirectory();
		assert.ok("path" in a && !(a instanceof Error));
		await a.write(1, Buffer.from("host"));
		const container = await owner("200");
		const b = await container.releasedHistoryFiles(root).createDirectory();
		assert.ok("path" in b && !(b instanceof Error));
		await b.write(1, Buffer.from("container"));
		assert.notEqual(dirname(a.path), dirname(b.path));
		// A PID in the other namespace may be absent here or reused by a different process.
		const foreignDead = join(dirname(dirname(a.path)), "2147483647-1");
		fs.mkdirSync(foreignDead);
		await container.sweepReleasedHistory(root);
		assert.ok(fs.existsSync(foreignDead));
		assert.equal((await a.read(1)).toString(), "host");
		const containerDead = join(dirname(dirname(b.path)), "2147483647-1");
		fs.mkdirSync(containerDead);
		await host.sweepReleasedHistory(root);
		assert.ok(fs.existsSync(containerDead));
		assert.equal((await b.read(1)).toString(), "container");
		const rebooted = await owner("100", "boot-b");
		const c = await rebooted.releasedHistoryFiles(root).createDirectory();
		assert.ok(!(c instanceof Error));
		assert.notEqual(dirname(c.path), dirname(a.path));
		await rebooted.sweepReleasedHistory(root);
		assert.ok(fs.existsSync(a.path));
		await a.remove();
		await b.remove();
		await c.remove();
	},
);

test.skipIf(process.platform !== "linux").each(["known", "unknown"])(
	"same-PID owners with %s identity never remove each other's history at exit",
	async (identity) => {
		const first = await owner("100");
		if (identity === "unknown")
			vi.mocked(fsPromises.readlink).mockImplementation(async () => {
				throw Object.assign(new Error("unknown namespace"), { code: "EACCES" });
			});
		const a = await first.releasedHistoryFiles(root).createDirectory();
		assert.ok(!(a instanceof Error));
		await a.write(1, Buffer.from("first\u0000😀"));
		const exit = process.listeners("exit").find((listener) => !exitListeners.includes(listener));
		assert.ok(exit);
		const second = await owner("100");
		if (identity === "unknown")
			vi.mocked(fsPromises.readlink).mockImplementation(async () => {
				throw Object.assign(new Error("unknown namespace"), { code: "EACCES" });
			});
		const b = await second.releasedHistoryFiles(root).createDirectory();
		assert.ok(!(b instanceof Error));
		await b.write(1, Buffer.from("second\u0000漢字"));
		assert.equal((await a.read(1)).toString(), "first\u0000😀");
		assert.equal((await b.read(1)).toString(), "second\u0000漢字");
		await a.remove();
		exit(0);
		assert.equal((await b.read(1)).toString(), "second\u0000漢字");
		assert.notEqual(dirname(a.path), dirname(b.path));
		await b.remove();
	},
);

test.skipIf(process.platform !== "linux")(
	"nonce-bearing and legacy directories both require positive proof of owner death",
	async () => {
		const module = await owner("100");
		const directory = await module.releasedHistoryFiles(root).createDirectory();
		assert.ok(!(directory instanceof Error));
		const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
		const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		const host = dirname(dirname(directory.path));
		const paths = ["", `-${"a".repeat(32)}`].flatMap((suffix) =>
			[
				{ owner: `${process.pid}-${start}`, keep: true },
				{ owner: `${process.pid}-unknown`, keep: true },
				{ owner: `${process.pid}-1`, keep: false },
				{ owner: "2147483647-1", keep: false },
			].map(({ owner, keep }) => {
				const path = join(host, `${owner}${suffix}`);
				fs.mkdirSync(path);
				return { path, keep };
			}),
		);
		await module.sweepReleasedHistory(root);
		for (const { path, keep } of paths) assert.equal(fs.existsSync(path), keep, path);
		await directory.remove();
	},
);

test("a store recreates its missing directory on a later release", async () => {
	const { releasedHistoryFiles } = await import("../src/core/storage/session/released-history-files.js");
	const directory = await releasedHistoryFiles(root).createDirectory();
	assert.ok(!(directory instanceof Error));
	await directory.write(1, Buffer.from("first"));
	fs.rmSync(directory.path, { recursive: true });
	await directory.write(2, Buffer.from("later"));
	assert.equal((await directory.read(2)).toString(), "later");
	await directory.remove();
});

test("re-release requests a copy-on-write clone while preserving the previous history", async () => {
	const { releasedHistoryFiles } = await import("../src/core/storage/session/released-history-files.js");
	const directory = await releasedHistoryFiles(root).createDirectory();
	assert.ok(!(directory instanceof Error));
	await directory.write(1, Buffer.from("first"));
	await directory.write(2, Buffer.from(",later"), { file: 1, bytes: 5 });
	assert.equal((await directory.read(2)).toString(), "first,later");
	assert.equal(vi.mocked(fsPromises.copyFile).mock.calls.at(-1)?.[2], fs.constants.COPYFILE_FICLONE);
	await directory.remove();
});

test("macOS lstart fixtures keep live owners, remove reused PIDs, and preserve uncertain lookups", async () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
	Object.defineProperty(process, "platform", { value: "darwin" });
	vi.spyOn(process, "kill").mockReturnValue(true);
	const token = (text: string) => text.replace(/[^A-Za-z0-9]+/g, "");
	const samples = psFixtures.samples.map(({ stdout }) => stdout);
	const responses = new Map<number, { stdout: string; code?: number | string; killed?: boolean }>([
		[401, { stdout: samples[0] as string }],
		[402, { stdout: samples[1] as string }],
		[403, { stdout: samples[2] as string }],
		[404, { stdout: "", code: 1 }],
		[405, { stdout: "ps: permission denied", code: 2 }],
		[406, { stdout: "not a start time" }],
		[407, { stdout: samples[0] as string, code: "ETIMEDOUT", killed: true }],
		[408, { stdout: "", code: "ENOENT" }],
		[409, { stdout: samples[1] as string, code: 2 }],
		[410, { stdout: "", code: 1, killed: true }],
		[411, { stdout: "" }],
		[412, { stdout: "", code: 2 }],
		[413, { stdout: `${(samples[0] as string).trim()} unexpected` }],
		[414, { stdout: `unexpected ${(samples[0] as string).trim()}` }],
		[415, { stdout: (samples[0] as string).replace(" 6 ", "16 ") }],
	]);
	vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
		const command = args[0];
		const argv = args[1] as string[];
		const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void;
		if (command === "sysctl") assert.deepEqual(argv, ["-n", "kern.boottime"]);
		else {
			assert.equal(command, "ps");
			assert.deepEqual(argv.slice(0, 3), ["-o", "lstart=", "-p"]);
		}
		const response =
			command === "sysctl"
				? { stdout: "{ sec = 1730000000, usec = 123456 } Sun Oct 27 03:33:20 2024" }
				: (responses.get(Number(argv.at(-1))) ?? { stdout: samples[0] as string });
		callback("code" in response ? Object.assign(new Error("ps failed"), response) : null, response.stdout, "");
		return {} as childProcess.ChildProcess;
	});
	try {
		vi.resetModules();
		const module = await import("../src/core/storage/session/released-history-files.js");
		const directory = await module.releasedHistoryFiles(root).createDirectory();
		assert.ok(!(directory instanceof Error));
		const parent = dirname(dirname(directory.path));
		const paths = new Map<number, string>();
		for (const pid of responses.keys()) {
			const start = pid === 402 ? token(samples[1] as string) : token(samples[0] as string);
			const path = join(parent, `${pid}-${start}`);
			fs.mkdirSync(path);
			paths.set(pid, path);
		}
		await module.sweepReleasedHistory(root);
		for (const [pid, path] of paths) assert.equal(fs.existsSync(path), ![403, 415].includes(pid), `pid ${pid}`);
		for (const [command, , options] of vi.mocked(childProcess.execFile).mock.calls) {
			if (command !== "ps") continue;
			assert.equal((options as childProcess.ExecFileOptions).env?.LC_ALL, "C");
			assert.equal((options as childProcess.ExecFileOptions).env?.TZ, "UTC");
		}
		await directory.remove();
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
});

test.skipIf(process.platform !== "linux")(
	"an unreadable PID namespace disables sweeping rather than guessing",
	async () => {
		const module = await owner("300");
		vi.mocked(fsPromises.readlink).mockImplementation(async () => {
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		});
		const directory = await module.releasedHistoryFiles(root).createDirectory();
		assert.ok(!(directory instanceof Error));
		const gone = join(dirname(dirname(directory.path)), "2147483647-1");
		fs.mkdirSync(gone);
		await module.sweepReleasedHistory(root);
		assert.ok(fs.existsSync(gone));
		await directory.remove();
	},
);

test("Windows boot and PowerShell process start lookups preserve uncertainty and separate reused PIDs", async () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
	Object.defineProperty(process, "platform", { value: "win32" });
	vi.spyOn(process, "kill").mockReturnValue(true);
	vi.mocked(childProcess.execFile).mockClear();
	vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
		const argv = args[1] as string[];
		const command = argv.at(-1) as string;
		const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void;
		assert.deepEqual(argv.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
		assert.equal((args[2] as childProcess.ExecFileOptions).encoding, "utf8");
		const pid = Number(/-Id ([0-9]+)/.exec(command)?.[1]);
		const stdout = command.includes("Win32_OperatingSystem")
			? "123456789"
			: pid === 402
				? "2000"
				: pid === 404
					? "not a time"
					: pid === 407
						? "prefix1000"
						: pid === 408
							? "1000suffix"
							: "1000";
		const error =
			pid === 405
				? Object.assign(new Error("denied"), { code: 1 })
				: pid === 406
					? Object.assign(new Error("missing"), { code: "ENOENT" })
					: null;
		callback(error, stdout, "");
		return {} as childProcess.ChildProcess;
	});
	try {
		vi.resetModules();
		// Without the native reader, start times come from PowerShell.
		(await import("../src/core/process-start-token.js")).setNativeProcessCreationTimeForTesting(null);
		const module = await import("../src/core/storage/session/released-history-files.js");
		const directory = await module.releasedHistoryFiles(root).createDirectory();
		assert.ok(!(directory instanceof Error));
		const parent = dirname(dirname(directory.path));
		for (const pid of [401, 402, 403, 404, 405, 406, 407, 408])
			fs.mkdirSync(join(parent, `${pid}-${pid === 403 ? "unknown" : pid === 405 ? "2000" : "1000"}`));
		await module.sweepReleasedHistory(root);
		for (const pid of [401, 402, 403, 404, 405, 406, 407, 408])
			assert.equal(
				fs.existsSync(join(parent, `${pid}-${pid === 403 ? "unknown" : pid === 405 ? "2000" : "1000"}`)),
				pid !== 402,
				`pid ${pid}`,
			);
		assert.equal(
			vi
				.mocked(childProcess.execFile)
				.mock.calls.filter(([, argv]) => (argv as string[]).at(-1)?.includes("Win32_OperatingSystem")).length,
			1,
			"boot identity is looked up once",
		);
		await directory.remove();
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
});

test.skipIf(process.platform !== "linux")(
	"Linux permission failures and malformed process stats never prove an owner gone",
	async () => {
		const module = await owner("500");
		const actual = await vi.importActual<typeof fs>("node:fs");
		const stat = actual.readFileSync(`/proc/${process.pid}/stat`, "utf8");
		const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] as string;
		vi.spyOn(process, "kill").mockImplementation((pid) => {
			if (pid === 404 || pid === 405 || pid === 408)
				throw Object.assign(new Error("kill failed"), { code: pid === 404 ? "ESRCH" : "EPERM" });
			return true;
		});
		vi.mocked(fsPromises.readFile).mockImplementation(async (...args: Parameters<typeof fs.readFileSync>) => {
			const path = String(args[0]);
			if (path === "/proc/sys/kernel/random/boot_id") return "boot-a";
			if ([401, 402, 405].some((pid) => path === `/proc/${pid}/stat`))
				throw Object.assign(new Error("stat failed"), { code: path === "/proc/402/stat" ? "ENOENT" : "EACCES" });
			if (path === "/proc/403/stat") return "malformed";
			if (path === "/proc/406/stat") return stat.replace(` ${start} `, ` prefix${start} `);
			if (path === "/proc/407/stat") return stat.replace(` ${start} `, ` ${start}suffix `);
			if (path === "/proc/404/stat") return stat;
			if (path === "/proc/408/stat") return stat.replace(` ${start} `, " 1 ");
			return actual.readFileSync(...args);
		});
		const directory = await module.releasedHistoryFiles(root).createDirectory();
		assert.ok(!(directory instanceof Error));
		const parent = dirname(dirname(directory.path));
		for (const pid of [401, 402, 403, 404, 405, 406, 407, 408]) fs.mkdirSync(join(parent, `${pid}-${start}`));
		await module.sweepReleasedHistory(root);
		for (const pid of [401, 402, 403, 404, 405, 406, 407, 408])
			assert.equal(fs.existsSync(join(parent, `${pid}-${start}`)), pid !== 404, `pid ${pid}`);
		await directory.remove();
	},
);

test
	.skipIf(process.platform !== "linux")
	.each([`NSpid:\t${process.pid + 1}\t${process.pid}\n`, `NSpid:\t${process.pid}\t${process.pid}\n`, "Name:\tnode\n"])(
	"a mismatched or unknown proc PID view disables sweeping and start-time lookups: %j",
	async (status) => {
		const caseRoot = join(root, `proc-mismatch-${status.replace(/[^0-9]/g, "") || "unknown"}`);
		const module = await owner("500");
		const actual = await vi.importActual<typeof fs>("node:fs");
		vi.mocked(fsPromises.readFile).mockImplementation(async (...args: Parameters<typeof fs.readFileSync>) => {
			const path = String(args[0]);
			if (path === "/proc/self/status") return status;
			if (path === "/proc/sys/kernel/random/boot_id") return "boot-a";
			return actual.readFileSync(...args);
		});
		const directory = await module.releasedHistoryFiles(caseRoot).createDirectory();
		assert.ok(!(directory instanceof Error));
		const gone = join(dirname(dirname(directory.path)), "2147483647-1");
		fs.mkdirSync(gone);
		await module.sweepReleasedHistory(caseRoot);
		assert.ok(fs.existsSync(gone));
		assert.ok(directory.path.includes(`${process.pid}-unknown`));
		assert.equal(
			vi.mocked(fsPromises.readFile).mock.calls.filter(([path]) => String(path).endsWith("/stat")).length,
			0,
		);
		await directory.remove();
	},
);

test.each(
	[
		{ platform: "linux", stdout: "", namespace: "pid:[123]" },
		{ platform: "linux", stdout: "boot-a", namespace: "bad-pid:[123]" },
		{ platform: "linux", stdout: "boot-a", namespace: "pid:[123]-bad" },
		{ platform: "darwin", stdout: "not a boot time" },
		{ platform: "darwin", stdout: "{ sec = 1730000000, usec = 123456 }", code: 1 },
		{ platform: "darwin", stdout: "{ sec = 1730000000, usec = 123456 }", code: "ENOENT" },
		{ platform: "win32", stdout: "123456", code: 1 },
		{ platform: "win32", stdout: "123456", code: "ENOENT" },
		{ platform: "win32", stdout: "prefix123456" },
		{ platform: "win32", stdout: "123456suffix" },
		{ platform: "freebsd", stdout: "" },
	].map((row, index) => ({ ...row, index })),
)(
	"unknown boot/namespace identity never sweeps: $platform $stdout $namespace $code",
	async ({ platform: value, stdout, namespace, code, index }) => {
		const caseRoot = join(root, `unknown-${index}`);
		const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
		Object.defineProperty(process, "platform", { value });
		const actual = await vi.importActual<typeof fs>("node:fs");
		vi.mocked(fsPromises.readlink).mockResolvedValue(namespace ?? "pid:[123]");
		vi.mocked(fsPromises.readFile).mockImplementation(async (...args: Parameters<typeof fs.readFileSync>) =>
			String(args[0]) === "/proc/sys/kernel/random/boot_id" ? stdout : actual.readFileSync(...args),
		);
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("gone"), { code: "ESRCH" });
		});
		vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
			const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void;
			callback(code === undefined ? null : Object.assign(new Error("boot failed"), { code }), stdout, "");
			return {} as childProcess.ChildProcess;
		});
		try {
			vi.resetModules();
			const module = await import("../src/core/storage/session/released-history-files.js");
			const directory = await module.releasedHistoryFiles(caseRoot).createDirectory();
			assert.ok(!(directory instanceof Error));
			const gone = join(dirname(dirname(directory.path)), "2147483647-1");
			fs.mkdirSync(gone);
			await module.sweepReleasedHistory(caseRoot);
			assert.ok(fs.existsSync(gone));
			await directory.remove();
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	},
);

test.each(["darwin", "win32"])("%s boot identities keep files from an earlier boot out of the sweep", async (value) => {
	// An agent directory of its own: the first owner's background sweep, legitimately in its own boot, finds nothing there.
	const caseRoot = join(root, `earlier-boot-${value}`);
	const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
	Object.defineProperty(process, "platform", { value });
	let boot = value === "darwin" ? "{ sec = 1730000000, usec = 123456 }" : "123456789";
	vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
		const argv = args[1] as string[];
		const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void;
		const isBoot = args[0] === "sysctl" || argv.at(-1)?.includes("Win32_OperatingSystem");
		callback(null, isBoot ? boot : value === "darwin" ? (psFixtures.samples[0]?.stdout as string) : "1000", "");
		return {} as childProcess.ChildProcess;
	});
	try {
		vi.resetModules();
		const first = await import("../src/core/storage/session/released-history-files.js");
		const a = await first.releasedHistoryFiles(caseRoot).createDirectory();
		assert.ok(!(a instanceof Error));
		const stale = join(dirname(dirname(a.path)), "2147483647-1");
		fs.mkdirSync(stale);
		boot = value === "darwin" ? "{ sec = 1730000000, usec = 123457 }" : "123456780";
		vi.resetModules();
		const second = await import("../src/core/storage/session/released-history-files.js");
		const b = await second.releasedHistoryFiles(caseRoot).createDirectory();
		assert.ok(!(b instanceof Error));
		assert.notEqual(dirname(dirname(a.path)), dirname(dirname(b.path)));
		await second.sweepReleasedHistory(caseRoot);
		assert.ok(fs.existsSync(stale));
		await a.remove();
		await b.remove();
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
});

test.each([
	{ platform: "win32", expectedCwd: "D:\\Windows" },
	{ platform: "darwin", expectedCwd: "/" },
])(
	"$platform boot and start-time probes run outside the caller's cwd (#4655)",
	async ({ platform: value, expectedCwd }) => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
		Object.defineProperty(process, "platform", { value });
		vi.stubEnv("SystemRoot", "D:\\Windows");
		const observedCwds: Array<string | URL | undefined> = [];
		type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
		vi.mocked(childProcess.execFile).mockImplementation(((
			command: string,
			argv: readonly string[],
			options: childProcess.ExecFileOptions,
			callback: ExecFileCallback,
		) => {
			observedCwds.push(options.cwd);
			const isBoot = command === "sysctl" || argv.at(-1)?.includes("Win32_OperatingSystem");
			const stdout = isBoot
				? value === "darwin"
					? "{ sec = 1730000000, usec = 123456 }"
					: "123456789"
				: value === "darwin"
					? (psFixtures.samples[0]?.stdout ?? "")
					: "1000";
			callback(null, stdout, "");
			return {} as childProcess.ChildProcess;
		}) as typeof childProcess.execFile);
		try {
			vi.resetModules();
			// Without the native reader, Windows start times come from PowerShell too.
			(await import("../src/core/process-start-token.js")).setNativeProcessCreationTimeForTesting(null);
			const module = await import("../src/core/storage/session/released-history-files.js");
			const directory = await module.releasedHistoryFiles(root).createDirectory();
			assert.ok(!(directory instanceof Error));
			await module.sweepReleasedHistory(root);
			assert.ok(observedCwds.length >= 2, "both boot identity and start-time probes ran");
			for (const cwd of observedCwds) assert.equal(cwd, expectedCwd);
			await directory.remove();
		} finally {
			vi.unstubAllEnvs();
			Object.defineProperty(process, "platform", platform);
		}
	},
);

test.each(["win32", "darwin"])(
	"%s startup with no released history to sweep starts no boot or start-time lookup",
	async (value) => {
		const caseRoot = join(root, `nothing-to-sweep-${value}`);
		const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
		Object.defineProperty(process, "platform", { value });
		vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
			const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void;
			const isBoot = args[0] === "sysctl" || (args[1] as string[]).at(-1)?.includes("Win32_OperatingSystem");
			callback(
				null,
				isBoot ? (value === "darwin" ? "{ sec = 1730000000, usec = 123456 }" : "123456789") : "1000",
				"",
			);
			return {} as childProcess.ChildProcess;
		});
		try {
			vi.resetModules();
			const tokens = await import("../src/core/process-start-token.js");
			tokens.setNativeProcessCreationTimeForTesting(null);
			const first = await import("../src/core/storage/session/released-history-files.js");
			// No released-history directory at all: the default session stores never create one.
			await first.sweepReleasedHistory(caseRoot);
			assert.equal(vi.mocked(childProcess.execFile).mock.calls.length, 0, "nothing under the agent directory");
			// A store released history and closed: this host's directory is left, empty.
			const directory = await first.releasedHistoryFiles(caseRoot).createDirectory();
			assert.ok(!(directory instanceof Error));
			await directory.write(1, Buffer.from("released"));
			await directory.remove();
			const host = dirname(dirname(directory.path));
			assert.deepEqual(fs.readdirSync(host), []);
			vi.mocked(childProcess.execFile).mockClear();
			vi.resetModules();
			(await import("../src/core/process-start-token.js")).setNativeProcessCreationTimeForTesting(null);
			const next = await import("../src/core/storage/session/released-history-files.js");
			await next.sweepReleasedHistory(caseRoot);
			assert.equal(vi.mocked(childProcess.execFile).mock.calls.length, 0, "only an empty host directory");
			// A directory a killed process left is still swept, after looking up the boot once.
			const left = join(host, "2147483647-1000");
			fs.mkdirSync(left);
			vi.spyOn(process, "kill").mockImplementation(() => {
				throw Object.assign(new Error("gone"), { code: "ESRCH" });
			});
			await next.sweepReleasedHistory(caseRoot);
			assert.equal(fs.existsSync(left), false);
			assert.equal(vi.mocked(childProcess.execFile).mock.calls.length, 1, "one boot lookup");
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	},
);

test("Windows sweeps read process start times from the native module, not PowerShell", async () => {
	const caseRoot = join(root, "native-start-times");
	const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
	Object.defineProperty(process, "platform", { value: "win32" });
	vi.spyOn(process, "kill").mockReturnValue(true);
	vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
		const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void;
		const isBoot = (args[1] as string[]).at(-1)?.includes("Win32_OperatingSystem");
		callback(null, isBoot ? "123456789" : "1000", "");
		return {} as childProcess.ChildProcess;
	});
	// Creation times as GetProcessTimes reports them; 403 cannot be read (gone or not queryable).
	const created = new Map<number, string>([
		[process.pid, "5000"],
		[401, "1000"],
		[402, "2000"],
	]);
	try {
		vi.resetModules();
		(await import("../src/core/process-start-token.js")).setNativeProcessCreationTimeForTesting(
			(pid) => created.get(pid) ?? null,
		);
		const module = await import("../src/core/storage/session/released-history-files.js");
		const directory = await module.releasedHistoryFiles(caseRoot).createDirectory();
		assert.ok(!(directory instanceof Error));
		assert.ok(directory.path.includes(`${process.pid}-5000-`), "this process's directory names its creation time");
		const parent = dirname(dirname(directory.path));
		for (const pid of [401, 402, 403]) fs.mkdirSync(join(parent, `${pid}-1000`));
		await module.sweepReleasedHistory(caseRoot);
		// 401 still runs, 402 is a later process given the same id, 403 cannot be told apart.
		for (const pid of [401, 402, 403])
			assert.equal(fs.existsSync(join(parent, `${pid}-1000`)), pid !== 402, `pid ${pid}`);
		const queries = vi.mocked(childProcess.execFile).mock.calls.map(([, argv]) => (argv as string[]).at(-1) ?? "");
		assert.deepEqual(
			queries.map((query) => query.includes("Win32_OperatingSystem")),
			[true],
			"only the boot identity starts PowerShell",
		);
		await directory.remove();
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
});

test("the startup check reads a bounded part of a large shared released-history directory", async () => {
	const caseRoot = join(root, "shared-released-history");
	const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
	Object.defineProperty(process, "platform", { value: "win32" });
	vi.mocked(os.hostname).mockReturnValue("this-host");
	vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
		const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void;
		callback(null, "123456789", "");
		return {} as childProcess.ChildProcess;
	});
	// Other machines' directories in an agent directory they share, and nothing of this host's.
	for (let index = 0; index < 500; index++)
		fs.mkdirSync(join(caseRoot, "released-history", `other-${index}-0`), { recursive: true });
	const actual = await vi.importActual<typeof fsPromises>("node:fs/promises");
	let entriesRead = 0;
	vi.mocked(fsPromises.opendir).mockImplementation(async (...args: Parameters<typeof fsPromises.opendir>) => {
		const directory = await actual.opendir(...args);
		const read = directory.read.bind(directory) as () => Promise<fs.Dirent | null>;
		Object.assign(directory, {
			read: async () => {
				entriesRead++;
				return read();
			},
		});
		return directory;
	});
	try {
		vi.resetModules();
		(await import("../src/core/process-start-token.js")).setNativeProcessCreationTimeForTesting(null);
		const module = await import("../src/core/storage/session/released-history-files.js");
		await module.sweepReleasedHistory(caseRoot);
		assert.ok(entriesRead <= 33, `read ${entriesRead} entries`);
		// Past the bound the sweep goes on as before: it looks up this boot and reads only this host's directory.
		assert.equal(vi.mocked(childProcess.execFile).mock.calls.length, 1);
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
});

test("under Bun only an absent released-history directory skips the boot lookup", async () => {
	const caseRoot = join(root, "bun-runtime");
	const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
	Object.defineProperty(process, "platform", { value: "win32" });
	// Bun's Dir lists a whole directory on its first read, so the bounded listing is Node's alone.
	Object.defineProperty(process.versions, "bun", { value: "1.4.5", configurable: true, enumerable: true });
	vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
		const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void;
		callback(null, "123456789", "");
		return {} as childProcess.ChildProcess;
	});
	try {
		vi.resetModules();
		(await import("../src/core/process-start-token.js")).setNativeProcessCreationTimeForTesting(null);
		const module = await import("../src/core/storage/session/released-history-files.js");
		await module.sweepReleasedHistory(caseRoot);
		assert.equal(vi.mocked(childProcess.execFile).mock.calls.length, 0, "no released-history directory");
		fs.mkdirSync(join(caseRoot, "released-history"), { recursive: true });
		await module.sweepReleasedHistory(caseRoot);
		assert.equal(vi.mocked(childProcess.execFile).mock.calls.length, 1, "an existing one is swept as before");
		assert.equal(vi.mocked(fsPromises.opendir).mock.calls.length, 0, "and never listed by the check");
	} finally {
		delete (process.versions as { bun?: string }).bun;
		Object.defineProperty(process, "platform", platform);
	}
});
