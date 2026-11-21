import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { delimiter, join, win32 } from "node:path";
import { Worker } from "node:worker_threads";
import { type ChildProcess, execFile, spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.js";
import { createChildProcessEnvironment } from "./child-process.ts";
import { pathExists as shellPathExistsAsync } from "./path-exists.ts";
import { getGitShellEnvironment, getGitShellEnvironmentAsync } from "./tools-manager.ts";
import { EVAL_WORKER_BUILTIN, evalWorkerExecArgv } from "./worker-threads.js";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

function isLegacyWslBashPath(path: string): boolean {
	const normalized = win32.normalize(path).toLowerCase();
	const systemRoot = process.env.SystemRoot;
	if (systemRoot) {
		if (!/^[a-z]:[\\/]/i.test(systemRoot)) return false;
		return ["System32", "Sysnative"].some(
			(directory) => normalized === win32.join(systemRoot, directory, "bash.exe").toLowerCase(),
		);
	}
	// Fall back to conventional launcher paths only when the Windows directory is unknown.
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

// On Unix this is identical to existsSync() (both are access(F_OK)), just
// spelled with try/catch. On Windows we explicitly avoid existsSync(): its
// extra stat check rejects runnable Store aliases (nodejs/node#36790).
function shellPathExists(path: string): boolean {
	try {
		accessSync(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function isDirectoryEntry(path: string): boolean {
	try {
		const entry = lstatSync(path, { throwIfNoEntry: false });
		if (entry === undefined || entry.isFile()) return false;
		if (entry.isDirectory()) return true;
		return entry.isSymbolicLink() && statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
	} catch {
		return false;
	}
}

function executableCandidateExists(path: string): boolean {
	return shellPathExists(path) && !isDirectoryEntry(path);
}

async function isDirectoryEntryAsync(path: string): Promise<boolean> {
	try {
		const entry = await lstat(path);
		if (entry.isFile()) return false;
		if (entry.isDirectory()) return true;
		return entry.isSymbolicLink() && (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function executableCandidateExistsAsync(path: string): Promise<boolean> {
	return (await shellPathExistsAsync(path)) && !(await isDirectoryEntryAsync(path));
}

const MISSING_EXECUTABLE_RECHECK_MS = 30_000;

interface ExecutableLookup {
	path: string | null;
	checkedAt: number;
}

const executablePathLookups = new Map<string, ExecutableLookup>();

function isReusableLookup(lookup: ExecutableLookup): boolean {
	return lookup.path === null
		? Date.now() - lookup.checkedAt < MISSING_EXECUTABLE_RECHECK_MS
		: executableCandidateExists(lookup.path);
}

async function isReusableLookupAsync(lookup: ExecutableLookup): Promise<boolean> {
	return lookup.path === null
		? Date.now() - lookup.checkedAt < MISSING_EXECUTABLE_RECHECK_MS
		: executableCandidateExistsAsync(lookup.path);
}

/**
 * Find an executable on PATH (cross-platform), memoized per PATH value.
 * A missing executable is looked up again once its result is 30 seconds old.
 */
function findExecutableOnPath(executable: string): string | null {
	const key = `${executable}\0${process.env.PATH ?? ""}\0${process.cwd()}`;
	const cached = executablePathLookups.get(key);
	if (cached && isReusableLookup(cached)) return cached.path;
	const path = lookupExecutableOnPath(executable);
	executablePathLookups.set(key, { path, checkedAt: Date.now() });
	return path;
}

async function findExecutableOnPathAsync(executable: string): Promise<string | null> {
	const key = `${executable}\0${process.env.PATH ?? ""}\0${process.cwd()}`;
	const cached = executablePathLookups.get(key);
	if (cached && (await isReusableLookupAsync(cached))) return cached.path;
	const path = await lookupExecutableOnPathAsync(executable);
	executablePathLookups.set(key, { path, checkedAt: Date.now() });
	return path;
}

function scanWindowsPath(executable: string): string | null {
	const extensions = win32.extname(executable)
		? [""]
		: (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	for (const entry of [process.cwd(), ...(process.env.PATH ?? "").split(win32.delimiter)]) {
		const directory = entry.trim().replace(/^"(.*)"$/, "$1");
		if (!directory) continue;
		for (const extension of extensions) {
			const candidate = win32.resolve(process.cwd(), directory, `${executable}${extension}`);
			if (executableCandidateExists(candidate)) return candidate;
		}
	}
	return null;
}

async function scanWindowsPathAsync(executable: string): Promise<string | null> {
	const extensions = win32.extname(executable)
		? [""]
		: (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	for (const entry of [process.cwd(), ...(process.env.PATH ?? "").split(win32.delimiter)]) {
		const directory = entry.trim().replace(/^"(.*)"$/, "$1");
		if (!directory) continue;
		for (const extension of extensions) {
			const candidate = win32.resolve(process.cwd(), directory, `${executable}${extension}`);
			if (await executableCandidateExistsAsync(candidate)) return candidate;
		}
	}
	return null;
}

function lookupExecutableOnPath(executable: string): string | null {
	if (process.platform === "win32") return scanWindowsPath(executable);

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", [executable], {
			encoding: "utf-8",
			timeout: 5000,
			env: createChildProcessEnvironment(),
		});
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

async function lookupExecutableOnPathAsync(executable: string): Promise<string | null> {
	if (process.platform === "win32") return scanWindowsPathAsync(executable);

	return new Promise((resolve) => {
		try {
			execFile(
				"which",
				[executable],
				{
					encoding: "utf-8",
					timeout: 5000,
					env: createChildProcessEnvironment(),
				},
				(error, stdout) => {
					if (error !== null || !stdout) {
						resolve(null);
						return;
					}
					const firstMatch = String(stdout).trim().split(/\r?\n/)[0];
					resolve(firstMatch || null);
				},
			);
		} catch {
			resolve(null);
		}
	});
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (executableCandidateExists(customShellPath)) {
			return getBashShellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (executableCandidateExists(path)) {
				return getBashShellConfig(path);
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findExecutableOnPath("bash.exe");
		if (bashOnPath) {
			return getBashShellConfig(bashOnPath);
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (executableCandidateExists("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

export async function getShellConfigAsync(customShellPath?: string): Promise<ShellConfig> {
	if (customShellPath) {
		if (await executableCandidateExistsAsync(customShellPath)) {
			return getBashShellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (await executableCandidateExistsAsync(path)) {
				return getBashShellConfig(path);
			}
		}

		const bashOnPath = await findExecutableOnPathAsync("bash.exe");
		if (bashOnPath) {
			return getBashShellConfig(bashOnPath);
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	if (await executableCandidateExistsAsync("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = await findExecutableOnPathAsync("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

export function getPowerShellConfig(): ShellConfig {
	if (process.platform !== "win32") throw new Error("The powershell tool is only available on Windows.");
	let shell = findExecutableOnPath("pwsh.exe");
	// Installation directories may be on any drive and need not be on PATH.
	const programFiles = process.env.ProgramFiles;
	if (!shell && programFiles) {
		const pwsh7 = win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
		if (executableCandidateExists(pwsh7)) shell = pwsh7;
	}

	shell ??= findExecutableOnPath("powershell.exe");
	const systemRoot = process.env.SystemRoot;
	if (!shell && systemRoot) {
		const windowsPowerShell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		if (executableCandidateExists(windowsPowerShell)) shell = windowsPowerShell;
	}

	if (!shell) throw new Error("No PowerShell executable found. Install PowerShell or add it to PATH.");
	return { shell, args: [...POWERSHELL_ARGS] };
}

export async function getPowerShellConfigAsync(): Promise<ShellConfig> {
	if (process.platform !== "win32") throw new Error("The powershell tool is only available on Windows.");
	let shell = await findExecutableOnPathAsync("pwsh.exe");
	const programFiles = process.env.ProgramFiles;
	if (!shell && programFiles) {
		const pwsh7 = win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
		if (await executableCandidateExistsAsync(pwsh7)) shell = pwsh7;
	}

	shell ??= await findExecutableOnPathAsync("powershell.exe");
	const systemRoot = process.env.SystemRoot;
	if (!shell && systemRoot) {
		const windowsPowerShell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		if (await executableCandidateExistsAsync(windowsPowerShell)) shell = windowsPowerShell;
	}

	if (!shell) throw new Error("No PowerShell executable found. Install PowerShell or add it to PATH.");
	return { shell, args: [...POWERSHELL_ARGS] };
}

export function isPowerShellAvailable(): boolean {
	try {
		getPowerShellConfig();
		return true;
	} catch {
		return false;
	}
}

export async function isPowerShellAvailableAsync(): Promise<boolean> {
	try {
		await getPowerShellConfigAsync();
		return true;
	} catch {
		return false;
	}
}

function buildShellEnv(
	git: { readonly pathEntry: string; readonly env: Record<string, string> } | undefined,
): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const additions = [...(git === undefined ? [] : [git.pathEntry]), binDir].filter(
		(entry) => !pathEntries.includes(entry),
	);
	const updatedPath = [...additions, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		...git?.env,
		[pathKey]: updatedPath,
	};
}

export function getShellEnv(): NodeJS.ProcessEnv {
	return buildShellEnv(getGitShellEnvironment(process.env));
}

export async function getShellEnvAsync(): Promise<NodeJS.ProcessEnv> {
	return buildShellEnv(await getGitShellEnvironmentAsync(process.env));
}

interface DetachedChildGuardian {
	postMessage(message: { action: "track" | "exited" | "untrack"; pid: number }): void;
	terminate(): Promise<number>;
	unref(): void;
}

let detachedChildGuardian: DetachedChildGuardian | undefined;

const PARENT_GUARDIAN_SOURCE = `
${EVAL_WORKER_BUILTIN}
const { parentPort, workerData } = builtin("node:worker_threads");
const { spawn } = builtin("node:child_process");
const { existsSync } = builtin("node:fs");
const { join } = builtin("node:path");
const tracked = new Map();
parentPort.on("message", ({ action, pid }) => {
  if (action === "track") tracked.set(pid, false);
  else if (action === "exited") { if (tracked.has(pid)) tracked.set(pid, true); }
  else tracked.delete(pid);
});
function killTree(pid, exited) {
  if (process.platform === "win32") {
    if (exited) return;
    // Same System32 hardening as killProcessTree: PATH is not trusted here, and an
    // unconsumed async "error" from a failed spawn would take the guardian thread
    // down and leak every detached child it exists to reap.
    try {
      const child = spawn(join(process.env.SystemRoot || "C:\\\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true, env: { ...process.env, AI_AGENT: workerData.aiAgent } });
      child.once("error", () => {});
    } catch {}
    return;
  }
  try { process.kill(-pid, "SIGKILL"); }
  catch { if (!exited) { try { process.kill(pid, "SIGKILL"); } catch {} } }
}
const timer = setInterval(() => {
  let parentAlive = true;
  try { process.kill(workerData.parentPid, 0); } catch { parentAlive = false; }
  if (parentAlive && (!workerData.stopFile || !existsSync(workerData.stopFile))) return;
  for (const [pid, exited] of tracked) killTree(pid, exited);
  killTree(process.pid, false);
}, 50);
timer.unref?.();
`;

export function startParentProcessGuardian(parentPid: number, stopFile?: string): () => Promise<void> {
	if (detachedChildGuardian) return async () => {};
	const guardian = new Worker(PARENT_GUARDIAN_SOURCE, {
		eval: true,
		execArgv: evalWorkerExecArgv(),
		workerData: { parentPid, stopFile, aiAgent: createChildProcessEnvironment().AI_AGENT },
	});
	detachedChildGuardian = guardian;
	for (const [pid, exited] of trackedDetachedChildPids) {
		guardian.postMessage({ action: "track", pid });
		if (exited) guardian.postMessage({ action: "exited", pid });
	}
	guardian.unref();
	return async () => {
		if (detachedChildGuardian !== guardian) return;
		detachedChildGuardian = undefined;
		await guardian.terminate();
	};
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Map<number, boolean>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.set(pid, false);
	detachedChildGuardian?.postMessage({ action: "track", pid });
}

export function markDetachedChildExited(pid: number): void {
	if (!trackedDetachedChildPids.has(pid)) return;
	trackedDetachedChildPids.set(pid, true);
	detachedChildGuardian?.postMessage({ action: "exited", pid });
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
	detachedChildGuardian?.postMessage({ action: "untrack", pid });
}

/**
 * Kill every tracked detached child and its tree, except those in `spare`, which stay tracked: their owner stops them
 * itself, and a later call without `spare` still kills them.
 */
export function killTrackedDetachedChildren(spare?: ReadonlySet<number>): void {
	for (const [pid, exited] of trackedDetachedChildPids) {
		if (spare?.has(pid)) continue;
		if (!exited) killProcessTree(pid);
		else if (process.platform !== "win32") {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {}
		}
		detachedChildGuardian?.postMessage({ action: "untrack", pid });
		trackedDetachedChildPids.delete(pid);
	}
}

/**
 * Stops `child` and its descendants when no Job object contains them; `exited` says whether its exit was reported.
 * Once it was, the root's pid may already name another process: on POSIX only its process group, which lives on only
 * while its descendants do, is signalled, and on Windows nothing is killed by pid. While the root runs, its tree is
 * killed and then the root itself through its handle, which on Windows also ends a root that taskkill could not.
 * A child that never started (no pid) has nothing to kill: Node reports its failure as an `error` event, and on
 * Windows its `kill()` throws.
 */
export function killChildProcessTree(child: ChildProcess, exited: boolean): void {
	const pid = child.pid;
	if (pid === undefined) return;
	if (pid === process.pid) {
		if (process.platform !== "win32") child.kill("SIGKILL");
		return;
	}
	if (process.platform === "win32") {
		if (exited) return;
		taskkillTree(pid, () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		});
		return;
	}
	if (exited) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// No process is left in its group.
		}
		return;
	}
	killProcessTree(pid);
	child.kill("SIGKILL");
}

function taskkillTree(pid: number, settled?: () => void): void {
	// Use the trusted System32 executable so cleanup does not depend on PATH.
	try {
		const child = spawn(
			join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
			["/F", "/T", "/PID", String(pid)],
			{
				stdio: "ignore",
				detached: true,
				// `detached` gives the child its own console on Windows unless this is
				// set, so omitting it both flashes a window and pays for a console
				// allocation on every tree kill. Every other spawn in the fork sets it.
				windowsHide: true,
				env: createChildProcessEnvironment(),
			},
		);
		// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			settled?.();
		};
		child.once("error", finish);
		child.once("exit", finish);
	} catch {
		settled?.();
	}
}

/**
 * Kill a process and all its children (cross-platform)
 */
/** Ends process `pid` and its descendants: its process group on POSIX, its tree on Windows, where `settled` runs once the tree kill finished. */
export function killProcessTree(pid: number, settled?: () => void): void {
	if (process.platform === "win32") {
		taskkillTree(pid, settled);
	} else {
		if (process.platform === "darwin") {
			// macOS signals group members individually after releasing the group lock. A killed
			// child can wake its waiting shell before that shell is signalled, letting `a; b`
			// start b during cancellation (pi #11252). Stop the group first to reduce this race;
			// this is best-effort, not an atomic freeze. SIGKILL also kills stopped processes.
			// Linux holds tasklist_lock across group signalling; child exit notification needs
			// its write lock, so the shell is signalled before observing the killed child's exit.
			try {
				process.kill(-pid, "SIGSTOP");
			} catch {
				// A failed stop must not prevent the kill attempt or its single-process fallback.
			}
		}
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
