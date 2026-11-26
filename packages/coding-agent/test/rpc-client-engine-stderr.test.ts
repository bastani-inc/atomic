import type * as childProcess from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderEngineDiagnostic } from "../src/modes/interactive-engine/engine-diagnostic-view.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { appendBoundedStderr, createStderrReporter } from "../src/modes/rpc/rpc-client-process.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});
const ZLIB_LINE = "zlib error: incorrect header check";
const tempDirs: string[] = [];
function writeChildScript(): string {
	const dir = mkdtempSync(join(tmpdir(), "atomic-rpc-stderr-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(
		path,
		`import { takeOverStdout, writeRawStdout } from ${JSON.stringify(new URL("../src/core/output-guard.js", import.meta.url).href)};\n` +
			`takeOverStdout(); writeRawStdout(JSON.stringify({type:"engine_ready",protocolVersion:4,pid:process.pid})+"\\n"); console.log(${JSON.stringify(ZLIB_LINE)}); process.stdin.resume();`,
	);
	return path;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(spawn).mockReset();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RpcClient engine stderr routing", () => {
	// Regression #2964: diagnostics must reach the TUI, not a hidden file or raw fd 2.
	test("renders child stderr as status without changing engine health or writing raw output", async () => {
		const shown = Promise.withResolvers<string>();
		const raw = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const stopWorkingLoader = vi.fn();
		const showError = vi.fn();
		const client = new RpcClient({
			cliPath: writeChildScript(),
			interactiveEngine: {
				onDiagnostic: (diagnostic) =>
					renderEngineDiagnostic(diagnostic, {
						stopWorkingLoader,
						showError,
						showStatus: shown.resolve,
					}),
			},
		});
		try {
			await client.start();
			expect(await shown.promise).toBe(`${ZLIB_LINE}\n`);
			expect(raw).not.toHaveBeenCalled();
			expect(log).not.toHaveBeenCalled();
			expect(stopWorkingLoader).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
		} finally {
			await client.stop();
		}
	});
	// After a memory-pressure event macOS prints this from inside fork(), to the forking engine's stderr, for every command
	// the engine starts. It is the OS's notice, not the engine's, and showed up in the TUI once per command.
	test("does not show the macOS stack-logging notice a forked command writes to the engine's stderr", async () => {
		const path = writeChildScript();
		const notice =
			"node(31280) MallocStackLogging: can't turn off malloc stack logging because it was not enabled.\n";
		writeFileSync(
			path,
			`import { writeSync } from "node:fs";
			process.stdout.write(JSON.stringify({type:"engine_ready",protocolVersion:4,pid:process.pid})+"\\n");
			writeSync(2, ${JSON.stringify(notice)});
			setTimeout(() => { writeSync(2, ${JSON.stringify(notice)} + ${JSON.stringify(`${ZLIB_LINE}\n`)} + ${JSON.stringify(notice)}); }, 50);
			process.stdin.resume();`,
		);
		const shown: string[] = [];
		const real = Promise.withResolvers<void>();
		const client = new RpcClient({
			cliPath: path,
			runtimeExecutable: process.execPath,
			interactiveEngine: {
				onDiagnostic: (diagnostic) =>
					renderEngineDiagnostic(diagnostic, {
						stopWorkingLoader: () => {},
						showError: () => {},
						showStatus: (message) => {
							shown.push(message);
							if (message.includes(ZLIB_LINE)) real.resolve();
						},
					}),
			},
		});
		try {
			await client.start();
			await real.promise;
			expect(shown).toEqual([`${ZLIB_LINE}\n`]);
		} finally {
			await client.stop();
		}
	});
	test("uses console.log for noninteractive clients", async () => {
		const shown = Promise.withResolvers<string>();
		vi.spyOn(console, "log").mockImplementation(shown.resolve);
		const raw = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const client = new RpcClient({ cliPath: writeChildScript() });
		try {
			await client.start();
			expect(await shown.promise).toBe(`${ZLIB_LINE}\n`);
			expect(raw).not.toHaveBeenCalled();
		} finally {
			await client.stop();
		}
	});
	// Regression #2965: acknowledge receipt before the child sends continuation bytes.
	test.each([false, true])("preserves split UTF-8 stderr with interactive=%s", async (interactive) => {
		const path = writeChildScript();
		const prefix = " first\n first\n ";
		const suffix = "DONE \t\n";
		writeFileSync(
			path,
			`import { createInterface } from "node:readline";
			process.stdout.write(JSON.stringify({type:"engine_ready",protocolVersion:4,pid:process.pid})+"\\n");
			process.stderr.write(Buffer.concat([Buffer.from(${JSON.stringify(prefix)}), Buffer.from([0xf0])]));
			createInterface({input:process.stdin}).on("line", line => {
				const command = JSON.parse(line);
				process.stderr.end(Buffer.concat([Buffer.from([0x9f,0x98,0x80]), Buffer.from(${JSON.stringify(suffix)})]));
				process.stdout.write(JSON.stringify({type:"response",id:command.id,command:command.type,success:true,data:{}})+"\\n");
			});`,
		);
		const received = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const messages: string[] = [];
		const observe = (message: string) => {
			messages.push(message);
			received.resolve();
			if (message.includes(suffix)) completed.resolve();
		};
		if (!interactive) vi.spyOn(console, "log").mockImplementation(observe);
		const client = new RpcClient({
			cliPath: path,
			runtimeExecutable: process.execPath,
			...(interactive ? { interactiveEngine: { onDiagnostic: (diagnostic) => observe(diagnostic.message) } } : {}),
		});
		try {
			await client.start();
			await received.promise;
			// This request is the handshake: the first pipe event has reached the host.
			await client.getState();
			await completed.promise;
			expect(messages.join("")).toBe(`${prefix}😀${suffix}`);
			expect(client.getStderr()).toBe(`${prefix}😀${suffix}`);
		} finally {
			await client.stop();
		}
	});
	test.each([false, true])(
		"flushes truncated stderr at EOF and isolates generations with interactive=%s",
		async (interactive) => {
			const path = writeChildScript();
			// libuv on Windows deliberately does not close fd 0-2 via fs.close.
			// Use a real owned pipe (fd 3) for this live-EOF decoder test only.
			// This adapter exercises RpcClient's actual pipe reader, not fd 2 routing;
			// the other real-child tests above/below retain normal stderr wiring.
			const actual = await vi.importActual<typeof childProcess>("node:child_process");
			vi.mocked(spawn).mockImplementation((command, args, options) => {
				const child = actual.spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe", "pipe"] });
				Object.defineProperty(child, "stderr", { value: child.stdio[3] });
				return child;
			});
			let received = Promise.withResolvers<void>();
			let completed = Promise.withResolvers<void>();
			let messages: string[] = [];
			const observe = (message: string) => {
				messages.push(message);
				received.resolve();
				if (message.includes("�")) completed.resolve();
			};
			if (!interactive) vi.spyOn(console, "log").mockImplementation(observe);
			const client = new RpcClient({
				cliPath: path,
				runtimeExecutable: process.execPath,
				...(interactive
					? { interactiveEngine: { onDiagnostic: (diagnostic) => observe(diagnostic.message) } }
					: {}),
			});
			for (const [bytes, expected] of [
				["0xf0", "�"],
				["0x9f,0x98,0x80", "���"],
			]) {
				received = Promise.withResolvers<void>();
				completed = Promise.withResolvers<void>();
				messages = [];
				// fd 3 is owned by the fixture and really closes while stdin remains live.
				writeFileSync(
					path,
					`import { createInterface } from "node:readline";
				import { createWriteStream } from "node:fs";
				const stderr = createWriteStream(null, {fd:3, autoClose:true});
				process.stdout.write(JSON.stringify({type:"engine_ready",protocolVersion:4,pid:process.pid})+"\\n");
				stderr.write(Buffer.concat([Buffer.from("prefix "), Buffer.from([${bytes}])]));
				createInterface({input:process.stdin}).on("line", line => {
					const command = JSON.parse(line);
					stderr.end();
					process.stdout.write(JSON.stringify({type:"response",id:command.id,command:command.type,success:true,data:{}})+"\\n");
				});`,
				);
				try {
					await client.start();
					await received.promise;
					if (bytes === "0xf0") expect(messages.join("")).toBe("prefix ");
					await client.getState();
					await completed.promise;
					expect(messages.join("")).toBe(`prefix ${expected}`);
					expect(client.getStderr()).toBe(`prefix ${expected}`);
					expect(await client.getState()).toEqual({});
				} finally {
					await client.stop();
				}
			}
		},
	);
});

test("batches stderr outside the pipe callback, preserving text, duplicates and order", async () => {
	const messages: string[] = [];
	const report = createStderrReporter((message) => messages.push(message));
	report(" first\n");
	report(" first\n");
	report("last ");
	expect(messages).toEqual([]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(messages).toEqual([" first\n first\nlast "]);
	report("next");
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(messages).toEqual([" first\n first\nlast ", "next"]);
});

test("bounds oversized Unicode stderr batches and failure tails", async () => {
	const shown = Promise.withResolvers<string>();
	const report = createStderrReporter(shown.resolve);
	const noise = "😀".repeat(1024 * 1024);
	report(noise);
	report("end");
	const message = await shown.promise;
	expect(Buffer.byteLength(message)).toBeLessThanOrEqual(256 * 1024);
	expect(message).toContain("end");
	expect(message).toContain("[stderr truncated]");
	expect(message).not.toContain("�");
	expect(Buffer.byteLength(appendBoundedStderr(noise, "end"))).toBeLessThanOrEqual(256 * 1024);
});

test("a noisy child can drain while the host event loop continues to turn", async () => {
	const path = writeChildScript();
	writeFileSync(
		path,
		`process.stdout.write(JSON.stringify({type:"engine_ready",protocolVersion:4,pid:process.pid})+"\\n");
	const chunk = Buffer.alloc(65536, "x");
	for (let i = 0; i < 512; i++) { if (!process.stderr.write(chunk)) await new Promise(r => process.stderr.once("drain", r)); }
	process.stderr.write("NOISE_DONE"); process.stdin.resume();`,
	);
	const done = Promise.withResolvers<void>();
	let turns = 0;
	let reports = 0;
	const timer = setInterval(() => turns++, 0);
	const client = new RpcClient({
		cliPath: path,
		interactiveEngine: {
			onDiagnostic: (diagnostic) => {
				reports++;
				expect(Buffer.byteLength(diagnostic.message)).toBeLessThanOrEqual(256 * 1024);
				if (diagnostic.message.includes("NOISE_DONE")) done.resolve();
			},
		},
	});
	try {
		await client.start();
		await done.promise;
		expect(turns).toBeGreaterThan(0);
		expect(reports).toBeGreaterThan(0);
	} finally {
		clearInterval(timer);
		await client.stop();
	}
});

test("the RPC stdout guard forwards console diagnostics without contaminating JSON stdout", () => {
	const guard = new URL("../src/core/output-guard.js", import.meta.url).href;
	const result = spawnSync(
		"bun",
		[
			"--eval",
			`
		import { takeOverStdout, writeRawStdout, flushRawStdout } from ${JSON.stringify(guard)};
		takeOverStdout(); console.log(${JSON.stringify(ZLIB_LINE)});
		writeRawStdout(JSON.stringify({type:"diagnostic_probe"})+"\\n"); await flushRawStdout();
	`,
		],
		{ encoding: "utf8" },
	);
	expect(result.status).toBe(0);
	expect(result.stdout).toBe('{"type":"diagnostic_probe"}\n');
	expect(result.stderr).toBe(`${ZLIB_LINE}\n`);
});
