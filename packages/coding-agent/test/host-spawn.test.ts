import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	stillRuns,
	waitUntilGone,
} from "../../../test/helpers/recorded-process.js";
import { sleep } from "../../../test/helpers/runtime.js";
import {
	type ContainedChildProcess,
	chooseHostSpawnBackend,
	HOST_SPAWN_ENV,
	type HostChildProcess,
	type HostSpawnOptions,
	hostSpawnBackend,
	spawnContainedProcess,
	spawnHostProcess,
} from "../src/utils/host-spawn.ts";

const node = process.execPath;

/** How long a test waits for a process it ended to be gone, before failing. */
const PROCESS_GONE_TIMEOUT_MS = 10_000;
/** How long a process a test leaves running runs when nothing ends it: bounded, well past any test. */
const LEFT_RUNNING_MS = 120_000;
/** Longer than an ended process takes to be gone; one still there after it was not ended. */
const NOT_ENDED_MS = 1_000;
/** How long a test waits for a process that exited to close, before failing. */
const CLOSE_TIMEOUT_MS = 10_000;

interface Ended {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly events: readonly string[];
}

/** Runs `child` to its `close`, collecting its output and the order of its events. */
function ended(child: HostChildProcess): Promise<Ended> {
	const events: string[] = [];
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	child.on("spawn", () => events.push("spawn"));
	child.on("exit", () => events.push("exit"));
	child.on("error", (error: NodeJS.ErrnoException) => events.push(`error ${error.code}`));
	return new Promise((resolve) => {
		child.on("close", (code, signal) => {
			events.push("close");
			resolve({ code, signal, stdout, stderr, events });
		});
	});
}

function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitGone(pid: number): Promise<void> {
	const deadline = Date.now() + PROCESS_GONE_TIMEOUT_MS;
	while (running(pid) && Date.now() < deadline) await sleep(10);
}

/** The Windows start in a job of its own; it fails the test where it does not start the process. */
async function contained(
	file: string,
	args: readonly string[],
	options?: HostSpawnOptions,
): Promise<ContainedChildProcess> {
	const child = await spawnContainedProcess(file, args, options);
	assert.ok(child, "the process did not start in a job of its own");
	return child;
}

/** The native start (Linux), child_process, and on Windows the start in a job of its own, which must behave as both. */
const BACKENDS = ["native", "child-process", ...(process.platform === "win32" ? ["contained" as const] : [])] as const;

describe.each(BACKENDS)("host processes started through %s", (backend) => {
	let directory: string;
	const start = backend === "contained" ? contained : spawnHostProcess;
	beforeEach(() => {
		if (backend === "child-process") vi.stubEnv(HOST_SPAWN_ENV, "child-process");
		else vi.stubEnv(HOST_SPAWN_ENV, undefined);
		directory = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-host-spawn-")));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	test.skipIf(backend === "contained")("starts where this platform starts host processes", () => {
		assert.equal(
			hostSpawnBackend(),
			backend === "native" && process.platform === "linux" ? "native" : "child-process",
		);
	});

	test("delivers input, output, the exit code and the events in child_process's order", async () => {
		const child = await start(node, [
			"-e",
			"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(s.toUpperCase());process.stderr.write('err');process.exit(3)})",
		]);
		assert.equal(typeof child.pid, "number");
		const result = ended(child);
		child.stdin?.end("hello from the host");
		assert.deepEqual(await result, {
			code: 3,
			signal: null,
			stdout: "HELLO FROM THE HOST",
			stderr: "err",
			events: ["spawn", "exit", "close"],
		});
		assert.equal(child.exitCode, 3);
	});

	test("runs in the directory and with exactly the environment it is given", async () => {
		const child = await start(
			node,
			["-e", "process.stdout.write(JSON.stringify([process.cwd(), process.env.ATOMIC_PROBE, process.env.HOME]))"],
			{ cwd: directory, env: { ATOMIC_PROBE: "probe", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } },
		);
		const result = await ended(child);
		assert.deepEqual(JSON.parse(result.stdout), [directory, "probe", null]);
	});

	test("a program that is missing fails with child_process's ENOENT error, then closes", async () => {
		const missing = join(directory, "atomic-no-such-program");
		const child = await start(missing, ["--flag"]);
		const errors: NodeJS.ErrnoException[] = [];
		child.on("error", (error: NodeJS.ErrnoException) => errors.push(error));
		const result = await ended(child);
		assert.deepEqual(result.events, ["error ENOENT", "close"]);
		assert.equal(errors[0]?.message, `spawn ${missing} ENOENT`);
		assert.equal(errors[0]?.errno, process.platform === "win32" ? -4058 : -2, "libuv's number for ENOENT");
		assert.equal(errors[0]?.syscall, `spawn ${missing}`);
		assert.equal(errors[0]?.path, missing);
		assert.equal(child.pid, undefined);
	});

	test("a working directory that is missing fails with ENOENT", async () => {
		const child = await start(node, ["-e", ""], { cwd: join(directory, "missing") });
		assert.ok((await ended(child)).events.includes("error ENOENT"));
	});

	test("kill ends the process with the signal, and closes with it", async () => {
		const child = await start(node, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"]);
		const result = ended(child);
		await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
		assert.equal(child.kill("SIGKILL"), true);
		assert.equal(child.killed, true);
		const { code, signal } = await result;
		// Windows has no signals; child_process reports the one it ended the process with all the same.
		assert.deepEqual({ code, signal }, { code: null, signal: "SIGKILL" });
		assert.equal(child.kill("SIGKILL"), false, "an ended process is not signalled again");
	});

	test("a process is reaped once its close was handled, and leaves no zombie", async () => {
		const child = await start(node, ["-e", "process.stdout.write('x')"]);
		await ended(child);
		await waitGone(child.pid!);
		assert.equal(running(child.pid!), false);
		assert.equal(child.kill("SIGKILL"), false, "a reaped process is not signalled");
	});

	test("ignored streams are null, and the process still runs to its end", async () => {
		const child = await start(node, ["-e", "process.stdout.write('lost');process.exit(5)"], { stdio: "ignore" });
		assert.equal(child.stdin, null);
		assert.equal(child.stdout, null);
		const result = await ended(child);
		assert.equal(result.code, 5);
	});

	test.skipIf(process.platform === "win32")(
		"a detached process leads its own process group, which one signal ends with its children",
		async () => {
			const child = await start(
				node,
				[
					"-e",
					"const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid));setInterval(()=>{},1000)",
				],
				{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
			);
			const result = ended(child);
			const grandchild = await new Promise<number>((resolve) =>
				child.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString("utf8")))),
			);
			process.kill(-child.pid!, "SIGKILL");
			assert.equal((await result).signal, "SIGKILL");
			await waitGone(grandchild);
			assert.equal(running(grandchild), false, "the child the process started was in its group");
		},
	);

	test("output larger than a pipe's buffer arrives whole, while input is still being written", async () => {
		const bytes = 4 * 1024 * 1024;
		const child = await start(node, ["-e", "process.stdin.pipe(process.stdout)"]);
		const result = ended(child);
		child.stdin?.end(Buffer.alloc(bytes, "x"));
		const { stdout, code } = await result;
		assert.equal(code, 0);
		assert.equal(stdout.length, bytes);
	});
});

test.skipIf(process.platform !== "linux")(
	"a native host process stays unreaped until its close was handled, so a signal to its group reaches only what it started (#5345)",
	async () => {
		vi.stubEnv(HOST_SPAWN_ENV, undefined);
		try {
			// The process starts a grandchild in its own group that keeps the output open, then exits.
			const child = spawnHostProcess(
				node,
				[
					"-e",
					"const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','ignore']});process.stdout.write(String(c.pid)+'\\n');process.exit(0)",
				],
				{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
			);
			const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
			const closed = ended(child);
			const grandchild = await new Promise<number>((resolve) =>
				child.stdout?.once("data", (chunk: Buffer) => resolve(Number.parseInt(chunk.toString("utf8"), 10))),
			);
			await exited;
			assert.equal(running(child.pid!), true, "the exited process is not reaped while its output is still open");
			process.kill(-child.pid!, "SIGKILL");
			await closed;
			await waitGone(grandchild);
			assert.equal(running(grandchild), false);
			await waitGone(child.pid!);
			assert.equal(running(child.pid!), false, "the process is reaped once its close was handled");
		} finally {
			vi.unstubAllEnvs();
		}
	},
);

describe("where host processes start", () => {
	test("natively only on Linux with the native start, unless child_process is asked for", () => {
		const platforms: readonly NodeJS.Platform[] = ["linux", "darwin", "win32", "freebsd", "android"];
		for (const platform of platforms) {
			for (const nativeAvailable of [true, false]) {
				for (const override of [undefined, "child-process", "native", ""]) {
					assert.equal(
						chooseHostSpawnBackend({ platform, nativeAvailable, override }),
						platform === "linux" && nativeAvailable && override !== "child-process" ? "native" : "child-process",
						JSON.stringify({ platform, nativeAvailable, override }),
					);
				}
			}
		}
	});
});

describe("a host process started in a job of its own", () => {
	const leftRunning: RecordedProcess[] = [];
	beforeEach(() => {
		vi.stubEnv(HOST_SPAWN_ENV, undefined);
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const recorded of leftRunning.splice(0)) await signalRecordedProcess(recorded);
	});

	/** A process that starts a program which outlives it, by itself for {@link LEFT_RUNNING_MS}, and then exits. */
	async function leavingAProgramRunning(): Promise<{ child: ContainedChildProcess; program: RecordedProcess }> {
		const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-contained-")));
		try {
			const pidFile = join(directory, "program.pid");
			const child = await contained(
				node,
				[
					"-e",
					`const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},${LEFT_RUNNING_MS})'],{stdio:'ignore',detached:true});c.unref();require('node:fs').writeFileSync(process.argv[1],String(c.pid))`,
					pidFile,
				],
				{ stdio: "ignore" },
			);
			const { code } = await ended(child);
			assert.equal(code, 0);
			const program = await recordProcess(Number(readFileSync(pidFile, "utf8")));
			leftRunning.push(program);
			assert.equal(await stillRuns(program), true, "the program the process started is running");
			return { child, program };
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}

	test("is started only on Windows, for a full program path and text child_process accepts, unless child_process is asked for", async () => {
		if (process.platform !== "win32") {
			assert.equal(await spawnContainedProcess(node, ["-e", ""]), undefined);
			return;
		}
		assert.equal(
			await spawnContainedProcess("node.exe", ["-e", ""]),
			undefined,
			"a program name is looked up as before",
		);
		assert.equal(await spawnContainedProcess(node, ["-e", "\0"]), undefined, "child_process reports a NUL itself");
		vi.stubEnv(HOST_SPAWN_ENV, "child-process");
		assert.equal(await spawnContainedProcess(node, ["-e", ""]), undefined);
	});

	test.runIf(process.platform === "win32")(
		"endTree ends what the process started, also once the process itself exited",
		async () => {
			const { child, program } = await leavingAProgramRunning();

			assert.equal(child.endTree(), true);

			assert.equal(await waitUntilGone(program, PROCESS_GONE_TIMEOUT_MS), true, "the program outlived endTree");
			child.releaseTree();
		},
	);

	test.runIf(process.platform === "win32")(
		"releaseTree lets what the process started run on, and endTree then ends nothing",
		async () => {
			const { child, program } = await leavingAProgramRunning();

			child.releaseTree();

			assert.equal(child.endTree(), false);
			assert.equal(await waitUntilGone(program, NOT_ENDED_MS), false, "the released program was ended");
		},
	);

	test.runIf(process.platform === "win32")(
		"a program can write to its own input, as under child_process",
		async () => {
			const script =
				"try{require('fs').writeSync(0,'abc');process.stdout.write('wrote')}catch(e){process.stdout.write(e.code)}";
			const expected = await ended(spawn(node, ["-e", script], { windowsHide: true }));
			const actual = await ended(await contained(node, ["-e", script]));
			assert.equal(expected.stdout, "wrote");
			assert.equal(actual.stdout, "wrote");
		},
	);

	test.runIf(process.platform === "win32")(
		"a process whose output nobody reads closes after its exit, as under child_process",
		async () => {
			const child = await contained(node, ["-e", "process.stdout.write('out');process.stderr.write('err')"]);
			const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
			assert.equal(await Promise.race([closed, sleep(CLOSE_TIMEOUT_MS).then(() => "no close")]), 0);
		},
	);

	test.runIf(process.platform === "win32")(
		"a file that is not a program fails as child_process.spawn throws for it",
		async () => {
			const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-contained-")));
			try {
				const file = join(directory, "not-a-program.exe");
				writeFileSync(file, "not a program");
				const fields = (error: NodeJS.ErrnoException) => [error.message, error.code, error.errno, error.syscall];
				let expected: NodeJS.ErrnoException | undefined;
				try {
					spawn(file, [], { windowsHide: true });
				} catch (error) {
					expected = error as NodeJS.ErrnoException;
				}
				assert.ok(expected, "child_process.spawn threw");
				const actual = await spawnContainedProcess(file, []).then(
					() => undefined,
					(error: NodeJS.ErrnoException) => error,
				);
				assert.ok(actual, "the contained start threw");
				assert.deepEqual(fields(actual), fields(expected));
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	test.runIf(process.platform === "win32")(
		"gives a program the command line, environment and directory child_process gives it",
		async () => {
			const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-contained-")));
			try {
				const args = [
					"-e",
					"process.stdout.write(JSON.stringify([process.argv.slice(1), process.cwd(), Object.keys(process.env).filter((key) => key.toUpperCase().startsWith('ATOMIC_PROBE')), process.env.ATOMIC_PROBE, process.env.ATOMIC_PROBE_EMPTY, process.env.USERPROFILE, process.env.TEMP]))",
					"a b",
					'c"d',
					"e\\",
					'f\\"g',
					"",
					"h\tj",
					"k\\\\l",
					"plain",
					"\u00fc \u2713",
				];
				const env = {
					PATH: process.env.PATH,
					SystemRoot: process.env.SystemRoot,
					ATOMIC_PROBE: 'x "y" z',
					atomic_probe: "the other case",
					ATOMIC_PROBE_EMPTY: "",
				};
				const expected = await ended(spawn(node, args, { cwd: directory, env, windowsHide: true }));
				const actual = await ended(await contained(node, args, { cwd: directory, env }));
				assert.equal(expected.code, 0, expected.stderr);
				assert.equal(actual.stdout, expected.stdout);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});
