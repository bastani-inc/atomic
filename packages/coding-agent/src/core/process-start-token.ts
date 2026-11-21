import { type ChildProcess, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { createModuleRequire } from "../utils/module-require.js";
import { windowsPowerShellEnvironment } from "../utils/windows-powershell.ts";

/**
 * When process `pid` of this host started, as `sha12` of a start that no later process given the same id shares, so a
 * holder named by its pid is told apart from that later process (#4990, #5141); undefined where that cannot be read:
 * on platforms other than Linux and Windows, or once the process is gone.
 *
 * On Linux it is the boot and the process's start time since boot, from `/proc`. On Windows it is the process's
 * creation time, read by the native module. Where that is not available it is read by a bounded PowerShell query that
 * never blocks the main thread (#5315): this answers with what such a query already read, and otherwise starts one and
 * answers undefined; {@link readProcessStartToken} waits for it.
 */
export function processStartToken(pid: number): string | undefined {
	if (process.platform !== "win32") return procStartToken(pid);
	const native = nativeCreationTime();
	if (native !== null) return windowsStartToken(nativeCreation(native, pid));
	const known = knownFallbackCreation(pid);
	if (known === undefined) void readFallbackCreation(pid);
	return windowsStartToken(known?.created);
}

export async function readProcessStartToken(pid: number): Promise<string | undefined> {
	if (process.platform !== "win32") return procStartTokenAsync(pid);
	const native = nativeCreationTime();
	if (native !== null) return windowsStartToken(nativeCreation(native, pid));
	return windowsStartToken(await readFallbackCreation(pid));
}

export async function processStartTokenAsync(pid: number): Promise<string | undefined> {
	return readProcessStartToken(pid);
}

/**
 * When Windows process `pid` was created, as the decimal count of 100-nanosecond intervals since 1601-01-01 UTC, read
 * now: never an answer remembered from an earlier read, which may describe an earlier process given the same id (#6133).
 * Read by the native module, or where that is not available by a bounded PowerShell query. Undefined where it cannot be
 * read: on platforms other than Windows, once the process is gone, or when the query fails.
 */
export async function readProcessCreationTime(pid: number): Promise<string | undefined> {
	if (process.platform !== "win32") return undefined;
	const native = nativeCreationTime();
	if (native !== null) return nativeCreation(native, pid);
	return (await queryCreationTime(pid)).created;
}

/**
 * When Windows process `pid` was created, as {@link readProcessCreationTime} reads it, but only from the native module:
 * null where that module cannot read the process (it is gone, has exited, or may not be queried), and undefined where
 * there is no native reader to ask (other platforms, or a native module without it). Never starts a process.
 */
export function nativeProcessCreationTime(pid: number): string | null | undefined {
	if (process.platform !== "win32") return undefined;
	const native = nativeCreationTime();
	return native === null ? undefined : (nativeCreation(native, pid) ?? null);
}

export function processStartTokenForSynchronousTakeover(pid: number): string | undefined {
	if (process.platform !== "win32") return procStartToken(pid);
	const native = nativeCreationTime();
	if (native !== null) return windowsStartToken(nativeCreation(native, pid));
	const known = knownFallbackCreation(pid);
	if (known !== undefined) return windowsStartToken(known.created);
	let answer: FallbackAnswer;
	try {
		const output = execFileSync(fallbackQuery.file, fallbackQuery.args(pid), {
			cwd: process.env.SystemRoot || process.env.windir || "C:\\Windows",
			encoding: "utf8",
			env: windowsPowerShellEnvironment(),
			windowsHide: true,
			timeout: FALLBACK_TIMEOUT_MS,
			killSignal: "SIGKILL",
			maxBuffer: 1024,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		answer = { created: CREATION_TIME.test(output) ? output : undefined, unstartable: false };
	} catch (error) {
		answer = { created: undefined, unstartable: (error as NodeJS.ErrnoException).code === "ENOENT" };
	}
	rememberFallbackCreation(pid, answer);
	return windowsStartToken(answer.created);
}

function procStartToken(pid: number): string | undefined {
	try {
		return linuxStartToken(readFileSync(`/proc/${pid}/stat`, "utf8"), readFileSync(BOOT_ID, "utf8"));
	} catch {
		return undefined;
	}
}

async function procStartTokenAsync(pid: number): Promise<string | undefined> {
	try {
		return linuxStartToken(await readFile(`/proc/${pid}/stat`, "utf8"), await readFile(BOOT_ID, "utf8"));
	} catch {
		return undefined;
	}
}

const BOOT_ID = "/proc/sys/kernel/random/boot_id";
const OWN_PROC_START = process.platform === "win32" ? undefined : procStartToken(process.pid);

export function ownProcessStartToken(): string | undefined {
	if (process.platform !== "win32") return OWN_PROC_START;
	const native = nativeCreationTime();
	if (native !== null) return windowsStartToken(nativeCreation(native, process.pid));
	const known = knownFallbackCreation(process.pid);
	if (known === undefined) void readFallbackCreation(process.pid);
	return windowsStartToken(known?.created);
}

function linuxStartToken(stat: string, bootId: string): string | undefined {
	// Fields after the command name, which may hold spaces and parentheses: the start time is the 22nd field.
	const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	const boot = bootId.trim();
	if (started === undefined || !/^\d+$/.test(started) || boot === "") return undefined;
	return sha12(`${boot}\n${started}`);
}

function windowsStartToken(created: string | undefined): string | undefined {
	return created === undefined ? undefined : sha12(`windows\n${created}`);
}

function sha12(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

type CreationTimeReader = (pid: number) => string | null;

let nativeReader: CreationTimeReader | null | undefined;

/** The native module's `processCreationTime`, or null where the module or that binding (added in #5141) is missing. */
function nativeCreationTime(): CreationTimeReader | null {
	if (nativeReader === undefined) {
		try {
			const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
				processCreationTime?: CreationTimeReader;
			};
			nativeReader = binding.processCreationTime ?? null;
		} catch {
			nativeReader = null;
		}
	}
	return nativeReader;
}

const CREATION_TIME = /^[1-9]\d*$/;

/** Process `pid`'s creation time in 100-nanosecond intervals since 1601 UTC, as the native module reads it. */
function nativeCreation(native: CreationTimeReader, pid: number): string | undefined {
	try {
		const created = native(pid);
		return created !== null && CREATION_TIME.test(created) ? created : undefined;
	} catch {
		return undefined;
	}
}

type CreationTimeQuery = {
	readonly file: string;
	readonly args: (pid: number) => readonly string[];
};

const POWERSHELL_QUERY: CreationTimeQuery = {
	/** Windows PowerShell where Windows installs it, never a `powershell.exe` the working directory may hold. */
	get file() {
		return win32.join(
			process.env.SystemRoot || process.env.windir || "C:\\Windows",
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		);
	},
	args: (pid) => [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and -not $p.HasExited) { $p.StartTime.ToFileTimeUtc() }`,
	],
};

/** How long the fallback's PowerShell query may take before the start is judged unreadable. */
const FALLBACK_TIMEOUT_MS = 5_000;
/** How long a creation time the fallback read is reused: each read starts PowerShell. */
const FALLBACK_CACHE_MS = 5_000;

interface FallbackAnswer {
	readonly created: string | undefined;
	readonly unstartable: boolean;
}

const UNREAD: FallbackAnswer = { created: undefined, unstartable: false };

let fallbackQuery = POWERSHELL_QUERY;
let fallbackGeneration = 0;
let fallbackBroken = false;
let ownCreation: string | undefined;
const fallbackReads = new Map<number, { readonly at: number; readonly created: string | undefined }>();
const pendingReads = new Map<number, { readonly reading: Promise<string | undefined>; superseded: boolean }>();
const runningQueries = new Set<ChildProcess>();

function knownFallbackCreation(pid: number): { readonly created: string | undefined } | undefined {
	if (pid === process.pid && ownCreation !== undefined) return { created: ownCreation };
	if (fallbackBroken) return { created: undefined };
	const cached = fallbackReads.get(pid);
	return cached !== undefined && Date.now() - cached.at < FALLBACK_CACHE_MS ? cached : undefined;
}

function readFallbackCreation(pid: number): Promise<string | undefined> {
	const known = knownFallbackCreation(pid);
	if (known !== undefined) return Promise.resolve(known.created);
	const pending = pendingReads.get(pid);
	if (pending !== undefined) return pending.reading;
	const generation = fallbackGeneration;
	const current = {
		superseded: false,
		reading: queryCreationTime(pid).then((answer) => {
			if (generation !== fallbackGeneration) return undefined;
			pendingReads.delete(pid);
			if (current.superseded) return knownFallbackCreation(pid)?.created;
			rememberFallbackCreation(pid, answer);
			return answer.created;
		}),
	};
	pendingReads.set(pid, current);
	return current.reading;
}

function rememberFallbackCreation(pid: number, { created, unstartable }: FallbackAnswer): void {
	const pending = pendingReads.get(pid);
	if (pending !== undefined) pending.superseded = true;
	fallbackBroken ||= unstartable;
	const now = Date.now();
	for (const [read, { at }] of fallbackReads) if (now - at >= FALLBACK_CACHE_MS) fallbackReads.delete(read);
	fallbackReads.set(pid, { at: now, created });
	if (pid === process.pid && created !== undefined) ownCreation = created;
}

function queryCreationTime(pid: number): Promise<FallbackAnswer> {
	return new Promise((resolve) => {
		let bound: ReturnType<typeof setTimeout> | undefined;
		const answer = (value: FallbackAnswer) => {
			clearTimeout(bound);
			resolve(value);
		};
		let child: ChildProcess;
		try {
			child = execFile(
				fallbackQuery.file,
				fallbackQuery.args(pid),
				{
					cwd: process.env.SystemRoot || process.env.windir || "C:\\Windows",
					encoding: "utf8",
					env: windowsPowerShellEnvironment(),
					windowsHide: true,
				},
				(error, stdout) => {
					runningQueries.delete(child);
					const output = stdout.trim();
					answer({
						created: error === null && CREATION_TIME.test(output) ? output : undefined,
						unstartable: (error as NodeJS.ErrnoException | null)?.code === "ENOENT",
					});
				},
			);
		} catch {
			answer(UNREAD);
			return;
		}
		runningQueries.add(child);
		bound = setTimeout(() => {
			child.kill();
			answer(UNREAD);
		}, FALLBACK_TIMEOUT_MS);
	});
}

function resetFallback(): void {
	fallbackGeneration++;
	for (const child of runningQueries) child.kill();
	runningQueries.clear();
	pendingReads.clear();
	fallbackReads.clear();
	fallbackBroken = false;
	ownCreation = undefined;
}

/** Test seam: replaces the native reader (`null` forces the PowerShell fallback); `undefined` restores loading. */
export function setNativeProcessCreationTimeForTesting(reader: CreationTimeReader | null | undefined): void {
	nativeReader = reader;
	resetFallback();
}

export function setProcessCreationTimeQueryForTesting(query: CreationTimeQuery | undefined): void {
	fallbackQuery = query ?? POWERSHELL_QUERY;
	resetFallback();
}
