import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, type SpawnOptions } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	waitUntilGone,
} from "../../../test/helpers/recorded-process.js";

const windows = process.platform === "win32";

/** Where Linux and macOS keep bash: hidden by the first test, which looks for a shell where no bash is installed there. */
const hiddenPaths = vi.hoisted(() => new Set<string>());
/** Folders whose real path is read without an answer, as on a network share that stopped responding. */
const heldRealpaths = vi.hoisted(() => new Set<string>());
/** Every process started through `node:child_process` while a test ran, and the folder it started in. */
const startedProcesses = vi.hoisted(() => [] as { child: ChildProcess; cwd: string }[]);
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, options?: SpawnOptions) => {
		const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
		const spawnOptions = (Array.isArray(argsOrOptions) ? options : argsOrOptions) ?? {};
		const child = actual.spawn(command, args, spawnOptions);
		startedProcesses.push({ child, cwd: resolve(String(spawnOptions.cwd ?? process.cwd())) });
		return child;
	}) as typeof actual.spawn;
	return { ...actual, spawn, default: { ...actual, spawn } };
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const accessSync: typeof actual.accessSync = (path, mode) => {
		if (hiddenPaths.has(String(path))) throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: "ENOENT" });
		return actual.accessSync(path, mode);
	};
	return { ...actual, accessSync, default: { ...actual, accessSync } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const access: typeof actual.access = (path, mode) =>
		hiddenPaths.has(String(path))
			? Promise.reject(Object.assign(new Error(`ENOENT: ${String(path)}`), { code: "ENOENT" }))
			: actual.access(path, mode);
	const realpath = ((path: string, options?: BufferEncoding) =>
		heldRealpaths.has(String(path))
			? new Promise(() => {})
			: actual.realpath(path, options)) as typeof actual.realpath;
	return { ...actual, access, realpath, default: { ...actual, access, realpath } };
});

/**
 * A program named `name` in `directory` that records each run in `marker`: elsewhere a shell script; on Windows a copy of
 * this Node, which a run shows by its successful start.
 */
function plantProgram(directory: string, name: string): string {
	if (windows) {
		const file = join(directory, `${name}.exe`);
		try {
			linkSync(process.execPath, file);
		} catch {
			copyFileSync(process.execPath, file);
		}
		return file;
	}
	const file = join(directory, name);
	writeFileSync(file, '#!/bin/sh\necho "$0" >> "$PLANTED_PROGRAM_MARKER"\nsleep 5\n');
	chmodSync(file, 0o755);
	return file;
}

/** How long a started server may take to record its run on a loaded machine. */
const SERVER_START_BUDGET_MS = 20_000;
/** Longer than an ended process, or a command that ends one, takes to exit on a loaded machine. */
const PROCESS_EXIT_BUDGET_MS = 10_000;
/** The cleanup's waits for the processes a test left, at their deadlines. */
const CLEANUP_TIMEOUT_MS = 3 * PROCESS_EXIT_BUDGET_MS;

/** The servers a test started, ended and waited for before its folders are removed. */
const servers: RecordedProcess[] = [];

/** Whether `child` has exited, or never started, within `timeoutMs`. */
function exitedWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((done) => {
		const timer = setTimeout(() => done(false), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			done(true);
		});
	});
}

/** Whether `path` is `folder` or inside it; Windows compares real paths in any letter case. */
function isInside(folder: string, path: string): boolean {
	let targetFolder = folder;
	let targetPath = path;
	if (windows) {
		try {
			targetFolder = realpathSync.native(folder);
		} catch {}
		try {
			targetPath = realpathSync.native(path);
		} catch {}
	}
	const fromFolder = relative(
		windows ? targetFolder.toLowerCase() : targetFolder,
		windows ? targetPath.toLowerCase() : targetPath,
	);
	return (
		fromFolder !== ".." && !fromFolder.startsWith("..\\") && !fromFolder.startsWith("../") && !isAbsolute(fromFolder)
	);
}

let root: string;
let project: string;
let marker: string;
let previousCwd: string;

function runs(): string[] {
	return existsSync(marker) ? readFileSync(marker, "utf8").split(/\r?\n/).filter(Boolean) : [];
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-planted-shell-"));
	project = join(root, "project");
	const emptyBin = join(root, "empty-bin");
	mkdirSync(project);
	mkdirSync(emptyBin);
	marker = join(root, "runs.txt");
	vi.stubEnv("PLANTED_PROGRAM_MARKER", marker);
	// Windows looks in the working directory before PATH; elsewhere an empty PATH entry names it.
	vi.stubEnv("PATH", windows ? emptyBin : `${delimiter}${emptyBin}`);
	previousCwd = process.cwd();
	process.chdir(project);
	vi.resetModules();
});

afterEach(async () => {
	process.chdir(previousCwd);
	hiddenPaths.clear();
	heldRealpaths.clear();
	vi.unstubAllEnvs();
	// A process still running in a folder keeps Windows from removing it: every server is ended and gone, and every
	// process started meanwhile has exited, before the folders go.
	for (const server of servers.splice(0)) {
		await signalRecordedProcess(server);
		assert.equal(await waitUntilGone(server, PROCESS_EXIT_BUDGET_MS), true, `server ${server.pid} outlived its test`);
	}
	for (const { child } of startedProcesses.splice(0)) {
		assert.equal(await exitedWithin(child, PROCESS_EXIT_BUDGET_MS), true, `${child.spawnfile} outlived its test`);
	}
	rmSync(root, { recursive: true, force: true });
}, CLEANUP_TIMEOUT_MS);

describe("shells and MCP servers Atomic starts by name come only from PATH, never from the project folder", () => {
	test.skipIf(windows)("without bash in /bin the bash tool's shell is never a sh in the project folder", async () => {
		hiddenPaths.add("/bin/bash");
		plantProgram(project, "sh");
		plantProgram(project, "bash");
		const { getShellConfig, getShellConfigAsync } = await import("../src/utils/shell.ts");

		for (const config of [getShellConfig(), await getShellConfigAsync()]) {
			assert.ok(isAbsolute(config.shell), config.shell);
			assert.ok(!config.shell.startsWith(project), config.shell);
		}
	});

	test.skipIf(!windows)(
		"the bash and PowerShell tools never take a bash or PowerShell from the project folder",
		async () => {
			vi.stubEnv("ProgramFiles", join(root, "no-program-files"));
			vi.stubEnv("ProgramFiles(x86)", join(root, "no-program-files"));
			for (const name of ["bash", "pwsh", "powershell"]) plantProgram(project, name);
			const { getPowerShellConfig, getPowerShellConfigAsync, getShellConfig, getShellConfigAsync } = await import(
				"../src/utils/shell.ts"
			);

			assert.throws(() => getShellConfig(), /No bash shell found/);
			await assert.rejects(getShellConfigAsync(), /No bash shell found/);
			for (const config of [getPowerShellConfig(), await getPowerShellConfigAsync()]) {
				assert.ok(!config.shell.toLowerCase().startsWith(project.toLowerCase()), config.shell);
			}
		},
	);

	test("an MCP server named by its program is never started from the project folder", async () => {
		plantProgram(project, "atomic-test-mcp-server");
		const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
		const transport = new StdioTransport({ command: "atomic-test-mcp-server", cwd: project, projectCwd: project });

		await assert.rejects(transport.start(), { code: "ENOENT" });
		await transport.close();
		assert.deepEqual(runs(), []);
	});

	test("the same MCP server program in a PATH directory starts", async () => {
		const bin = join(root, "bin");
		mkdirSync(bin);
		plantProgram(bin, "atomic-test-mcp-server");
		vi.stubEnv("PATH", windows ? bin : `${delimiter}${bin}`);
		const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
		const transport = new StdioTransport({
			command: "atomic-test-mcp-server",
			args: windows ? ["-e", "setTimeout(() => {}, 5000)"] : [],
			cwd: project,
			projectCwd: project,
		});

		await transport.start();
		assert.ok(transport.pid !== undefined);
		servers.push(await recordProcess(transport.pid));
		await transport.close();
	});

	test.skipIf(!windows)(
		"an MCP server's configured PATH chooses its program and is the PATH it gets, however either PATH is spelled",
		async () => {
			const inherited = join(root, "inherited");
			const configured = join(root, "configured");
			mkdirSync(inherited);
			mkdirSync(configured);
			plantProgram(inherited, "atomic-test-mcp-server");
			const expected = plantProgram(configured, "atomic-test-mcp-server");
			vi.stubEnv("PATH", inherited);
			const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
			const transport = new StdioTransport({
				command: "atomic-test-mcp-server",
				args: [
					"-e",
					'const { appendFileSync } = require("fs"); const { env, execPath } = process; appendFileSync(env.PLANTED_PROGRAM_MARKER, execPath + "\\n" + env.PATH + "\\n"); setTimeout(() => {}, 5000)',
				],
				cwd: project,
				projectCwd: project,
				// Sorted after the inherited `Path`, so without replacing it the program would get the inherited one.
				env: { path: configured },
			});

			await transport.start();
			servers.push(await recordProcess(transport.pid!));
			await vi.waitFor(() => assert.equal(runs().length, 2), { timeout: SERVER_START_BUDGET_MS });
			await transport.close();
			assert.deepEqual(runs(), [expected, configured]);
		},
	);

	test.skipIf(!windows)(
		"an MCP server whose folder is a link into the project folder never starts a program from there",
		async () => {
			const inside = join(project, "server");
			mkdirSync(inside);
			plantProgram(inside, "atomic-test-mcp-server");
			// Outside the project folder by its name, inside it by what it is.
			const link = join(root, "server-link");
			symlinkSync(inside, link, "junction");
			const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
			const transport = new StdioTransport({ command: "atomic-test-mcp-server", cwd: link, projectCwd: project });

			await assert.rejects(transport.start(), { code: "ENOENT" });
			await transport.close();
		},
	);

	test("an MCP server closed while its folder is compared with the project folder never starts", async () => {
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere);
		heldRealpaths.add(elsewhere);
		const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
		const { McpConnectionClosedError } = await import("../src/extensions/mcp/client/protocol/jsonrpc.ts");
		const transport = new StdioTransport({ command: "atomic-test-mcp-server", cwd: elsewhere, projectCwd: project });
		// The comparison is made where Windows would look in the server's folder first.
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		let started: Promise<void>;
		try {
			started = transport.start();
		} finally {
			Object.defineProperty(process, "platform", platform);
		}

		await transport.close();
		await assert.rejects(started, McpConnectionClosedError);
		assert.equal(transport.pid, undefined);
	});

	test("an MCP server closed before it started reports its close once", async () => {
		const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
		const transport = new StdioTransport({ command: "atomic-test-mcp-server", cwd: project, projectCwd: project });
		let closes = 0;
		transport.onClose(() => {
			closes++;
		});

		await transport.close();
		await transport.close();

		assert.equal(closes, 1);
		assert.equal(transport.pid, undefined);
	});

	for (const shape of [
		"named without an extension",
		"named with an extension PATHEXT gives it",
		"given by its path",
	] as const) {
		test.skipIf(!windows)(
			`an MCP server whose program is a script ${shape} runs through its interpreter, found as the program is`,
			async () => {
				const bin = join(root, "bin");
				mkdirSync(bin);
				const file = join(
					bin,
					shape === "named with an extension PATHEXT gives it"
						? "atomic-test-mcp-script.js"
						: "atomic-test-mcp-script",
				);
				writeFileSync(
					file,
					'#!/usr/bin/env node\nrequire("fs").appendFileSync(process.env.PLANTED_PROGRAM_MARKER, "script\\n"); setTimeout(() => {}, 5000);\n',
				);
				// An interpreter the project folder holds is never the one that runs the script.
				writeFileSync(join(project, "node.cmd"), "@echo planted>> %PLANTED_PROGRAM_MARKER%\r\n");
				vi.stubEnv("PATH", `${bin};${dirname(process.execPath)}`);
				vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD;.JS");
				const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
				const transport = new StdioTransport({
					command: shape === "given by its path" ? file : "atomic-test-mcp-script",
					cwd: project,
					projectCwd: project,
				});

				await transport.start();
				servers.push(await recordProcess(transport.pid!));
				await vi.waitFor(() => assert.deepEqual(runs(), ["script"]), { timeout: SERVER_START_BUDGET_MS });
				await transport.close();
				assert.deepEqual(runs(), ["script"]);
			},
		);
	}

	test.skipIf(!windows)(
		"an MCP server script given by its path finds its interpreter in the server's own folder outside the project first",
		async () => {
			// A portable layout: the script and the Node it needs, side by side, and no Node on PATH.
			const tools = join(root, "tools");
			mkdirSync(tools);
			plantProgram(tools, "node");
			const script = join(tools, "atomic-test-mcp-script");
			writeFileSync(
				script,
				'#!/usr/bin/env node\nrequire("fs").appendFileSync(process.env.PLANTED_PROGRAM_MARKER, "script\\n"); setTimeout(() => {}, 5000);\n',
			);
			const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
			const transport = new StdioTransport({ command: script, cwd: tools, projectCwd: project });

			await transport.start();
			servers.push(await recordProcess(transport.pid!));
			await vi.waitFor(() => assert.deepEqual(runs(), ["script"]), { timeout: SERVER_START_BUDGET_MS });
			await transport.close();
		},
	);

	test("an MCP server closed while its program is looked up never starts", async () => {
		const bin = join(root, "bin");
		mkdirSync(bin);
		plantProgram(bin, "atomic-test-mcp-server");
		vi.stubEnv("PATH", windows ? bin : `${delimiter}${bin}`);
		const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
		const transport = new StdioTransport({ command: "atomic-test-mcp-server", cwd: project, projectCwd: project });

		const started = transport.start();
		await transport.close();
		await assert.rejects(started);
		assert.equal(transport.pid, undefined);
		assert.deepEqual(runs(), []);
	});
});

// Windows keeps a folder in use while a process runs in it: a command started in the folder Atomic runs in, the
// project's, keeps it from being removed or renamed until that command exits.
describe.skipIf(!windows)("commands Atomic starts to end a process never run in the project folder", () => {
	test("closing an MCP server returns once the command that ended it has exited, and that command ran elsewhere", async () => {
		const bin = join(root, "bin");
		mkdirSync(bin);
		plantProgram(bin, "atomic-test-mcp-server");
		vi.stubEnv("PATH", bin);
		const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
		// A server that does not exit when its input closes: the close ends it. The close waits for the command that ends
		// it as long as the server is given to exit, set here past how long that command takes on a loaded machine.
		const transport = new StdioTransport({
			command: "atomic-test-mcp-server",
			args: ["-e", "setTimeout(() => {}, 5000)"],
			cwd: project,
			projectCwd: project,
			closeTimeoutMs: PROCESS_EXIT_BUDGET_MS,
		});
		await transport.start();
		servers.push(await recordProcess(transport.pid!));
		const before = startedProcesses.length;

		await transport.close();

		const commands = startedProcesses.slice(before);
		assert.ok(commands.length > 0, "the close started a command to end the server");
		for (const { child, cwd } of commands) {
			assert.ok(
				child.exitCode !== null || child.signalCode !== null,
				`${child.spawnfile} still runs after the close`,
			);
			assert.ok(!isInside(project, cwd), `${child.spawnfile} ran in the project folder`);
		}
	});

	test("ending a process tree runs its kill command outside the project folder", async () => {
		const { spawn } = await import("node:child_process");
		const { killProcessTree } = await import("../src/utils/shell.ts");
		const target = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
		assert.ok(target.pid !== undefined);
		servers.push(await recordProcess(target.pid));
		const before = startedProcesses.length;

		killProcessTree(target.pid);

		const commands = startedProcesses.slice(before);
		assert.equal(commands.length, 1, "one command ends the tree");
		assert.ok(!isInside(project, commands[0]!.cwd), `${commands[0]!.child.spawnfile} ran in the project folder`);
		assert.equal(await exitedWithin(target, PROCESS_EXIT_BUDGET_MS), true, "the tree was ended");
	});

	test("closing an MCP server never runs taskkill inside a junction pointing into the project folder", async () => {
		const realSystemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
		const realTaskkill = join(realSystemRoot, "System32", "taskkill.exe");
		const cmdExe = join(realSystemRoot, "System32", "cmd.exe");
		const bin = join(root, "bin");
		mkdirSync(bin);
		plantProgram(bin, "atomic-test-mcp-server");
		vi.stubEnv("PATH", bin);

		// Create a fake SystemRoot inside the project folder with a real taskkill.exe, then point an external
		// junction at it via `mklink /J` so its lexical path looks outside the project while its target is inside.
		const inProjectWin = join(project, "fake-win");
		mkdirSync(join(inProjectWin, "System32"), { recursive: true });
		copyFileSync(realTaskkill, join(inProjectWin, "System32", "taskkill.exe"));
		const externalJunction = join(root, "junc-win");
		execFileSync(cmdExe, ["/d", "/c", "mklink", "/J", externalJunction, inProjectWin], { windowsHide: true });

		const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
		const transport = new StdioTransport({
			command: "atomic-test-mcp-server",
			args: ["-e", "setTimeout(() => {}, 5000)"],
			cwd: project,
			projectCwd: project,
			closeTimeoutMs: PROCESS_EXIT_BUDGET_MS,
		});
		await transport.start();
		servers.push(await recordProcess(transport.pid!));

		// Point SystemRoot/windir at the junction after start() so close() must refresh and reject the junction.
		vi.stubEnv("SystemRoot", externalJunction);
		vi.stubEnv("windir", externalJunction);
		const before = startedProcesses.length;

		await transport.close();

		const commands = startedProcesses.slice(before);
		assert.ok(commands.length > 0, "the close started taskkill to end the server");
		for (const { child, cwd } of commands) {
			assert.ok(
				child.exitCode !== null || child.signalCode !== null,
				`${child.spawnfile} still runs after the close`,
			);
			assert.ok(!isInside(project, cwd), `${child.spawnfile} ran inside the project folder via junction (${cwd})`);
		}
	});

	test("ending a process tree still succeeds under cwd=Windows with missing/long/deleted TMP or a retargeted/deleted SystemRoot junction", async () => {
		const realSystemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
		const realSystem32 = join(realSystemRoot, "System32");
		const cmdExe = join(realSystem32, "cmd.exe");
		const { spawn } = await import("node:child_process");
		const { killProcessTree } = await import("../src/utils/shell.ts");

		const startLiveTarget = async (tag: string) => {
			const readyFile = join(root, `ready-${tag}.pid`);
			const child = spawn(
				process.execPath,
				[
					"-e",
					`require('fs').writeFileSync(${JSON.stringify(readyFile)}, String(process.pid)); setTimeout(() => {}, 15000)`,
				],
				{ stdio: "ignore", cwd: realSystemRoot, windowsHide: true },
			);
			assert.ok(child.pid !== undefined);
			servers.push(await recordProcess(child.pid));
			await vi.waitFor(() => assert.equal(existsSync(readyFile), true), { timeout: PROCESS_EXIT_BUDGET_MS });
			return child;
		};

		// 1. cwd = C:\Windows with nonexistent TMP (cold call must not pick nonexistent Z:\NoSuchTmp)
		process.chdir(realSystemRoot);
		vi.stubEnv("TMP", "Z:\\NoSuchAtomicTmp");
		vi.stubEnv("TEMP", "Z:\\NoSuchAtomicTmp");
		const t1 = await startLiveTarget("missing-tmp");
		killProcessTree(t1.pid!);
		assert.equal(await exitedWithin(t1, PROCESS_EXIT_BUDGET_MS), true, "killed under cwd=Windows + nonexistent TMP");

		// 2. cwd = C:\Windows with >260-char \\?\ TMP
		let longDir = join(root, "lp");
		for (let i = 0; i < 12; i++) longDir = join(longDir, `seg_${String(i).padStart(2, "0")}_1234567890123456`);
		const longExt = `\\\\?\\${longDir}`;
		mkdirSync(longExt, { recursive: true });
		vi.stubEnv("TMP", longExt);
		vi.stubEnv("TEMP", longExt);
		const t2 = await startLiveTarget("long-tmp");
		killProcessTree(t2.pid!);
		assert.equal(await exitedWithin(t2, PROCESS_EXIT_BUDGET_MS), true, "killed under cwd=Windows + long \\\\?\\ TMP");

		// 3. Ephemeral TMP deleted between two killProcessTree calls
		const ephemeralTmp = join(root, "ephemeral-tmp");
		mkdirSync(ephemeralTmp, { recursive: true });
		vi.stubEnv("TMP", ephemeralTmp);
		vi.stubEnv("TEMP", ephemeralTmp);
		const t3a = await startLiveTarget("ephem-1");
		killProcessTree(t3a.pid!);
		assert.equal(await exitedWithin(t3a, PROCESS_EXIT_BUDGET_MS), true);
		rmSync(ephemeralTmp, { recursive: true, force: true });
		const t3b = await startLiveTarget("ephem-2");
		killProcessTree(t3b.pid!);
		assert.equal(await exitedWithin(t3b, PROCESS_EXIT_BUDGET_MS), true, "killed after cached TMP was deleted");

		// 4. Retargeted SystemRoot junction + deleted old canonical target
		process.chdir(project);
		const win1 = join(root, "tk-win-1");
		const win2 = join(root, "tk-win-2");
		mkdirSync(win1, { recursive: true });
		mkdirSync(win2, { recursive: true });
		const w1s32 = join(win1, "System32");
		const w2s32 = join(win2, "System32");
		const juncWin = join(root, "tk-junc-win");
		execFileSync(cmdExe, ["/d", "/c", "mklink", "/J", w1s32, realSystem32], { windowsHide: true });
		execFileSync(cmdExe, ["/d", "/c", "mklink", "/J", w2s32, realSystem32], { windowsHide: true });
		execFileSync(cmdExe, ["/d", "/c", "mklink", "/J", juncWin, win1], { windowsHide: true });
		try {
			vi.stubEnv("SystemRoot", juncWin);
			vi.stubEnv("windir", juncWin);
			const t4a = await startLiveTarget("junc-1");
			killProcessTree(t4a.pid!);
			assert.equal(await exitedWithin(t4a, PROCESS_EXIT_BUDGET_MS), true);

			execFileSync(cmdExe, ["/d", "/c", "rmdir", juncWin], { windowsHide: true });
			execFileSync(cmdExe, ["/d", "/c", "mklink", "/J", juncWin, win2], { windowsHide: true });
			execFileSync(cmdExe, ["/d", "/c", "rmdir", w1s32], { windowsHide: true });
			rmSync(win1, { recursive: true, force: true });

			const t4b = await startLiveTarget("junc-2");
			killProcessTree(t4b.pid!);
			assert.equal(
				await exitedWithin(t4b, PROCESS_EXIT_BUDGET_MS),
				true,
				"killed after SystemRoot junction retargeted and old target deleted",
			);
		} finally {
			for (const j of [juncWin, w1s32, w2s32]) {
				try {
					execFileSync(cmdExe, ["/d", "/c", "rmdir", j], { windowsHide: true });
				} catch {}
			}
		}
	});

	test("closing an MCP server still kills its whole tree after a SystemRoot junction is retargeted and its old target deleted", async () => {
		const realSystemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
		const realSystem32 = join(realSystemRoot, "System32");
		const cmdExe = join(realSystem32, "cmd.exe");
		const win1 = join(root, "mcp-win-1");
		const win2 = join(root, "mcp-win-2");
		mkdirSync(win1, { recursive: true });
		mkdirSync(win2, { recursive: true });
		const w1s32 = join(win1, "System32");
		const w2s32 = join(win2, "System32");
		const juncWin = join(root, "mcp-junc-win");
		execFileSync(cmdExe, ["/d", "/c", "mklink", "/J", w1s32, realSystem32], { windowsHide: true });
		execFileSync(cmdExe, ["/d", "/c", "mklink", "/J", w2s32, realSystem32], { windowsHide: true });
		execFileSync(cmdExe, ["/d", "/c", "mklink", "/J", juncWin, win1], { windowsHide: true });

		const grandPidFile = join(root, "mcp-grand.pid");
		const grandScript = join(root, "mcp-grand.cjs");
		writeFileSync(
			grandScript,
			`require("fs").writeFileSync(${JSON.stringify(grandPidFile)}, String(process.pid)); setTimeout(() => {}, 30000);`,
		);
		const parentScript = join(root, "mcp-parent.cjs");
		writeFileSync(
			parentScript,
			`const { spawn } = require("child_process"); process.stdin.resume(); spawn(process.execPath, [${JSON.stringify(grandScript)}], { stdio: "ignore", windowsHide: true }); setTimeout(() => {}, 30000);`,
		);

		try {
			vi.stubEnv("SystemRoot", juncWin);
			vi.stubEnv("windir", juncWin);
			const { StdioTransport } = await import("../src/extensions/mcp/client/transports/stdio.ts");
			const transport = new StdioTransport({
				command: process.execPath,
				args: [parentScript],
				cwd: project,
				projectCwd: project,
				env: { SystemRoot: realSystemRoot, windir: realSystemRoot },
				closeTimeoutMs: PROCESS_EXIT_BUDGET_MS,
			});
			await transport.start();
			servers.push(await recordProcess(transport.pid!));
			await vi.waitFor(() => assert.equal(existsSync(grandPidFile), true), { timeout: SERVER_START_BUDGET_MS });
			const grandPid = Number(readFileSync(grandPidFile, "utf8").trim());
			const grandRecorded = await recordProcess(grandPid);
			servers.push(grandRecorded);

			// Retarget junction from win1 to win2 and delete win1 while the server runs.
			execFileSync(cmdExe, ["/d", "/c", "rmdir", juncWin], { windowsHide: true });
			execFileSync(cmdExe, ["/d", "/c", "mklink", "/J", juncWin, win2], { windowsHide: true });
			execFileSync(cmdExe, ["/d", "/c", "rmdir", w1s32], { windowsHide: true });
			rmSync(win1, { recursive: true, force: true });

			await transport.close();

			assert.equal(
				await waitUntilGone(grandRecorded, PROCESS_EXIT_BUDGET_MS),
				true,
				"grandchild was killed by taskkill",
			);
		} finally {
			for (const j of [juncWin, w1s32, w2s32]) {
				try {
					execFileSync(cmdExe, ["/d", "/c", "rmdir", j], { windowsHide: true });
				} catch {}
			}
		}
	});
});
