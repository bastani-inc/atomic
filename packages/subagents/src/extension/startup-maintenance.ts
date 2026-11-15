import * as path from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { cleanupOldSubagentRuntimeDirs } from "../runs/inprocess/runtime-support/temp-cleanup.js";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "../shared/artifacts.js";
import type { SubagentState } from "../shared/types.js";

export interface SubagentStartupMaintenance {
	/** Schedules the startup scans; `onDone` runs once the deferred global scan has run. */
	scheduleStartupCleanup(onDone?: () => void): void;
	cleanupSessionArtifactsDeferred(ctx: ExtensionContext): void;
	stop(): void;
}

/** How long after startup to defer the slow global session-artifact scan. */
export const STARTUP_ARTIFACT_SCAN_DELAY_MS = 10 * 60 * 1000;

function scheduleMacrotask(task: () => void): () => void {
	let cancelled = false;
	const handle = setImmediate(() => {
		if (!cancelled) task();
	});
	handle.unref?.();
	return () => {
		cancelled = true;
		clearImmediate(handle);
	};
}

function scheduleDelayedTask(task: () => void, delayMs: number): () => void {
	let cancelled = false;
	const handle = setTimeout(() => {
		if (!cancelled) task();
	}, delayMs);
	handle.unref?.();
	return () => {
		cancelled = true;
		clearTimeout(handle);
	};
}

function swallowCleanup(task: () => void): void {
	try {
		task();
	} catch {}
}

interface StartupMaintenanceOptions {
	artifactCleanupDays: number;
	resultsDir?: string;
	resultTtlMs?: number;
	scheduleMacrotask?: (task: () => void) => () => void;
	scheduleDelayed?: (task: () => void, delayMs: number) => () => void;
}

export function createSubagentStartupMaintenance(
	state: SubagentState,
	options: StartupMaintenanceOptions,
): SubagentStartupMaintenance;
export function createSubagentStartupMaintenance(
	_pi: unknown,
	state: SubagentState,
	options: StartupMaintenanceOptions,
): SubagentStartupMaintenance;
export function createSubagentStartupMaintenance(
	_first: SubagentState | unknown,
	second: StartupMaintenanceOptions | SubagentState,
	third?: StartupMaintenanceOptions,
): SubagentStartupMaintenance {
	const options = third ?? (second as StartupMaintenanceOptions);
	const cancelTasks = new Set<() => void>();
	let contextSessionsRoots: readonly string[] | undefined;
	const noteSessionContext = (ctx: ExtensionContext): void => {
		try {
			if (ctx.sessionManager.usesDefaultSessionDir()) {
				contextSessionsRoots = undefined;
				return;
			}
			const sessionDir = ctx.sessionManager.getSessionDir();
			if (!sessionDir) return;
			const parent = path.dirname(sessionDir);
			const safeCwd = `--${path
				.resolve(ctx.cwd)
				.replace(/^[/\\]/, "")
				.replace(/[/\\:]/g, "-")}--`;
			contextSessionsRoots =
				path.basename(parent) === "sessions" && path.basename(sessionDir) === safeCwd ? [parent] : [];
		} catch {
			// A stale or partial context leaves cleanup on the last validated root.
		}
	};
	const schedule = (task: () => void): void => {
		const cancel = (options.scheduleMacrotask ?? scheduleMacrotask)(() => {
			cancelTasks.delete(cancel);
			task();
		});
		cancelTasks.add(cancel);
	};
	const scheduleDelayed = (task: () => void, delayMs: number): void => {
		const cancel = (options.scheduleDelayed ?? scheduleDelayedTask)(() => {
			cancelTasks.delete(cancel);
			task();
		}, delayMs);
		cancelTasks.add(cancel);
	};

	return {
		scheduleStartupCleanup(onDone) {
			schedule(() => {
				swallowCleanup(() => cleanupOldSubagentRuntimeDirs(options.artifactCleanupDays));
				scheduleDelayed(() => {
					swallowCleanup(() => cleanupAllArtifactDirs(options.artifactCleanupDays, contextSessionsRoots));
					onDone?.();
				}, STARTUP_ARTIFACT_SCAN_DELAY_MS);
			});
		},
		cleanupSessionArtifactsDeferred(ctx) {
			noteSessionContext(ctx);
			let sessionFile: string | null | undefined;
			try {
				sessionFile = ctx.sessionManager.getSessionFile();
			} catch {
				return;
			}
			if (!sessionFile) return;
			schedule(() =>
				swallowCleanup(() => cleanupOldArtifacts(getArtifactsDir(sessionFile), options.artifactCleanupDays)),
			);
		},
		stop() {
			for (const cancel of cancelTasks) cancel();
			cancelTasks.clear();
		},
	};
}

/** Which session's maintenance runs the process's startup scans, which sessions wait to, and whether they ran. */
interface StartupCleanupClaim {
	holder?: SubagentStartupMaintenance;
	readonly waiting: Set<SubagentStartupMaintenance>;
	done: boolean;
}

const STARTUP_CLEANUP_CLAIM = Symbol.for("atomic.subagents.startupCleanupClaim");

function startupCleanupClaim(): StartupCleanupClaim {
	const scope = globalThis as { [STARTUP_CLEANUP_CLAIM]?: StartupCleanupClaim };
	scope[STARTUP_CLEANUP_CLAIM] ??= { waiting: new Set(), done: false };
	return scope[STARTUP_CLEANUP_CLAIM];
}

function holdStartupCleanup(claim: StartupCleanupClaim, maintenance: SubagentStartupMaintenance): void {
	claim.holder = maintenance;
	maintenance.scheduleStartupCleanup(() => {
		claim.done = true;
		claim.waiting.clear();
		if (claim.holder === maintenance) claim.holder = undefined;
	});
}

/**
 * Schedules the startup scans with `maintenance` unless another session's maintenance already holds them or they
 * already ran: they are process-wide housekeeping, so a supervisor launching hundreds of children runs them once, not
 * once per child (#5186). Returns the release `maintenance` calls when it stops: a holder that stops before they ran
 * hands them to a session still waiting for them.
 */
export function claimStartupCleanup(maintenance: SubagentStartupMaintenance): () => void {
	const claim = startupCleanupClaim();
	if (claim.done) return () => undefined;
	if (claim.holder === undefined) holdStartupCleanup(claim, maintenance);
	else claim.waiting.add(maintenance);
	return () => {
		claim.waiting.delete(maintenance);
		if (claim.holder !== maintenance) return;
		claim.holder = undefined;
		if (claim.done) return;
		const [next] = claim.waiting;
		if (next === undefined) return;
		claim.waiting.delete(next);
		holdStartupCleanup(claim, next);
	};
}
