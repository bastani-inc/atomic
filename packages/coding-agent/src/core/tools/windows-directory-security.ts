/**
 * Windows owner-SID and DACL verification for the session temp tree.
 *
 * POSIX proves ownership of an existing temp component with a uid comparison
 * and a mode check. Node exposes neither on Windows — `lstatSync` reports
 * uid/gid 0 — so this module reads the real security descriptor and decides
 * from SIDs alone: the owner must
 * be a trusted principal and every access-allowed ACE must grant only trusted
 * principals. Names are never compared; two accounts can share a display name,
 * but never a SID.
 *
 * The native module reads the descriptor directly. When that binding is
 * unavailable or cannot read the directory, an asynchronous PowerShell
 * subprocess reads it instead. Reads start after the synchronous caller
 * returns, so a synchronous check never reads the descriptor. A successful
 * verification is cached for the life of the process, keyed to the
 * directory's path and identity (its file ID and creation time),
 * and a directory inside a verified one needs no read of its own (see
 * `verifyWindowsDirectorySecurityAsync`). A directory swapped underneath the
 * path is a new file with a new ID and is read again.
 * Failures are not cached: a refusal means "no spill file this time", and a
 * transient read failure must not disable persistence for the rest of the
 * process.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { stat as statAsync } from "node:fs/promises";
import type { Socket } from "node:net";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { clearTimeout, setTimeout } from "node:timers";
import { createModuleRequire } from "../../utils/module-require.js";
import { windowsPowerShellEnvironment } from "../../utils/windows-powershell.ts";

import {
	evaluateWindowsDirectorySecurity,
	type WindowsAccessRule,
	type WindowsDirectorySecurity,
} from "./windows-directory-descriptor.ts";

export {
	evaluateWindowsDirectorySecurity,
	type WindowsAccessRule,
	type WindowsDirectorySecurity,
} from "./windows-directory-descriptor.ts";

/**
 * One PowerShell round trip: the caller's SID, the owner SID, the DACL in
 * SDDL form, and one `Allow|Deny;SID` line per resolved access rule. The path
 * travels through the environment rather than the command line so no quoting
 * rules apply to it.
 */
const READ_SECURITY_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"$acl = Get-Acl -LiteralPath $env:ATOMIC_SECURITY_QUERY_PATH",
	"$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
	"$dacl = $acl.GetSecurityDescriptorSddlForm('Access')",
	"$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
	"$lines = @($user, $owner, $dacl)",
	"foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))" +
		' { $lines += "$($rule.AccessControlType);$($rule.IdentityReference.Value)" }',
	'[Console]::Out.Write(($lines -join "`n"))',
].join("; ");

/** Bounded wait for the security read; a wedged subprocess must not hang a spill. */
const READ_SECURITY_TIMEOUT_MS = 30_000;

export const VERIFICATION_PENDING_REASON = "its ownership is still being verified";

/** PowerShell hosts to try, most specific first: an absolute Windows
 * PowerShell path immune to a stripped `PATH`, then whichever of
 * `powershell.exe`/`pwsh.exe` the environment resolves. */
export function powershellCandidates(): string[] {
	const candidates: string[] = [];
	candidates.push(`${windowsDirectory()}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
	candidates.push("powershell.exe", "pwsh.exe");
	return candidates;
}

/** The environment for a PowerShell read: Windows PowerShell's, plus the path the read is for. */
function powershellEnvironment(path: string): NodeJS.ProcessEnv {
	return { ...windowsPowerShellEnvironment(), ATOMIC_SECURITY_QUERY_PATH: path };
}

function windowsDirectory(): string {
	return process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
}

async function neutralWorkingDirectory(): Promise<string | undefined> {
	try {
		return (await statAsync(windowsDirectory())).isDirectory() ? windowsDirectory() : undefined;
	} catch {
		return undefined;
	}
}

let lastReadFailure: string | undefined;

/** Test seam: why the most recent descriptor read returned `undefined`. */
export function getLastWindowsSecurityReadFailureForTesting(): string | undefined {
	return lastReadFailure;
}

type NativeSecurityReader = (path: string) => Promise<WindowsDirectorySecurity | null | undefined>;

let nativeReader: NativeSecurityReader | null | undefined;

function nativeSecurityReader(): NativeSecurityReader | null {
	if (nativeReader === undefined) {
		try {
			const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
				windowsDirectorySecurityAsync?: NativeSecurityReader;
			};
			nativeReader = binding.windowsDirectorySecurityAsync ?? null;
		} catch {
			nativeReader = null;
		}
	}
	return nativeReader;
}

async function readNatively(path: string): Promise<WindowsDirectorySecurity | null> {
	const native = nativeSecurityReader();
	if (native === null) {
		return null;
	}
	try {
		return (await native(path)) ?? null;
	} catch {
		return null;
	}
}

export interface ReadWindowsDirectorySecurityOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	background?: boolean;
	identity?: string;
}

type SecurityAttempt = { security: WindowsDirectorySecurity } | { failure: string };

type ChildStream = (Readable & Partial<Pick<Socket, "ref" | "unref">>) | null;

const outsideAnyCaller = AsyncLocalStorage.snapshot();

const sharedReads = new Map<string, SharedSecurityRead>();
const currentReadOwner = new AsyncLocalStorage<WeakRef<AbortSignal>>();
const ownedReads = new WeakMap<AbortSignal, Set<Promise<void>>>();
const activeReads = new Set<Promise<void>>();

export function trackWindowsDirectorySecurityWork<T>(operation: () => Promise<T>): Promise<T> {
	const owner = currentReadOwner.getStore()?.deref();
	const result = operation();
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	activeReads.add(settled);
	const pending = owner ? (ownedReads.get(owner) ?? new Set<Promise<void>>()) : undefined;
	if (owner && pending) ownedReads.set(owner, pending);
	pending?.add(settled);
	void settled.then(() => {
		activeReads.delete(settled);
		pending?.delete(settled);
	});
	return result;
}
const closingReads = new Set<SharedSecurityRead>();

export function withWindowsDirectorySecurityOwner<T>(
	signal: AbortSignal,
	operation: () => T,
	options: { inherit?: boolean } = {},
): T {
	const inheritedOwner = options.inherit ? currentReadOwner.getStore()?.deref() : undefined;
	return currentReadOwner.run(new WeakRef(inheritedOwner ?? signal), operation);
}

export async function drainWindowsDirectorySecurityReads(signal: AbortSignal): Promise<void> {
	const pending = ownedReads.get(signal);
	while (pending?.size) await Promise.all(pending);
}

class SharedSecurityRead {
	readonly result: Promise<WindowsDirectorySecurity | undefined>;
	private readonly controller = new AbortController();
	private waiters = 0;
	private foregroundWaiters = 0;
	private child: ChildProcess | undefined;
	private finished = false;
	private readonly path: string;
	private readonly key: string;

	constructor(path: string, key: string) {
		this.path = path;
		this.key = key;
		this.result = outsideAnyCaller(() => Promise.resolve().then(() => this.readCandidates())).finally(() => {
			if (sharedReads.get(key) === this) sharedReads.delete(key);
			this.finished = true;
			closingReads.delete(this);
		});
	}

	join(
		timeoutMs: number,
		signal: AbortSignal | undefined,
		background: boolean,
	): Promise<WindowsDirectorySecurity | undefined> {
		this.waiters += 1;
		if (!background) this.foregroundWaiters += 1;
		this.applyKeepAlive();
		return new Promise((resolve) => {
			let left = false;
			const leave = (security: WindowsDirectorySecurity | undefined) => {
				if (left) return;
				left = true;
				clearTimeout(deadline);
				signal?.removeEventListener("abort", stopWaiting);
				this.waiters -= 1;
				if (!background) this.foregroundWaiters -= 1;
				if (this.waiters === 0) {
					this.cancel();
					void this.result.then(
						() => resolve(security),
						() => resolve(undefined),
					);
				} else {
					this.applyKeepAlive();
					resolve(security);
				}
			};
			const stopWaiting = () => leave(undefined);
			const deadline = setTimeout(stopWaiting, timeoutMs);
			if (background) deadline.unref();
			signal?.addEventListener("abort", stopWaiting, { once: true });
			void this.result.then(leave, () => leave(undefined));
		});
	}

	cancel(): void {
		if (sharedReads.get(this.key) === this) sharedReads.delete(this.key);
		if (!this.finished) closingReads.add(this);
		this.controller.abort();
	}

	private async readCandidates(): Promise<WindowsDirectorySecurity | undefined> {
		if (this.controller.signal.aborted) return undefined;
		lastReadFailure = undefined;
		const security = await readNatively(this.path);
		if (this.controller.signal.aborted) return undefined;
		if (security !== null) return security;
		const failures: string[] = [];
		for (const executable of powershellCandidates()) {
			if (this.controller.signal.aborted) break;
			const attempt = await this.readWith(executable);
			if ("security" in attempt) return attempt.security;
			failures.push(attempt.failure);
		}
		lastReadFailure = failures.join(" | ");
		return undefined;
	}

	private async readWith(executable: string): Promise<SecurityAttempt> {
		const cwd = await neutralWorkingDirectory();
		if (this.controller.signal.aborted) return { failure: `${executable}: aborted` };
		return new Promise((resolve) => {
			let child: ChildProcess;
			try {
				child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", READ_SECURITY_SCRIPT], {
					cwd,
					env: powershellEnvironment(this.path),
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
			} catch (error) {
				resolve({ failure: `${executable}: error=${error instanceof Error ? error.message : String(error)}` });
				return;
			}
			this.child = child;
			this.applyKeepAlive();
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
			child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
			let settled = false;
			const settle = (attempt: SecurityAttempt) => {
				if (settled) return;
				settled = true;
				this.child = undefined;
				this.controller.signal.removeEventListener("abort", stop);
				resolve(attempt);
			};
			let failure: string | undefined;
			let stopping = false;
			const stop = () => {
				failure ??= `${executable}: aborted`;
				if (stopping) return;
				stopping = true;
				child.ref();
				child.kill();
				child.stdout?.destroy();
				child.stderr?.destroy();
			};
			this.controller.signal.addEventListener("abort", stop, { once: true });
			const fail = (error: Error) => {
				failure ??= `${executable}: error=${error.message}`;
				stop();
			};
			child.on("error", fail);
			child.stdout?.on("error", fail);
			child.stderr?.on("error", fail);
			child.once("close", (status, signal) => {
				if (failure !== undefined) {
					settle({ failure });
					return;
				}
				const output = Buffer.concat(stdout).toString("utf8");
				if (status !== 0) {
					const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 500);
					settle({ failure: `${executable}: status=${status} signal=${signal} stderr=${detail}` });
					return;
				}
				const security = parseSecurityOutput(output);
				settle(
					security === undefined
						? { failure: `${executable}: unparseable output ${JSON.stringify(output.slice(0, 500))}` }
						: { security },
				);
			});
		});
	}

	private applyKeepAlive(): void {
		const child = this.child;
		if (child === undefined) return;
		const keepAlive = this.foregroundWaiters > 0;
		if (keepAlive) child.ref();
		else child.unref();
		const streams: ChildStream[] = [child.stdout, child.stderr];
		for (const stream of streams) {
			if (keepAlive) stream?.ref?.();
			else stream?.unref?.();
		}
	}
}

/**
 * Read the security descriptor of `path` without blocking the main thread, or
 * `undefined` when it cannot be read (access denied, missing PowerShell, the
 * timeout, an aborted signal). Callers treat `undefined` as unverifiable and
 * refuse the directory.
 */
export function readWindowsDirectorySecurityAsync(
	path: string,
	options: ReadWindowsDirectorySecurityOptions = {},
): Promise<WindowsDirectorySecurity | undefined> {
	return trackWindowsDirectorySecurityWork(async () => {
		const owner = currentReadOwner.getStore()?.deref();
		const signal = owner && options.signal ? AbortSignal.any([owner, options.signal]) : (owner ?? options.signal);
		if (signal?.aborted) return undefined;
		const generation = stateGeneration;
		const resolvedPath = resolve(path);
		const identity = options.identity ?? (await identityOfAsync(resolvedPath));
		if (identity === undefined || signal?.aborted || generation !== stateGeneration) return undefined;
		const key = `${identity}\0${resolvedPath}`;
		let read = sharedReads.get(key);
		if (read === undefined) {
			read = new SharedSecurityRead(resolvedPath, key);
			sharedReads.set(key, read);
		}
		return read.join(options.timeoutMs ?? READ_SECURITY_TIMEOUT_MS, signal, options.background ?? false);
	});
}

function parseSecurityOutput(stdout: string): WindowsDirectorySecurity | undefined {
	const [currentSid, ownerSid, dacl, ...ruleLines] = stdout.split("\n").map((line) => line.trim());
	if (!currentSid || !ownerSid || dacl === undefined) {
		return undefined;
	}
	const accessRules: WindowsAccessRule[] = [];
	for (const line of ruleLines) {
		if (line.length === 0) {
			continue;
		}
		const [type, sid] = line.split(";");
		if ((type !== "Allow" && type !== "Deny") || !sid) {
			return undefined;
		}
		accessRules.push({ allow: type === "Allow", sid });
	}
	return { currentSid, ownerSid, dacl, accessRules };
}

type SecurityReader = (
	path: string,
	options: ReadWindowsDirectorySecurityOptions,
) => WindowsDirectorySecurity | undefined | Promise<WindowsDirectorySecurity | undefined>;

let securityReader: SecurityReader = readWindowsDirectorySecurityAsync;

let stateGeneration = 0;

/**
 * Verified paths mapped to the identity of the directory verified there: its volume, file ID and creation time. A
 * directory recreated at the path is a new file with a new ID; the creation time alone would not tell, since NTFS gives
 * a name recreated within seconds of its deletion the old creation time back ("tunneling").
 */
const verifiedPaths = new Map<string, string>();

/** The identity of the directory at `path`, or `undefined` when it cannot be read. */
function identityOf(path: string): string | undefined {
	try {
		const stat = statSync(path, { bigint: true });
		return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
	} catch {
		return undefined;
	}
}

async function identityOfAsync(path: string): Promise<string | undefined> {
	try {
		const stat = await statAsync(path, { bigint: true });
		return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
	} catch {
		return undefined;
	}
}

/** True when `path` was verified in this process and is still the directory verified there. */
function stillVerified(path: string, identity: string | undefined): boolean {
	return identity !== undefined && verifiedPaths.get(path) === identity;
}

function verifiedWithoutReading(path: string, identity: string): boolean {
	if (stillVerified(path, identity)) {
		return true;
	}
	const parent = dirname(path);
	if (parent !== path && stillVerified(parent, identityOf(parent))) {
		verifiedPaths.set(path, identity);
		return true;
	}
	return false;
}

/**
 * Verify `path` as adoptable, returning the refusal reason when it is not.
 *
 * The descriptor is read natively, with an asynchronous PowerShell fallback, once per private root per process:
 *
 * - A directory verified in this process is trusted for the rest of it while it is the same directory (same file ID and
 *   creation time). Only its owner or an administrator can change its DACL (the verified DACL grants nobody else that
 *   right), and both can already reach everything below it, so an in-place edit by one of them is not read again. A
 *   directory swapped underneath the path is a new file and is read again, and so is one swapped while it was read.
 * - A directory inside a verified one needs no read of its own. The verified DACL lets only trusted principals create
 *   entries in it, and grants nobody else access through inheritance either, since an inheritable entry for another
 *   account refuses the parent itself; so a directory inside it was made by a trusted principal and starts private.
 *
 * The symlink/directory checks in `session-temp-dir.ts` still run on every use. A failure is never cached, so a
 * transient read error does not permanently disable spills.
 */
export function verifyWindowsDirectorySecurityAsync(
	path: string,
	signal?: AbortSignal,
	options: { background?: boolean } = {},
): Promise<string | undefined> {
	return trackWindowsDirectorySecurityWork(async () => {
		const generation = stateGeneration;
		const resolvedPath = resolve(path);
		const identity = await identityOfAsync(resolvedPath);
		if (identity === undefined || generation !== stateGeneration) return "its ownership could not be verified";
		if (stillVerified(resolvedPath, identity)) return undefined;
		const parent = dirname(resolvedPath);
		const inherited = parent !== resolvedPath && stillVerified(parent, await identityOfAsync(parent));
		if (generation !== stateGeneration) return "its ownership could not be verified";
		if (!inherited) {
			const security = await securityReader(resolvedPath, { signal, background: options.background, identity });
			if (security === undefined) return "its ownership could not be verified";
			const refusal = evaluateWindowsDirectorySecurity(security);
			if (generation !== stateGeneration) return refusal ?? "its ownership could not be verified";
			if (refusal !== undefined) {
				if (verifiedPaths.get(resolvedPath) === identity) verifiedPaths.delete(resolvedPath);
				return refusal;
			}
		}
		if ((await identityOfAsync(resolvedPath)) !== identity || generation !== stateGeneration)
			return "its ownership could not be verified";
		verifiedPaths.set(resolvedPath, identity);
		return undefined;
	});
}

export function verifyWindowsDirectorySecurity(
	path: string,
	options: { startVerification?: boolean } = {},
): string | undefined {
	const resolvedPath = resolve(path);
	const identity = identityOf(resolvedPath);
	if (identity === undefined) {
		return "its ownership could not be verified";
	}
	if (verifiedWithoutReading(resolvedPath, identity)) {
		return undefined;
	}
	if (options.startVerification !== false) {
		verifyWindowsDirectorySecurityAsync(resolvedPath, undefined, { background: true }).catch(() => undefined);
	}
	return VERIFICATION_PENDING_REASON;
}

export async function waitForWindowsDirectorySecurityReadsForTesting(): Promise<void> {
	while (activeReads.size || sharedReads.size || closingReads.size) {
		await Promise.all([...activeReads, ...[...sharedReads.values(), ...closingReads].map((read) => read.result)]);
	}
}

/** Test seam: substitute the descriptor reader; pass `undefined` to restore. */
export function setWindowsDirectorySecurityReaderForTesting(reader: SecurityReader | undefined): void {
	securityReader = reader ?? readWindowsDirectorySecurityAsync;
}

/** Test seam: forget verified paths and cancel reads in flight so a suite can re-drive verification. */
export function resetWindowsDirectorySecurityStateForTesting(): void {
	stateGeneration += 1;
	verifiedPaths.clear();
	for (const read of [...sharedReads.values()]) read.cancel();
	sharedReads.clear();
	lastReadFailure = undefined;
	securityReader = readWindowsDirectorySecurityAsync;
}
