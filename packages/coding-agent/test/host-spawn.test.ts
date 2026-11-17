import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { sleep } from "../../../test/helpers/runtime.js";
import {
	chooseHostSpawnBackend,
	HOST_SPAWN_ENV,
	type HostChildProcess,
	type HostSpawnBackend,
	hostSpawnBackend,
	spawnHostProcess,
} from "../src/utils/host-spawn.ts";

const node = process.execPath;

/** How long a test waits for a process it ended to be gone, before failing. */
const PROCESS_GONE_TIMEOUT_MS = 10_000;

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

const BACKENDS: readonly HostSpawnBackend[] = ["native", "child-process"];

describe.each(BACKENDS)("host processes started through %s", (backend) => {
	let directory: string;
	beforeEach(() => {
		if (backend === "child-process") vi.stubEnv(HOST_SPAWN_ENV, "child-process");
		else vi.stubEnv(HOST_SPAWN_ENV, undefined);
		directory = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-host-spawn-")));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	test("starts where this platform starts host processes", () => {
		assert.equal(
			hostSpawnBackend(),
			backend === "native" && process.platform === "linux" ? "native" : "child-process",
		);
	});

	test("delivers input, output, the exit code and the events in child_process's order", async () => {
		const child = spawnHostProcess(node, [
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
		const child = spawnHostProcess(
			node,
			["-e", "process.stdout.write(JSON.stringify([process.cwd(), process.env.ATOMIC_PROBE, process.env.HOME]))"],
			{ cwd: directory, env: { ATOMIC_PROBE: "probe", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } },
		);
		const result = await ended(child);
		assert.deepEqual(JSON.parse(result.stdout), [directory, "probe", null]);
	});

	test("a program that is missing fails with child_process's ENOENT error, then closes", async () => {
		const missing = join(directory, "atomic-no-such-program");
		const child = spawnHostProcess(missing, ["--flag"]);
		const errors: NodeJS.ErrnoException[] = [];
		child.on("error", (error: NodeJS.ErrnoException) => errors.push(error));
		const result = await ended(child);
		assert.deepEqual(result.events, ["error ENOENT", "close"]);
		assert.equal(errors[0]?.message, `spawn ${missing} ENOENT`);
		assert.equal(errors[0]?.syscall, `spawn ${missing}`);
		assert.equal(errors[0]?.path, missing);
		assert.equal(child.pid, undefined);
	});

	test("a working directory that is missing fails with ENOENT", async () => {
		const child = spawnHostProcess(node, ["-e", ""], { cwd: join(directory, "missing") });
		assert.ok((await ended(child)).events.includes("error ENOENT"));
	});

	test("kill ends the process with the signal, and closes with it", async () => {
		const child = spawnHostProcess(node, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"]);
		const result = ended(child);
		await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
		assert.equal(child.kill("SIGKILL"), true);
		assert.equal(child.killed, true);
		const { code, signal } = await result;
		assert.deepEqual(
			{ code, signal },
			process.platform === "win32" ? { code: 1, signal: null } : { code: null, signal: "SIGKILL" },
		);
		assert.equal(child.kill("SIGKILL"), false, "an ended process is not signalled again");
	});

	test("ignored streams are null, and the process still runs to its end", async () => {
		const child = spawnHostProcess(node, ["-e", "process.stdout.write('lost');process.exit(5)"], { stdio: "ignore" });
		assert.equal(child.stdin, null);
		assert.equal(child.stdout, null);
		const result = await ended(child);
		assert.equal(result.code, 5);
	});

	test.skipIf(process.platform === "win32")(
		"a detached process leads its own process group, which one signal ends with its children",
		async () => {
			const child = spawnHostProcess(
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
		const child = spawnHostProcess(node, ["-e", "process.stdin.pipe(process.stdout)"]);
		const result = ended(child);
		child.stdin?.end(Buffer.alloc(bytes, "x"));
		const { stdout, code } = await result;
		assert.equal(code, 0);
		assert.equal(stdout.length, bytes);
	});
});

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
