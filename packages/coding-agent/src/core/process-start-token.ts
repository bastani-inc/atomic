import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createModuleRequire } from "../utils/module-require.ts";

/**
 * When process `pid` of this host started, as `sha12` of a start that no later process given the same id shares, so a
 * holder named by its pid is told apart from that later process (#4990, #5141); undefined where that cannot be read:
 * on platforms other than Linux and Windows, or once the process is gone.
 *
 * On Linux it is the boot and the process's start time since boot, from `/proc`. On Windows it is the process's
 * creation time, read by the native module, or, where that is not available, by a bounded PowerShell query.
 */
export function processStartToken(pid: number): string | undefined {
	if (process.platform === "win32") {
		const created = windowsCreationTime(pid);
		return created === undefined ? undefined : sha12(`windows\n${created}`);
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// Fields after the command name, which may hold spaces and parentheses: the start time is the 22nd field.
		const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		if (started === undefined || !/^\d+$/.test(started) || boot === "") return undefined;
		return sha12(`${boot}\n${started}`);
	} catch {
		return undefined;
	}
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

/** How long the fallback's PowerShell query may take before the start is judged unreadable. */
const FALLBACK_TIMEOUT_MS = 5_000;
/** How long a creation time the fallback read is reused: each read starts PowerShell. */
const FALLBACK_CACHE_MS = 5_000;
const fallbackReads = new Map<number, { readonly at: number; readonly created: string | undefined }>();
let fallbackBroken = false;
const CREATION_TIME = /^[1-9]\d*$/;

/**
 * Process `pid`'s creation time in 100-nanosecond intervals since 1601 UTC, as the native module reads it; without the
 * native module, as PowerShell reads it, cached for a few seconds and given up on once PowerShell cannot be started.
 */
function windowsCreationTime(pid: number): string | undefined {
	const native = nativeCreationTime();
	if (native !== null) {
		try {
			const created = native(pid);
			return created !== null && CREATION_TIME.test(created) ? created : undefined;
		} catch {
			return undefined;
		}
	}
	if (fallbackBroken) return undefined;
	const now = Date.now();
	const cached = fallbackReads.get(pid);
	if (cached !== undefined && now - cached.at < FALLBACK_CACHE_MS) return cached.created;
	const result = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and -not $p.HasExited) { $p.StartTime.ToFileTimeUtc() }`,
		],
		{ encoding: "utf8", timeout: FALLBACK_TIMEOUT_MS, windowsHide: true },
	);
	// PowerShell that cannot be started never will be; one that timed out may answer the next time.
	fallbackBroken = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
	const output = result.stdout?.trim() ?? "";
	const created = CREATION_TIME.test(output) ? output : undefined;
	// Only the reads of the last few seconds are kept.
	for (const [read, { at }] of fallbackReads) if (now - at >= FALLBACK_CACHE_MS) fallbackReads.delete(read);
	fallbackReads.set(pid, { at: now, created });
	return created;
}

/** Test seam: replaces the native reader (`null` forces the PowerShell fallback); `undefined` restores loading. */
export function setNativeProcessCreationTimeForTesting(reader: CreationTimeReader | null | undefined): void {
	nativeReader = reader;
	fallbackReads.clear();
	fallbackBroken = false;
}
