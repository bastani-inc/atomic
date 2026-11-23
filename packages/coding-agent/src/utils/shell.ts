import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { delimiter, join, win32 } from "node:path";
import { Worker } from "node:worker_threads";
import { type ChildProcess, spawn } from "child_process";
import { getBinDir } from "../config.js";
import * as processStartToken from "../core/process-start-token.js";
import * as processTreeContainment from "../core/process-tree-containment.ts";
import {
	createChildProcessEnvironment,
	releaseRetainedWindowsProcessExitHandle,
	retainWindowsProcessExitHandle,
} from "./child-process.ts";
import { findHelperExecutable, findHelperExecutableAsync } from "./helper-command.ts";
import { type HostChildProcess, spawnContainedProcess } from "./host-spawn.ts";
import { resolutionBaseUrl } from "./module-require.js";
import { pathExists as shellPathExistsAsync } from "./path-exists.ts";
import { getGitShellEnvironment, getGitShellEnvironmentAsync } from "./tools-manager.ts";
import {
	DEFAULT_WINDOWS_CWD_TIMEOUT_MS,
	resolveSafeWindowsKillCwdLexical,
	resolveSafeWindowsWorkingDirectoryAsync,
} from "./windows-cwd.js";
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

/** A lookup holds for one name and PATH: it reads only PATH's absolute directories. */
function lookupKey(executable: string): string {
	return `${executable}\0${process.env.PATH ?? ""}`;
}

/**
 * Find an executable on PATH (cross-platform), memoized per PATH value.
 * A missing executable is looked up again once its result is 30 seconds old.
 */
function findExecutableOnPath(executable: string): string | null {
	const key = lookupKey(executable);
	const cached = executablePathLookups.get(key);
	if (cached && isReusableLookup(cached)) return cached.path;
	const path = lookupExecutableOnPath(executable);
	executablePathLookups.set(key, { path, checkedAt: Date.now() });
	return path;
}

async function findExecutableOnPathAsync(executable: string): Promise<string | null> {
	const key = lookupKey(executable);
	const cached = executablePathLookups.get(key);
	if (cached && (await isReusableLookupAsync(cached))) return cached.path;
	const path = await lookupExecutableOnPathAsync(executable);
	executablePathLookups.set(key, { path, checkedAt: Date.now() });
	return path;
}

/**
 * The shell's absolute path in PATH's absolute directories, never through Windows' search of the working directory or
 * an empty or relative PATH entry: a shell found there would run whatever a project put in its place.
 */
const LOOKUP_OPTIONS = { exact: true } as const;

function lookupExecutableOnPath(executable: string): string | null {
	return findHelperExecutable(executable, { ...LOOKUP_OPTIONS, platform: process.platform }) ?? null;
}

async function lookupExecutableOnPathAsync(executable: string): Promise<string | null> {
	return (await findHelperExecutableAsync(executable, { ...LOOKUP_OPTIONS, platform: process.platform })) ?? null;
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
 * A shell on PATH comes only from its absolute directories, never from Windows' search of the working directory or an
 * empty or relative PATH entry.
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		const shell = isShellName(customShellPath) ? findExecutableOnPath(customShellPath) : customShellPath;
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

	return { shell: findExecutableOnPath("sh") ?? "/bin/sh", args: ["-c"] };
}

export async function getShellConfigAsync(customShellPath?: string): Promise<ShellConfig> {
	if (customShellPath) {
		const shell = isShellName(customShellPath) ? await findExecutableOnPathAsync(customShellPath) : customShellPath;
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

	return { shell: (await findExecutableOnPathAsync("sh")) ?? "/bin/sh", args: ["-c"] };
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
	postMessage(message: { action: "track" | "exited" | "untrack"; pid: number; created?: string | null }): void;
	terminate(): Promise<number>;
	unref(): void;
}

let detachedChildGuardian: DetachedChildGuardian | undefined;

const PARENT_GUARDIAN_SOURCE = `
${EVAL_WORKER_BUILTIN}
const { parentPort, workerData } = builtin("node:worker_threads");
const { spawn } = builtin("node:child_process");
const { existsSync, lstatSync, realpathSync, statSync } = builtin("node:fs");
const { tmpdir } = builtin("node:os");
const { join, win32 } = builtin("node:path");
const tracked = new Map();
parentPort.on("message", ({ action, pid, created }) => {
  if (action === "track") tracked.set(pid, { exited: false, created });
  else if (action === "exited") { const e = tracked.get(pid); if (e) e.exited = true; }
  else tracked.delete(pid);
});
let nativeAddon;
function loadNative() {
  if (nativeAddon !== undefined) return nativeAddon;
  if (!workerData.nativeWindowsHost || !workerData.resolutionBase) { nativeAddon = null; return null; }
  try {
    const { createRequire } = builtin("node:module");
    nativeAddon = createRequire(workerData.resolutionBase)("@bastani/atomic-natives") || null;
  } catch {
    nativeAddon = null;
  }
  return nativeAddon;
}
function normalizeWinPath(v) {
  if (!v || v.includes("\\0")) return undefined;
  const s = v.replaceAll("/", "\\\\");
  const isDrive = (p) => p.length >= 3 && ((p.charCodeAt(0) >= 65 && p.charCodeAt(0) <= 90) || (p.charCodeAt(0) >= 97 && p.charCodeAt(0) <= 122)) && p[1] === ":" && p[2] === "\\\\";
  if (s.startsWith("\\\\\\\\?\\\\") || s.startsWith("\\\\\\\\.\\\\")) {
    const r = s.slice(4);
    if (r.length >= 4 && r.slice(0, 4).toLowerCase() === "unc\\\\") return normalizeWinPath("\\\\\\\\" + r.slice(4));
    return isDrive(r) ? win32.resolve(r) : undefined;
  }
  if (s.startsWith("\\\\\\\\")) {
    const r = s.slice(2);
    const i = r.indexOf("\\\\");
    if (i <= 0) return undefined;
    const srv = r.slice(0, i);
    const rest = r.slice(i + 1);
    const j = rest.indexOf("\\\\");
    const shr = j === -1 ? rest : rest.slice(0, j);
    if (srv === "." || srv === ".." || !shr || shr === "." || shr === "..") return undefined;
    return win32.resolve(s);
  }
  return isDrive(s) ? win32.resolve(s) : undefined;
}
function winRoot(p) {
  const n = normalizeWinPath(p);
  if (!n) return undefined;
  const r = win32.parse(n).root;
  return r.length > 1 ? (r.endsWith("\\\\") ? r : r + "\\\\") : undefined;
}
function tryReal(p) {
  try {
    const fn = typeof realpathSync.native === "function" ? realpathSync.native : realpathSync;
    return normalizeWinPath(fn(p));
  } catch {
    try { return normalizeWinPath(realpathSync(p)); } catch { return undefined; }
  }
}
function isInsideDir(f, c) {
  const rel = win32.relative(f.toLowerCase(), c.toLowerCase());
  return rel !== ".." && !rel.startsWith("..\\\\") && !win32.isAbsolute(rel);
}
function toSpawnWinPath(p) {
  if (p.startsWith("\\\\\\\\?\\\\") || p.length < 248) return p;
  return p.startsWith("\\\\\\\\") ? "\\\\\\\\?\\\\UNC\\\\" + p.slice(2) : "\\\\\\\\?\\\\" + p;
}
function safeKillCwd(commandPath) {
  let cwdRaw;
  try { cwdRaw = process.cwd(); } catch {}
  const cwdLex = cwdRaw ? normalizeWinPath(cwdRaw) : undefined;
  const cwdProbe = cwdRaw && cwdLex ? (cwdRaw.length >= 248 && !cwdRaw.startsWith("\\\\\\\\?\\\\") ? toSpawnWinPath(cwdLex) : cwdRaw) : undefined;
  const cwdReal = cwdProbe ? tryReal(cwdProbe) : undefined;
  const temp = tmpdir();
  const cmdNorm = commandPath ? normalizeWinPath(commandPath) : undefined;
  const cmdDir = cmdNorm ? win32.dirname(cmdNorm) : undefined;
  const cands = [process.env.SystemRoot, process.env.windir, "C:\\\\Windows", cmdDir, temp, winRoot(commandPath), winRoot(temp), winRoot(cwdReal), winRoot(cwdLex), "C:\\\\"];
  let longOut;
  let shortFb;
  let anyFb;
  for (const raw of cands) {
    const lex = raw ? normalizeWinPath(raw) : undefined;
    if (!lex) continue;
    const probe = raw.length >= 248 && !raw.startsWith("\\\\\\\\?\\\\") ? toSpawnWinPath(lex) : raw;
    try { if (!statSync(probe).isDirectory()) continue; } catch { continue; }
    const real = tryReal(probe);
    let unverified = false;
    if (!real) { try { unverified = lstatSync(probe).isSymbolicLink(); } catch {} }
    const chosen = toSpawnWinPath(real || lex);
    const isShort = !chosen.startsWith("\\\\\\\\?\\\\") && chosen.length < 248;
    let blocked = unverified;
    if (!blocked && cwdLex) {
      const f = cwdReal || cwdLex;
      const c = real || lex;
      const fRoot = winRoot(f);
      const isRealRoot = fRoot && f.toLowerCase() === fRoot.toLowerCase();
      blocked = isRealRoot ? f.toLowerCase() === c.toLowerCase() : (isInsideDir(f, c) || (!winRoot(cwdLex) || cwdLex.toLowerCase() !== winRoot(cwdLex).toLowerCase()) && isInsideDir(cwdLex, lex));
    }
    if (!blocked) {
      if (isShort) return chosen;
      if (!longOut) longOut = chosen;
      continue;
    }
    if (isShort && !shortFb) shortFb = chosen;
    if (!anyFb) anyFb = chosen;
  }
  return longOut || shortFb || anyFb;
}
function exitHost() {
  // Inside a worker thread, process.exit(1) only exits the worker; SIGKILL on our own PID terminates the host process.
  try { process.kill(process.pid, "SIGKILL"); } catch {}
  process.exit(1);
}
function fallbackTaskkillSelf() {
  // Same System32 hardening as killProcessTree: PATH is not trusted here, and an
  // unconsumed async "error" from a failed spawn would take the guardian thread
  // down and leak every detached child it exists to reap.
  try {
    // In a verified directory outside the project: a kill never keeps the folder Atomic ran in in use.
    const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\\\Windows";
    const taskkillPath = join(systemRoot, "System32", "taskkill.exe");
    const cwd = safeKillCwd(taskkillPath);
    const child = spawn(taskkillPath, ["/F", "/T", "/PID", String(process.pid)], { ...(cwd === undefined ? {} : { cwd }), stdio: "ignore", detached: true, windowsHide: true, env: { ...process.env, AI_AGENT: workerData.aiAgent } });
    child.once("error", exitHost);
    child.once("exit", exitHost);
    return;
  } catch {}
  exitHost();
}
function killTracked(pid, entry, native) {
  if (process.platform === "win32") {
    if (entry.exited) return;
    // Only terminate a tracked Windows child when its creation time was captured and verified atomically
    // on the opened handle; never kill an unverified bare PID that may have been reused.
    if (native && typeof native.terminateProcessCreatedAt === "function" && typeof entry.created === "string") {
      try { native.terminateProcessCreatedAt(pid, entry.created, true); } catch {}
    }
    return;
  }
  try { process.kill(-pid, "SIGKILL"); }
  catch { if (!entry.exited) { try { process.kill(pid, "SIGKILL"); } catch {} } }
}
function killSelf(native) {
  if (process.platform === "win32") {
    if (native && typeof native.holdProcessDescendants === "function") {
      let held;
      try { held = native.holdProcessDescendants(process.pid); } catch {}
      // Only take the native path when endDescendants() is available so verified descendants end BEFORE self;
      // older native binaries lacking endDescendants() would terminate self first in endAll().
      if (held && typeof held.endDescendants === "function") {
        try {
          held.endDescendants();
          held.endAll();
        } catch {}
        exitHost();
      }
      if (held) {
        try { held.release(); } catch {}
      }
    }
    fallbackTaskkillSelf();
    return;
  }
  try { process.kill(-process.pid, "SIGKILL"); }
  catch { try { process.kill(process.pid, "SIGKILL"); } catch {} }
}
function isParentAlive(native) {
  if (process.platform === "win32" && native && typeof native.processCreationTime === "function") {
    if (workerData.parentCreated === null) return false;
    if (typeof workerData.parentCreated === "string") {
      try { return native.processCreationTime(workerData.parentPid) === workerData.parentCreated; } catch { return false; }
    }
  }
  try { process.kill(workerData.parentPid, 0); return true; } catch { return false; }
}
const timer = setInterval(() => {
  const native = process.platform === "win32" ? loadNative() : null;
  const parentAlive = isParentAlive(native);
  if (parentAlive && (!workerData.stopFile || !existsSync(workerData.stopFile))) return;
  clearInterval(timer);
  for (const [pid, entry] of tracked) killTracked(pid, entry, native);
  killSelf(native);
}, 50);
timer.unref?.();
`;

export function startParentProcessGuardian(parentPid: number, stopFile?: string): () => Promise<void> {
	if (detachedChildGuardian) return async () => {};
	const guardian = new Worker(PARENT_GUARDIAN_SOURCE, {
		eval: true,
		execArgv: evalWorkerExecArgv(),
		workerData: {
			parentPid,
			parentCreated: captureWindowsCreationTime(parentPid),
			stopFile,
			aiAgent: createChildProcessEnvironment().AI_AGENT,
			resolutionBase: resolutionBaseUrl(import.meta.url),
			nativeWindowsHost: process.platform === "win32",
		},
	});
	detachedChildGuardian = guardian;
	for (const [pid, entry] of trackedDetachedChildPids) {
		guardian.postMessage({ action: "track", pid, created: entry.created });
		if (entry.exited) guardian.postMessage({ action: "exited", pid });
	}
	guardian.unref();
	return async () => {
		if (detachedChildGuardian !== guardian) return;
		detachedChildGuardian = undefined;
		await guardian.terminate();
	};
}

interface TrackedDetachedChild {
	exited: boolean;
	readonly child?: ChildProcess;
	/**
	 * On Windows: creation time captured via the native addon while tracked, `null` when the native addon saw the
	 * process already absent, or `undefined` when unavailable.
	 */
	readonly created?: string | null;
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Map<number, TrackedDetachedChild>();

function captureWindowsCreationTime(pid: number): string | null | undefined {
	if (process.platform !== "win32") return undefined;
	return processStartToken.nativeProcessCreationTime?.(pid);
}

export function trackDetachedChildPid(pid: number): void {
	const created = captureWindowsCreationTime(pid);
	trackedDetachedChildPids.set(pid, { exited: false, created });
	detachedChildGuardian?.postMessage({ action: "track", pid, created });
}

/** Tracks `child` with its live handle so shutdown can stop it on Windows without bare-PID kills. */
export function trackDetachedChildProcess(child: ChildProcess): void {
	const pid = child.pid;
	if (pid === undefined) return;
	const exited = child.exitCode !== null || child.signalCode !== null;
	const created = exited ? null : captureWindowsCreationTime(pid);
	trackedDetachedChildPids.set(pid, { exited, child, created });
	detachedChildGuardian?.postMessage({ action: "track", pid, created });
	if (exited) detachedChildGuardian?.postMessage({ action: "exited", pid });
}

export function markDetachedChildExited(pid: number): void {
	const entry = trackedDetachedChildPids.get(pid);
	if (entry === undefined) return;
	entry.exited = true;
	detachedChildGuardian?.postMessage({ action: "exited", pid });
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
	detachedChildGuardian?.postMessage({ action: "untrack", pid });
}

/** Ends the tree of a running shell that {@link spawnShellProcess} started in a job of its own. */
const runningShellTrees = new Set<() => void>();

/** A shell the bash or PowerShell tool runs without a task owner. */
export interface ShellProcess {
	readonly child: HostChildProcess;
	/** Ends the shell and what it started that still runs (timeout, abort). */
	stop(): void;
	/** Once its command is done: what the command left running keeps running. */
	finish(): void;
}

/**
 * Starts `shell` with `args` for the bash or PowerShell tool run without a task owner, with output piped and input
 * `stdin`. On Windows, with the native module and a full shell path, the shell starts suspended in a job of its own:
 * {@link ShellProcess.stop} ends, while the shell runs, it and the processes below it, and then every process in the
 * job, also those left running after the shell exited and those whose starter exited, never one by a process ID
 * another process may have been given. A program that asks to leave the job (as Git Bash's do) leaves it, and a stop
 * ends it only while it is below the running shell, as `taskkill /T` did. {@link ShellProcess.finish} lets go of the
 * job, so what the command left running outlives Atomic. Otherwise it is `child_process.spawn` (detached on POSIX),
 * stopped with {@link killChildProcessTree}.
 */
export async function spawnShellProcess(
	shell: string,
	args: readonly string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdin: "pipe" | "ignore" },
): Promise<ShellProcess> {
	const stdio = [options.stdin, "pipe", "pipe"] as const;
	const contained = await spawnContainedProcess(shell, args, { cwd: options.cwd, env: options.env, stdio });
	if (contained !== undefined) {
		const endTree = () => {
			contained.endTree();
		};
		runningShellTrees.add(endTree);
		return {
			child: contained,
			stop: endTree,
			finish: () => {
				runningShellTrees.delete(endTree);
				contained.releaseTree();
			},
		};
	}
	const child = spawn(shell, [...args], {
		cwd: options.cwd,
		detached: process.platform !== "win32",
		env: options.env,
		stdio: [...stdio],
		windowsHide: true,
	});
	retainWindowsProcessExitHandle(child);
	const pid = child.pid;
	let exited = false;
	child.once("exit", () => {
		exited = true;
		if (pid !== undefined) markDetachedChildExited(pid);
	});
	if (pid !== undefined) trackDetachedChildProcess(child);
	return {
		child,
		stop: () => {
			killChildProcessTree(child, exited);
		},
		finish: () => {
			releaseRetainedWindowsProcessExitHandle(child);
			if (pid !== undefined) untrackDetachedChildPid(pid);
		},
	};
}

function holdDescendantsStatus(pid: number): processTreeContainment.ProcessDescendantsHold {
	if (processTreeContainment.holdProcessDescendantsResult !== undefined) {
		return processTreeContainment.holdProcessDescendantsResult(pid);
	}
	const held = processTreeContainment.holdProcessDescendants?.(pid);
	return held === undefined ? { kind: "unavailable" } : { kind: "held", held };
}

/**
 * Kill every tracked detached child and its tree, except those in `spare`, which stay tracked: their owner stops them
 * itself, and a later call without `spare` still kills them. Also ends the tree of every shell {@link spawnShellProcess}
 * started in a job whose command is not done.
 */
export function killTrackedDetachedChildren(spare?: ReadonlySet<number>): void {
	for (const endTree of runningShellTrees) endTree();
	runningShellTrees.clear();
	for (const [pid, entry] of trackedDetachedChildPids) {
		if (spare?.has(pid)) continue;
		if (entry.child !== undefined) {
			killChildProcessTree(entry.child, entry.exited);
		} else if (!entry.exited) {
			if (process.platform === "win32") {
				// Without a live ChildProcess handle on Windows, terminate only when the creation time was captured
				// and verified atomically through the native module; never kill an unverified bare PID.
				if (typeof entry.created === "string") {
					processStartToken.nativeTerminateProcess?.(pid, entry.created, true);
				}
			} else {
				killProcessTree(pid);
			}
		} else if (process.platform !== "win32") {
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
 * while its descendants do, is signalled, and on Windows nothing is killed by pid. While the root runs, on Windows
 * the native handle-held walk ends it and its verified descendants synchronously; only when the native module is
 * unavailable does it fall back to `taskkill` and then the root's handle.
 * A child that never started (no pid) has nothing to kill: Node reports its failure as an `error` event, and on
 * Windows its `kill()` throws.
 */
export function killChildProcessTree(
	child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">,
	exited: boolean,
): void {
	const pid = child.pid;
	if (pid === undefined) return;
	if (pid === process.pid) {
		if (process.platform !== "win32") child.kill("SIGKILL");
		return;
	}
	if (process.platform === "win32") {
		if (exited || child.exitCode !== null || child.signalCode !== null) return;
		const hold = holdDescendantsStatus(pid);
		if (hold.kind === "held") {
			if (!hold.held.endAll() && child.exitCode === null && child.signalCode === null) {
				try {
					child.kill("SIGKILL");
				} catch {}
			}
			return;
		}
		if (hold.kind === "absent") {
			if (child.exitCode === null && child.signalCode === null) {
				try {
					child.kill("SIGKILL");
				} catch {}
			}
			return;
		}
		taskkillTree(
			pid,
			() => {
				if (child.exitCode === null && child.signalCode === null) {
					try {
						child.kill("SIGKILL");
					} catch {}
				}
			},
			() => child.exitCode === null && child.signalCode === null,
		);
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

function taskkillTree(pid: number, settled?: () => void, shouldProceed?: () => boolean): void {
	// Use the trusted System32 executable so cleanup does not depend on PATH.
	const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
	const taskkillPath = join(systemRoot, "System32", "taskkill.exe");
	let done = false;
	const finish = () => {
		if (done) return;
		done = true;
		settled?.();
	};
	const attempt = (cwd: string | undefined, allowRetry: boolean): void => {
		if (shouldProceed !== undefined && !shouldProceed()) {
			finish();
			return;
		}
		try {
			const child = spawn(taskkillPath, ["/F", "/T", "/PID", String(pid)], {
				// In a safe directory outside the project: a kill never keeps the folder Atomic runs in in use.
				...(cwd === undefined ? {} : { cwd }),
				stdio: "ignore",
				detached: true,
				// `detached` gives the child its own console on Windows unless this is
				// set, so omitting it both flashes a window and pays for a console
				// allocation on every tree kill. Every other spawn in the fork sets it.
				windowsHide: true,
				env: createChildProcessEnvironment(),
			});
			// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
			child.once("error", (error: NodeJS.ErrnoException) => {
				if (allowRetry && error.code === "ENOENT") {
					void resolveSafeWindowsWorkingDirectoryAsync({
						commandPath: taskkillPath,
						preferCommandDir: true,
						timeoutMs: DEFAULT_WINDOWS_CWD_TIMEOUT_MS,
					})
						.then((freshCwd) => {
							if (done) return;
							if (shouldProceed !== undefined && !shouldProceed()) {
								finish();
								return;
							}
							if (freshCwd !== undefined && freshCwd.toLowerCase() !== (cwd ?? "").toLowerCase()) {
								attempt(freshCwd, false);
								return;
							}
							finish();
						})
						.catch(() => finish());
					return;
				}
				finish();
			});
			child.once("exit", finish);
		} catch {
			finish();
		}
	};
	attempt(resolveSafeWindowsKillCwdLexical({ commandPath: taskkillPath }), true);
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		const hold = holdDescendantsStatus(pid);
		if (hold.kind === "held") {
			hold.held.endAll();
			return;
		}
		if (hold.kind === "absent") return;
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
