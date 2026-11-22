import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, it, vi } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	waitUntilGone,
} from "../../../../test/helpers/recorded-process.js";

const CLOSE_BOUND_MS = 10_000;
const PROCESS_EXIT_BUDGET_MS = 5_000;

interface SpawnCall {
	readonly command: string;
	readonly args: readonly string[];
	readonly options: SpawnOptions;
}

interface VirtualWindowsFs {
	readonly dirs: Set<string>;
	readonly realpaths: Map<string, string>;
	readonly symlinks: Set<string>;
}

const hooks = vi.hoisted(() => ({
	spawnCalls: [] as SpawnCall[],
	spawnOverride: undefined as
		| ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess)
		| undefined,
	crossSpawnOverride: undefined as
		| ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess)
		| undefined,
	virtualFs: undefined as VirtualWindowsFs | undefined,
	tmpdirOverride: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const stat = (async (path: Parameters<typeof actual.stat>[0]) => {
		const vfs = hooks.virtualFs;
		if (!vfs) return actual.stat(path);
		const key = String(path);
		if (vfs.dirs.has(key)) return { isDirectory: () => true } as Stats;
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	}) as typeof actual.stat;
	const lstat = (async (path: Parameters<typeof actual.lstat>[0]) => {
		const vfs = hooks.virtualFs;
		if (!vfs) return actual.lstat(path);
		const key = String(path);
		if (vfs.symlinks.has(key)) return { isDirectory: () => false, isSymbolicLink: () => true } as Stats;
		if (vfs.dirs.has(key)) return { isDirectory: () => true, isSymbolicLink: () => false } as Stats;
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	}) as typeof actual.lstat;
	const realpath = (async (path: Parameters<typeof actual.realpath>[0]) => {
		const vfs = hooks.virtualFs;
		if (!vfs) return actual.realpath(path);
		const key = String(path);
		const mapped = vfs.realpaths.get(key);
		if (mapped !== undefined) return mapped;
		if (vfs.dirs.has(key)) return key;
		throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
	}) as typeof actual.realpath;
	return { ...actual, stat, lstat, realpath, default: { ...actual, stat, lstat, realpath } };
});

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const tmpdir = () => hooks.tmpdirOverride ?? actual.tmpdir();
	return { ...actual, tmpdir, default: { ...actual, tmpdir } };
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, options?: SpawnOptions) => {
		const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
		const spawnOptions = (Array.isArray(argsOrOptions) ? options : argsOrOptions) ?? {};
		hooks.spawnCalls.push({ command, args, options: spawnOptions });
		if (hooks.spawnOverride) return hooks.spawnOverride(command, args, spawnOptions);
		return actual.spawn(command, args, spawnOptions);
	}) as typeof actual.spawn;
	return { ...actual, spawn, default: { ...actual, spawn } };
});

vi.mock("cross-spawn", async (importOriginal) => {
	const actual = await importOriginal<typeof import("cross-spawn")>();
	const crossSpawn = ((command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
		if (hooks.crossSpawnOverride) return hooks.crossSpawnOverride(command, args, options);
		return actual.default(command, args, options);
	}) as typeof actual.default;
	return { ...actual, default: crossSpawn };
});

interface FakeChild extends EventEmitter {
	pid: number;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough;
	kill: (signal?: NodeJS.Signals | number) => boolean;
}

function createFakeChild(options?: {
	onStdinEnd?: (child: FakeChild) => void;
	onKill?: (child: FakeChild, signal: NodeJS.Signals | number | undefined) => void;
}): FakeChild {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const child = Object.assign(new EventEmitter(), {
		pid: 42_424,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		stdin,
		stdout,
		stderr,
		kill(signal?: NodeJS.Signals | number): boolean {
			options?.onKill?.(child, signal);
			return true;
		},
	});
	stdin.on("finish", () => options?.onStdinEnd?.(child));
	return child;
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalCwd = process.cwd;
const savedSystemRoot = process.env.SystemRoot;
const savedWindir = process.env.windir;
const recordedServers: RecordedProcess[] = [];

async function importWindowsStdioTransport() {
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	vi.resetModules();
	const { StdioTransport } = await import("../../src/extensions/mcp/client/transports/stdio.js");
	return StdioTransport;
}

afterEach(async () => {
	vi.useRealTimers();
	hooks.spawnCalls.length = 0;
	hooks.spawnOverride = undefined;
	hooks.crossSpawnOverride = undefined;
	hooks.virtualFs = undefined;
	hooks.tmpdirOverride = undefined;
	Object.defineProperty(process, "platform", originalPlatform);
	process.cwd = originalCwd;
	if (savedSystemRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = savedSystemRoot;
	if (savedWindir === undefined) delete process.env.windir;
	else process.env.windir = savedWindir;
	vi.resetModules();
	for (const server of recordedServers.splice(0)) {
		await signalRecordedProcess(server);
		await waitUntilGone(server, PROCESS_EXIT_BUDGET_MS);
	}
});

describe("StdioTransport Windows killProcessTree failure and bound handling", () => {
	it("handles a synchronous spawn throw without unhandled rejection, falls back to child.kill, and does not wait closeTimeoutMs", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);

		const killSignals: Array<NodeJS.Signals | number | undefined> = [];
		const fakeChild = createFakeChild({
			onKill(child, signal) {
				killSignals.push(signal);
				child.exitCode = 1;
				child.emit("close", 1, null);
			},
		});
		hooks.crossSpawnOverride = () => {
			process.nextTick(() => fakeChild.emit("spawn"));
			return fakeChild as unknown as ChildProcess;
		};
		hooks.spawnOverride = () => {
			throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
		};

		const StdioTransport = await importWindowsStdioTransport();
		const transport = new StdioTransport({ command: process.execPath, closeTimeoutMs: CLOSE_BOUND_MS });
		await transport.start();

		vi.useFakeTimers();
		const realSetTimeout = globalThis.setTimeout;
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		let closedEventFired = false;
		const delaysAfterClose: number[] = [];
		transport.onClose(() => {
			closedEventFired = true;
		});
		setTimeoutSpy.mockImplementation(((...args: Parameters<typeof setTimeout>) => {
			if (closedEventFired) delaysAfterClose.push(Number(args[1]));
			return realSetTimeout(...args);
		}) as typeof setTimeout);

		try {
			let resolved = false;
			const closing = transport.close().then(() => {
				resolved = true;
			});

			// Advance past the 500ms stdin grace period only, well below CLOSE_BOUND_MS (10s).
			await vi.advanceTimersByTimeAsync(500);

			assert.deepEqual(rejections, [], "produced no unhandled promise rejection");
			assert.equal(hooks.spawnCalls.length, 1, "attempted to spawn taskkill.exe");
			assert.deepEqual(killSignals, ["SIGTERM"], "fell back to killing the child handle");
			assert.equal(resolved, true, "close() resolved without waiting for closeTimeoutMs");
			await closing;
			assert.deepEqual(delaysAfterClose, [], "allocated no close-bound timer when spawn threw synchronously");
		} finally {
			setTimeoutSpy.mockRestore();
			process.off("unhandledRejection", onRejection);
		}
	});

	it("falls back to child.kill and finishes promptly when taskkill emits an async spawn error", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);

		const killSignals: Array<NodeJS.Signals | number | undefined> = [];
		const fakeChild = createFakeChild({
			onKill(child, signal) {
				killSignals.push(signal);
				child.exitCode = 1;
				child.emit("close", 1, null);
			},
		});
		hooks.crossSpawnOverride = () => {
			process.nextTick(() => fakeChild.emit("spawn"));
			return fakeChild as unknown as ChildProcess;
		};
		hooks.spawnOverride = () => {
			const helper = new EventEmitter();
			process.nextTick(() => helper.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
			return helper as unknown as ChildProcess;
		};

		const StdioTransport = await importWindowsStdioTransport();
		const transport = new StdioTransport({ command: process.execPath, closeTimeoutMs: CLOSE_BOUND_MS });
		await transport.start();

		vi.useFakeTimers();
		try {
			let resolved = false;
			const closing = transport.close().then(() => {
				resolved = true;
			});

			await vi.advanceTimersByTimeAsync(500);

			assert.deepEqual(rejections, []);
			assert.deepEqual(killSignals, ["SIGTERM"]);
			assert.equal(resolved, true);
			await closing;
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});

	it("allocates no close-bound timer on Windows when a cooperative server exits on stdin EOF", async () => {
		const fakeChild = createFakeChild({
			onStdinEnd(child) {
				child.exitCode = 0;
				child.emit("close", 0, null);
			},
		});
		hooks.crossSpawnOverride = () => {
			process.nextTick(() => fakeChild.emit("spawn"));
			return fakeChild as unknown as ChildProcess;
		};

		const StdioTransport = await importWindowsStdioTransport();
		const transport = new StdioTransport({ command: process.execPath, closeTimeoutMs: CLOSE_BOUND_MS });
		await transport.start();

		const realSetTimeout = globalThis.setTimeout;
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		let closedEventFired = false;
		const delaysAfterClose: number[] = [];
		transport.onClose(() => {
			closedEventFired = true;
		});
		setTimeoutSpy.mockImplementation(((...args: Parameters<typeof setTimeout>) => {
			if (closedEventFired) delaysAfterClose.push(Number(args[1]));
			return realSetTimeout(...args);
		}) as typeof setTimeout);

		try {
			await transport.close();

			assert.equal(closedEventFired, true);
			assert.equal(hooks.spawnCalls.length, 0, "cooperative close started no kill helper");
			assert.deepEqual(delaysAfterClose, [], "cooperative close allocated no close-bound timer");
		} finally {
			setTimeoutSpy.mockRestore();
		}
	});

	it("waits for a running Windows kill helper until it exits and clears the close bound", async () => {
		const fakeChild = createFakeChild();
		const helper = new EventEmitter();
		hooks.crossSpawnOverride = () => {
			process.nextTick(() => fakeChild.emit("spawn"));
			return fakeChild as unknown as ChildProcess;
		};
		hooks.spawnOverride = () => {
			// Server closes while taskkill is still running.
			setTimeout(() => {
				fakeChild.exitCode = 1;
				fakeChild.emit("close", 1, null);
			}, 20);
			return helper as unknown as ChildProcess;
		};

		const StdioTransport = await importWindowsStdioTransport();
		const transport = new StdioTransport({ command: process.execPath, closeTimeoutMs: CLOSE_BOUND_MS });
		await transport.start();

		vi.useFakeTimers();
		let resolved = false;
		const closing = transport.close().then(() => {
			resolved = true;
		});

		await vi.advanceTimersByTimeAsync(600);
		assert.equal(resolved, false, "waits while taskkill is still running");

		helper.emit("exit", 0, null);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(resolved, true, "resolves as soon as taskkill exits");
		await closing;
	});

	it("bounds waiting on a hung Windows kill helper to closeTimeoutMs", async () => {
		const fakeChild = createFakeChild();
		const helper = new EventEmitter();
		hooks.crossSpawnOverride = () => {
			process.nextTick(() => fakeChild.emit("spawn"));
			return fakeChild as unknown as ChildProcess;
		};
		hooks.spawnOverride = () => {
			setTimeout(() => {
				fakeChild.exitCode = 1;
				fakeChild.emit("close", 1, null);
			}, 10);
			return helper as unknown as ChildProcess;
		};

		const StdioTransport = await importWindowsStdioTransport();
		const transport = new StdioTransport({ command: process.execPath, closeTimeoutMs: CLOSE_BOUND_MS });
		await transport.start();

		vi.useFakeTimers();
		let resolved = false;
		const closing = transport.close().then(() => {
			resolved = true;
		});

		await vi.advanceTimersByTimeAsync(500 + 10 + CLOSE_BOUND_MS - 1);
		assert.equal(resolved, false);

		await vi.advanceTimersByTimeAsync(1);
		assert.equal(resolved, true);
		await closing;
	});

	it("never runs taskkill inside an external junction pointing into the project folder", async () => {
		const fakeChild = createFakeChild();
		hooks.crossSpawnOverride = () => {
			process.nextTick(() => fakeChild.emit("spawn"));
			return fakeChild as unknown as ChildProcess;
		};
		hooks.spawnOverride = () => {
			const helper = new EventEmitter();
			queueMicrotask(() => {
				fakeChild.exitCode = 1;
				fakeChild.emit("close", 1, null);
				helper.emit("exit", 0, null);
			});
			return helper as unknown as ChildProcess;
		};
		hooks.virtualFs = {
			dirs: new Set(["C:\\repo\\project", "C:\\temp\\win-junc", "C:\\Windows"]),
			symlinks: new Set(["C:\\temp\\win-junc"]),
			realpaths: new Map([
				["C:\\repo\\project", "C:\\repo\\project"],
				["C:\\temp\\win-junc", "C:\\repo\\project\\fake-win"],
				["C:\\Windows", "C:\\Windows"],
			]),
		};
		hooks.tmpdirOverride = "C:\\Users\\tester\\AppData\\Local\\Temp";
		process.cwd = () => "C:\\repo\\project";
		process.env.SystemRoot = "C:\\temp\\win-junc";
		process.env.windir = "C:\\temp\\win-junc";

		const StdioTransport = await importWindowsStdioTransport();
		const transport = new StdioTransport({
			command: "C:\\Tools\\node.exe",
			cwd: "C:\\repo\\project",
			projectCwd: "C:\\repo\\project",
			closeTimeoutMs: 50,
		});
		await transport.start();
		await transport.close();

		assert.equal(hooks.spawnCalls.length, 1);
		assert.equal(hooks.spawnCalls[0]!.options.cwd, "C:\\Windows");
	});

	it("refreshes the taskkill working directory when process.cwd() or SystemRoot changes between start() and close()", async () => {
		const fakeChild = createFakeChild();
		hooks.crossSpawnOverride = () => {
			process.nextTick(() => fakeChild.emit("spawn"));
			return fakeChild as unknown as ChildProcess;
		};
		hooks.spawnOverride = () => {
			const helper = new EventEmitter();
			queueMicrotask(() => {
				fakeChild.exitCode = 1;
				fakeChild.emit("close", 1, null);
				helper.emit("exit", 0, null);
			});
			return helper as unknown as ChildProcess;
		};
		hooks.virtualFs = {
			dirs: new Set(["C:\\repo\\project", "D:\\AltWindows", "C:\\Windows"]),
			symlinks: new Set(),
			realpaths: new Map([
				["C:\\repo\\project", "C:\\repo\\project"],
				["D:\\AltWindows", "D:\\AltWindows"],
				["C:\\Windows", "C:\\Windows"],
			]),
		};
		hooks.tmpdirOverride = "C:\\Users\\tester\\AppData\\Local\\Temp";
		process.cwd = () => "C:\\repo\\project";
		process.env.SystemRoot = "D:\\AltWindows";
		process.env.windir = "D:\\AltWindows";

		const StdioTransport = await importWindowsStdioTransport();
		const transport = new StdioTransport({
			command: "C:\\Tools\\node.exe",
			cwd: "C:\\repo\\project",
			projectCwd: "C:\\repo\\project",
			closeTimeoutMs: 50,
		});
		await transport.start();

		// Move process.cwd() into D:\AltWindows before closing so the cached D:\AltWindows is now the project folder!
		process.cwd = () => "D:\\AltWindows";
		await transport.close();

		assert.equal(hooks.spawnCalls.length, 1);
		assert.equal(hooks.spawnCalls[0]!.options.cwd, "C:\\Windows");
	});

	it("falls back to cwd drive root and avoids both process.cwd() and projectCwd for taskkill", async () => {
		const fakeChild = createFakeChild();
		hooks.crossSpawnOverride = () => {
			process.nextTick(() => fakeChild.emit("spawn"));
			return fakeChild as unknown as ChildProcess;
		};
		hooks.spawnOverride = () => {
			const helper = new EventEmitter();
			queueMicrotask(() => {
				fakeChild.exitCode = 1;
				fakeChild.emit("close", 1, null);
				helper.emit("exit", 0, null);
			});
			return helper as unknown as ChildProcess;
		};
		hooks.virtualFs = {
			dirs: new Set(["D:\\other", "D:\\proj", "D:\\proj\\fake-win", "D:\\"]),
			symlinks: new Set(),
			realpaths: new Map([
				["D:\\other", "D:\\other"],
				["D:\\proj", "D:\\proj"],
				["D:\\proj\\fake-win", "D:\\proj\\fake-win"],
				["D:\\", "D:\\"],
			]),
		};
		hooks.tmpdirOverride = "relative-tmp";
		process.cwd = () => "D:\\other";
		process.env.SystemRoot = "D:\\proj\\fake-win";
		process.env.windir = "D:\\proj\\fake-win";

		const StdioTransport = await importWindowsStdioTransport();
		const transport = new StdioTransport({
			command: "C:\\Tools\\node.exe",
			cwd: "D:\\proj",
			projectCwd: "D:\\proj",
			closeTimeoutMs: 50,
		});
		await transport.start();
		await transport.close();

		assert.equal(hooks.spawnCalls.length, 1);
		assert.equal(hooks.spawnCalls[0]!.options.cwd, "D:\\");
	});

	it.skipIf(process.platform !== "win32")(
		"kills a real stubborn Windows server via its handle and finishes promptly when taskkill spawn throws synchronously",
		async () => {
			const rejections: unknown[] = [];
			const onRejection = (reason: unknown) => rejections.push(reason);
			process.on("unhandledRejection", onRejection);

			hooks.spawnOverride = (command) => {
				if (command.toLowerCase().endsWith("taskkill.exe")) {
					throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
				}
				throw new Error(`unexpected spawn: ${command}`);
			};

			const { StdioTransport } = await import("../../src/extensions/mcp/client/transports/stdio.js");
			const transport = new StdioTransport({
				command: process.execPath,
				args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"],
				closeTimeoutMs: CLOSE_BOUND_MS,
			});

			try {
				await transport.start();
				assert.ok(transport.pid !== undefined);
				const server = await recordProcess(transport.pid);
				recordedServers.push(server);

				const startedAt = Date.now();
				await transport.close();
				const elapsedMs = Date.now() - startedAt;

				assert.ok(
					elapsedMs < CLOSE_BOUND_MS / 2,
					`close() took ${elapsedMs}ms (should not wait for closeTimeoutMs=${CLOSE_BOUND_MS})`,
				);
				assert.equal(await waitUntilGone(server, PROCESS_EXIT_BUDGET_MS), true, "server was killed via handle");
				assert.deepEqual(rejections, [], "no unhandled promise rejections");
			} finally {
				process.off("unhandledRejection", onRejection);
			}
		},
	);
});
