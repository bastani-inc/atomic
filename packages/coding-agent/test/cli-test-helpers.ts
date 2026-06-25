import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
export const cliPath = resolve(testDir, "../src/cli.ts");

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
			try { rmSync(dir, { recursive: true, force: true }); lastError = undefined; break; }
			catch (error) { lastError = error; sleepSync(50 * (attempt + 1)); }
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
	try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

export async function runCliProcess(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CliProcessResult> {
	let stdout = "", stderr = "", timedOut = false, settled = false;
	const child = spawn(bunExecutable(), [cliPath, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
	child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

	return await new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => { timedOut = true; killProcessTree(child.pid); }, options.timeoutMs ?? 30_000);
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			setTimeout(() => {
				child.stdout?.destroy(); child.stderr?.destroy();
				resolvePromise({ stdout, stderr, code, signal, timedOut });
			}, process.platform === "win32" ? 50 : 0);
		};
		child.once("error", (error) => { clearTimeout(timeout); reject(error); });
		child.once("exit", finish);
		child.once("close", finish);
	});
}
