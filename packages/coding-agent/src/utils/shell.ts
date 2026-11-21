import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { delimiter, join, posix, win32 } from "node:path";
import { Worker } from "node:worker_threads";
import { type ChildProcess, spawn } from "child_process";
import { getBinDir } from "../config.js";
import { createChildProcessEnvironment } from "./child-process.ts";
import { findHelperExecutable, findHelperExecutableAsync, type HelperExecutableOptions } from "./helper-command.ts";
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

/**
 * A shell found before is reused while a lookup in its directory alone still finds it there: it is still a program, and
 * its directory is still neither working directory, however either is spelled now.
 */
function rechecked(found: string, workingDirectory: string | undefined): [string, HelperExecutableOptions] {
	const path = process.platform === "win32" ? win32 : posix;
	return [path.basename(found), { ...lookupOptions(workingDirectory), env: { PATH: path.dirname(found) } }];
}

function isReusableLookup(lookup: ExecutableLookup, workingDirectory: string | undefined): boolean {
	if (lookup.path === null) return Date.now() - lookup.checkedAt < MISSING_EXECUTABLE_RECHECK_MS;
	return findHelperExecutable(...rechecked(lookup.path, workingDirectory)) === lookup.path;
}

async function isReusableLookupAsync(lookup: ExecutableLookup, workingDirectory: string | undefined): Promise<boolean> {
	if (lookup.path === null) return Date.now() - lookup.checkedAt < MISSING_EXECUTABLE_RECHECK_MS;
	return (await findHelperExecutableAsync(...rechecked(lookup.path, workingDirectory))) === lookup.path;
}

/**
 * A lookup holds for one name, PATH, working directory (none when it was removed) and the directory the shell runs a
 * command in, neither of which it ever finds a shell in.
 */
function lookupKey(executable: string, workingDirectory: string | undefined): string {
	let cwd = "";
	try {
		cwd = process.cwd();
	} catch {}
	return `${executable}\0${process.env.PATH ?? ""}\0${cwd}\0${workingDirectory ?? ""}`;
}

/**
 * Find an executable on PATH (cross-platform), memoized per PATH value.
 * A missing executable is looked up again once its result is 30 seconds old.
 */
function findExecutableOnPath(executable: string, workingDirectory?: string): string | null {
	const key = lookupKey(executable, workingDirectory);
	const cached = executablePathLookups.get(key);
	if (cached && isReusableLookup(cached, workingDirectory)) return cached.path;
	const path = lookupExecutableOnPath(executable, workingDirectory);
	executablePathLookups.set(key, { path, checkedAt: Date.now() });
	return path;
}

async function findExecutableOnPathAsync(executable: string, workingDirectory?: string): Promise<string | null> {
	const key = lookupKey(executable, workingDirectory);
	const cached = executablePathLookups.get(key);
	if (cached && (await isReusableLookupAsync(cached, workingDirectory))) return cached.path;
	const path = await lookupExecutableOnPathAsync(executable, workingDirectory);
	executablePathLookups.set(key, { path, checkedAt: Date.now() });
	return path;
}

/**
 * The shell's absolute path in PATH's absolute directories, never in the project folder or this process's working
 * directory: a shell found there would run whatever a project put in its place.
 */
function lookupOptions(workingDirectory: string | undefined): HelperExecutableOptions {
	return {
		exact: true,
		platform: process.platform,
		...(workingDirectory === undefined ? {} : { cwd: workingDirectory }),
	};
}

function lookupExecutableOnPath(executable: string, workingDirectory?: string): string | null {
	return findHelperExecutable(executable, lookupOptions(workingDirectory)) ?? null;
}

async function lookupExecutableOnPathAsync(executable: string, workingDirectory?: string): Promise<string | null> {
	return (await findHelperExecutableAsync(executable, lookupOptions(workingDirectory))) ?? null;
}

/** A configured shell given by name alone is looked up as any shell is; a path is taken as written. */
function isShellName(shellPath: string): boolean {
	return !/[\\/]/.test(shellPath) && !(process.platform === "win32" && shellPath.includes(":"));
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 * A shell on PATH comes only from its absolute directories: never Atomic's working directory, nor `workingDirectory`,
 * where the shell runs commands.
 */
export function getShellConfig(customShellPath?: string, workingDirectory?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		const shell = isShellName(customShellPath)
			? findExecutableOnPath(customShellPath, workingDirectory)
			: customShellPath;
		if (shell !== null && executableCandidateExists(shell)) {
			return getBashShellConfig(shell);
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
		const bashOnPath = findExecutableOnPath("bash.exe", workingDirectory);
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

	const bashOnPath = findExecutableOnPath("bash", workingDirectory);
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: findExecutableOnPath("sh", workingDirectory) ?? "/bin/sh", args: ["-c"] };
}

export async function getShellConfigAsync(customShellPath?: string, workingDirectory?: string): Promise<ShellConfig> {
	if (customShellPath) {
		const shell = isShellName(customShellPath)
			? await findExecutableOnPathAsync(customShellPath, workingDirectory)
			: customShellPath;
		if (shell !== null && (await executableCandidateExistsAsync(shell))) {
			return getBashShellConfig(shell);
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

		const bashOnPath = await findExecutableOnPathAsync("bash.exe", workingDirectory);
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

	const bashOnPath = await findExecutableOnPathAsync("bash", workingDirectory);
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: (await findExecutableOnPathAsync("sh", workingDirectory)) ?? "/bin/sh", args: ["-c"] };
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

export function getPowerShellConfig(workingDirectory?: string): ShellConfig {
	if (process.platform !== "win32") throw new Error("The powershell tool is only available on Windows.");
	let shell = findExecutableOnPath("pwsh.exe", workingDirectory);
	// Installation directories may be on any drive and need not be on PATH.
	const programFiles = process.env.ProgramFiles;
	if (!shell && programFiles) {
		const pwsh7 = win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
		if (executableCandidateExists(pwsh7)) shell = pwsh7;
	}

	shell ??= findExecutableOnPath("powershell.exe", workingDirectory);
	const systemRoot = process.env.SystemRoot;
	if (!shell && systemRoot) {
		const windowsPowerShell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		if (executableCandidateExists(windowsPowerShell)) shell = windowsPowerShell;
	}

	if (!shell) throw new Error("No PowerShell executable found. Install PowerShell or add it to PATH.");
	return { shell, args: [...POWERSHELL_ARGS] };
}

export async function getPowerShellConfigAsync(workingDirectory?: string): Promise<ShellConfig> {
	if (process.platform !== "win32") throw new Error("The powershell tool is only available on Windows.");
	let shell = await findExecutableOnPathAsync("pwsh.exe", workingDirectory);
	const programFiles = process.env.ProgramFiles;
	if (!shell && programFiles) {
		const pwsh7 = win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
		if (await executableCandidateExistsAsync(pwsh7)) shell = pwsh7;
	}

	shell ??= await findExecutableOnPathAsync("powershell.exe", workingDirectory);
	const systemRoot = process.env.SystemRoot;
	if (!shell && systemRoot) {
		const windowsPowerShell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		if (await executableCandidateExistsAsync(windowsPowerShell)) shell = windowsPowerShell;
	}

	if (!shell) throw new Error("No PowerShell executable found. Install PowerShell or add it to PATH.");
	return { shell, args: [...POWERSHELL_ARGS] };
}

/** Whether the powershell tool finds PowerShell for commands that run in `workingDirectory`. */
export function isPowerShellAvailable(workingDirectory?: string): boolean {
	try {
		getPowerShellConfig(workingDirectory);
		return true;
	} catch {
		return false;
	}
}

export async function isPowerShellAvailableAsync(workingDirectory?: string): Promise<boolean> {
	try {
		await getPowerShellConfigAsync(workingDirectory);
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
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		taskkillTree(pid);
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
