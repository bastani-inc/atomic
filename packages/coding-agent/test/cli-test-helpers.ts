import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
export const cliPath = resolve(testDir, "../src/cli.ts");
const mainPath = resolve(testDir, "../src/main.ts");

const defaultCliProcessTimeoutMs = process.platform === "win32" ? 75_000 : 30_000;

export interface CliProcessResult {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
}

export function bunExecutable(): string {
	const npmExecPath = process.env.npm_execpath;
	if (npmExecPath?.endsWith("bun") || npmExecPath?.endsWith("bun.exe")) return npmExecPath;
	return "bun";
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function removeTempDirs(dirs: string[]): void {
	for (const dir of dirs.splice(0)) {
		let lastError: unknown;
		for (let attempt = 0; attempt < 8; attempt++) {
			try {
				rmSync(dir, { recursive: true, force: true });
				lastError = undefined;
				break;
			} catch (error) {
				lastError = error;
				sleepSync(50 * (attempt + 1));
			}
		}
		if (lastError) throw lastError;
	}
}

function killProcessTree(pid: number | undefined): void {
	if (!pid) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

export async function runCliProcess(
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CliProcessResult> {
	let stdout = "",
		stderr = "",
		timedOut = false,
		settled = false;
	const child = spawn(bunExecutable(), [cliPath, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	child.stdout?.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	return await new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => {
			timedOut = true;
			killProcessTree(child.pid);
		}, options.timeoutMs ?? defaultCliProcessTimeoutMs);
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			setTimeout(
				() => {
					child.stdout?.destroy();
					child.stderr?.destroy();
					resolvePromise({ stdout, stderr, code, signal, timedOut });
				},
				process.platform === "win32" ? 50 : 0,
			);
		};
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", finish);
		child.once("close", finish);
	});
}
/**
 * Run several CLI argv vectors in one real Bun child. Auth preflight commands
 * all terminate through `process.exit`, so the child replaces that call with
 * a caught exit and emits one JSON frame per command. The source `main()` and
 * its stdout guard still run in the Bun child; batching only removes repeated
 * Bun startup and transpile cost from load-sensitive integration coverage.
 */
export async function runCliBatch(
	commands: string[][],
	options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CliProcessResult[]> {
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let settled = false;
	const exitSignal = "__ATOMIC_BATCH_EXIT__";
	const script = String.raw`
import { main } from ${JSON.stringify(mainPath)};

const realStdoutWrite = process.stdout.write.bind(process.stdout);
const realStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleError = console.error;
const originalExit = process.exit;
class BatchExit extends Error {
	constructor(readonly code: number) {
		super(${JSON.stringify(exitSignal)});
	}
}
process.exit = ((code?: number) => {
	throw new BatchExit(code ?? 0);
}) as typeof process.exit;
const commandList = JSON.parse(process.env.ATOMIC_BATCH_COMMANDS ?? "[]");
for (const argv of commandList) {
	const commandStdout = [];
	const commandStderr = [];
	process.exitCode = 0;
	process.stdout.write = ((chunk, encodingOrCallback, callback) => {
		commandStdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(typeof encodingOrCallback === "string" ? encodingOrCallback : undefined));
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		done?.();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk, encodingOrCallback, callback) => {
		commandStderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(typeof encodingOrCallback === "string" ? encodingOrCallback : undefined));
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		done?.();
		return true;
	}) as typeof process.stderr.write;
	console.error = (...args) => {
		commandStderr.push(args.map((value) => String(value)).join(" ") + "\n");
	};
	let code = 0;
	try {
		await main(argv);
		code = process.exitCode ?? 0;
	} catch (error) {
		if (error instanceof BatchExit) code = error.code;
		else throw error;
	} finally {
		process.stdout.write = realStdoutWrite;
		process.stderr.write = realStderrWrite;
		console.error = originalConsoleError;
	}
	realStdoutWrite(JSON.stringify({ code, signal: null, timedOut: false, stdout: commandStdout.join(""), stderr: commandStderr.join("") }) + "\n");
}
process.exitCode = 0;
process.exit = originalExit;
`;
	const child = spawn(bunExecutable(), ["-e", script], {
		cwd: options.cwd,
		env: { ...options.env, ATOMIC_BATCH_COMMANDS: JSON.stringify(commands) },
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	child.stdout?.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	return await new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => {
			timedOut = true;
			killProcessTree(child.pid);
		}, options.timeoutMs ?? defaultCliProcessTimeoutMs);
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			setTimeout(
				() => {
					child.stdout?.destroy();
					child.stderr?.destroy();
					if (timedOut || code !== 0 || signal !== null) {
						reject(
							new Error(
								`Batched CLI child failed (code ${code}, signal ${signal}, timed out ${timedOut}). ${stderr}`,
							),
						);
						return;
					}
					try {
						const frames = stdout
							.trim()
							.split("\n")
							.filter((line) => line.length > 0)
							.map((line) => JSON.parse(line) as CliProcessResult);
						if (frames.length !== commands.length) {
							throw new Error(`Expected ${commands.length} CLI frames, received ${frames.length}`);
						}
						resolvePromise(frames);
					} catch (error) {
						reject(
							new Error(
								`Could not decode batched CLI output: ${error instanceof Error ? error.message : String(error)}`,
							),
						);
					}
				},
				process.platform === "win32" ? 50 : 0,
			);
		};
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", finish);
		child.once("close", finish);
	});
}
