import * as path from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { cleanupOldNestedRuntimeDirs } from "../runs/inprocess/runtime-support/nested-api.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "../shared/artifacts.ts";
import { cleanupOldChainDirs } from "../shared/settings.ts";
import type { SubagentState } from "../shared/types.ts";

export interface SubagentStartupMaintenance {
	scheduleStartupCleanup(): void;
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
		scheduleStartupCleanup() {
			schedule(() => {
				swallowCleanup(cleanupOldChainDirs);
				swallowCleanup(() => cleanupOldNestedRuntimeDirs(options.artifactCleanupDays));
				scheduleDelayed(
					() => swallowCleanup(() => cleanupAllArtifactDirs(options.artifactCleanupDays, contextSessionsRoots)),
					STARTUP_ARTIFACT_SCAN_DELAY_MS,
				);
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
