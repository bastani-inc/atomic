import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { createResultWatcher } from "../runs/background/result-watcher.ts";
import { cleanupOldNestedRuntimeDirs } from "../runs/inprocess/runtime-support/nested-api.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "../shared/artifacts.ts";
import { cleanupOldChainDirs } from "../shared/settings.ts";
import type { SubagentState } from "../shared/types.ts";

export interface SubagentStartupMaintenance {
	scheduleStartupCleanup(): void;
	startResultWatcherDeferred(): void;
	primeExistingResultsDeferred(): void;
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

export function createSubagentStartupMaintenance(
	pi: ExtensionAPI,
	state: SubagentState,
	options: {
		resultsDir: string;
		artifactCleanupDays: number;
		resultTtlMs: number;
		scheduleMacrotask?: (task: () => void) => () => void;
		scheduleDelayed?: (task: () => void, delayMs: number) => () => void;
	},
): SubagentStartupMaintenance {
	const { startResultWatcher, primeExistingResults, stopResultWatcher } = createResultWatcher(
		pi,
		state,
		options.resultsDir,
		options.resultTtlMs,
	);
	const cancelTasks = new Set<() => void>();
	// The sessions root derived from a host-provided (non-default, e.g. isolated
	// programmatic agentDir) session directory. When set, the global artifact scan
	// stays inside it instead of touching the real global/legacy sessions roots.
	// A custom session dir that does not follow the <agentDir>/sessions/<safe-cwd>
	// layout (the default layout the SDK derives for a programmatic agentDir, with
	// <safe-cwd> encoding the current working directory) yields no roots at all, so
	// cleanup never broadens into an arbitrary directory's siblings.
	let contextSessionsRoots: readonly string[] | undefined;
	const noteSessionContext = (ctx: ExtensionContext): void => {
		try {
			if (ctx.sessionManager.usesDefaultSessionDir()) {
				// Only a valid default-session context intentionally restores the
				// env/global cleanup roots.
				contextSessionsRoots = undefined;
				return;
			}
			const sessionDir = ctx.sessionManager.getSessionDir();
			// A partial or throwing context keeps the last validated root: destructive
			// cleanup must never broaden from an isolated root to the global roots on
			// the strength of an unusable context.
			if (!sessionDir) return;
			const parent = path.dirname(sessionDir);
			const safeCwd = `--${path
				.resolve(ctx.cwd)
				.replace(/^[/\\]/, "")
				.replace(/[/\\:]/g, "-")}--`;
			const followsAgentDirLayout = path.basename(parent) === "sessions" && path.basename(sessionDir) === safeCwd;
			contextSessionsRoots = followsAgentDirLayout ? [parent] : [];
		} catch {
			// A stale or partial context leaves cleanup on the env/global fallback.
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
				// The global session-artifact scan can touch thousands of historical session
				// directories, so it waits until well after startup instead of running on the
				// activation macrotask.
				scheduleDelayed(
					() => swallowCleanup(() => cleanupAllArtifactDirs(options.artifactCleanupDays, contextSessionsRoots)),
					STARTUP_ARTIFACT_SCAN_DELAY_MS,
				);
			});
		},
		startResultWatcherDeferred() {
			schedule(startResultWatcher);
		},
		primeExistingResultsDeferred() {
			schedule(primeExistingResults);
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
			stopResultWatcher();
		},
	};
}
