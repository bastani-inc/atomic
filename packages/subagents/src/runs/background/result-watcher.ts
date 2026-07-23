import * as fs from "node:fs";
import * as path from "node:path";
import { isSafeFsWatchPathError, watchWithErrorHandler } from "@bastani/atomic";
import { createFileCoalescer } from "../../shared/file-coalescer.js";
import type { IntercomEventBus, SubagentState } from "../../shared/types.js";
import { processResultEntry, type ResultProcessorFs } from "./result-delivery-processor.js";
import { claimIdFromScheduleKey, claimScheduleKey, listResultClaims } from "./result-file-claims.js";
import { createRetryScheduler } from "./result-retry-scheduler.js";
import type { ResultFileData } from "./result-watcher-data.js";

const WATCHER_RESTART_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 3000;
const DIRECTORY_RESCAN_DELAY_MS = 50;
const STATUS_RECHECK_BASE_MS = 250;
const STATUS_RECHECK_MAX_MS = 30_000;
const DELIVERY_RETRY_BASE_MS = 1000;
const DELIVERY_RETRY_MAX_MS = 30_000;

type ResultWatcherFs = ResultProcessorFs & Pick<typeof fs, "existsSync" | "readdirSync" | "mkdirSync" | "watch">;
type ResultWatcherTimers = {
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
	setInterval: typeof setInterval;
	clearInterval: typeof clearInterval;
};
type ResultWatcherSafeWatch = typeof watchWithErrorHandler;

type ResultWatcherDeps = {
	fs?: ResultWatcherFs;
	timers?: ResultWatcherTimers;
	safeWatch?: ResultWatcherSafeWatch;
	statusRecheckBaseMs?: number;
	statusRecheckMaxMs?: number;
	deliveryRetryBaseMs?: number;
	deliveryRetryMaxMs?: number;
	maxNoProgressFailures?: number;
	intercomTimeoutMs?: number | false;
	allowedStatusRoots?: string[];
	maxStatusBytes?: number;
};

function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as NodeJS.ErrnoException).code : undefined;
}

function isNotFoundError(error: unknown): boolean {
	return getErrorCode(error) === "ENOENT";
}

function shouldFallBackToPolling(error: unknown): boolean {
	const code = getErrorCode(error);
	return code === "EMFILE" || code === "ENOSPC" || isSafeFsWatchPathError(error);
}

export function createResultWatcher(
	pi: { events: IntercomEventBus },
	state: SubagentState,
	resultsDir: string,
	completionTtlMs: number,
	deps: ResultWatcherDeps = {},
): { startResultWatcher: () => void; primeExistingResults: () => void; stopResultWatcher: () => void } {
	const fsApi = deps.fs ?? fs;
	const timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
	const safeWatch = deps.safeWatch ?? watchWithErrorHandler;
	let directoryRescanTimer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	let processingEpoch = 0;
	let watcherInstallation = 0;
	let activeWatcherInstallation = 0;
	const inFlight = new Set<string>();
	const rerunAfterFlight = new Set<string>();
	const statusRetries = createRetryScheduler(timers, deps.statusRecheckBaseMs ?? STATUS_RECHECK_BASE_MS, deps.statusRecheckMaxMs ?? STATUS_RECHECK_MAX_MS);
	const deliveryRetries = createRetryScheduler(timers, deps.deliveryRetryBaseMs ?? DELIVERY_RETRY_BASE_MS, deps.deliveryRetryMaxMs ?? DELIVERY_RETRY_MAX_MS);
	const isEpochActive = (epoch: number): boolean => !stopped && epoch === processingEpoch;
	const entryExists = (entry: string): boolean => {
		const claimId = claimIdFromScheduleKey(entry);
		return claimId ? Boolean(listResultClaims(resultsDir, fsApi).some((claim) => claim.id === claimId))
			: fsApi.existsSync(path.join(resultsDir, entry));
	};
	const ownsResult = (data: ResultFileData): boolean => !stopped
		&& (!data.sessionId || data.sessionId === state.currentSessionId)
		&& Boolean(data.sessionId || !data.cwd || (state.baseCwd && data.cwd === state.baseCwd));

	const coalescerKey = (entry: string, epoch: number): string => `${epoch}\0${entry}`;
	const parseCoalescerKey = (key: string): { epoch: number; entry: string } => {
		const split = key.indexOf("\0");
		return { epoch: Number(key.slice(0, split)), entry: key.slice(split + 1) };
	};
	const scheduleResultEntry = (entry: string, delay = 0, epoch = processingEpoch): boolean => {
		if (!isEpochActive(epoch) || statusRetries.has(entry) || deliveryRetries.has(entry)) return false;
		return state.resultFileCoalescer.schedule(coalescerKey(entry, epoch), delay);
	};
	const scheduleStatusRecheck = (entry: string, epoch: number) => {
		if (!isEpochActive(epoch)) return;
		statusRetries.schedule(entry, () => {
			if (!isEpochActive(epoch) || !entryExists(entry)) { statusRetries.clear(entry); return; }
			scheduleResultEntry(entry, 0, epoch);
		});
	};
	const scheduleDeliveryRetry = (entry: string, epoch: number) => {
		if (!isEpochActive(epoch)) return;
		deliveryRetries.schedule(entry, () => {
			if (!isEpochActive(epoch) || !entryExists(entry)) { deliveryRetries.clear(entry); return; }
			scheduleResultEntry(entry, 0, epoch);
		});
	};

	const handleResult = async (entry: string, epoch: number) => {
		if (!isEpochActive(epoch)) return;
		const flightKey = coalescerKey(entry, epoch);
		if (inFlight.has(flightKey)) { rerunAfterFlight.add(flightKey); return; }
		inFlight.add(flightKey);
		try {
			const outcome = await processResultEntry(entry, {
				pi, state, resultsDir, completionTtlMs, fsApi,
				allowedStatusRoots: deps.allowedStatusRoots,
				maxStatusBytes: deps.maxStatusBytes,
				maxNoProgressFailures: deps.maxNoProgressFailures,
				intercomTimeoutMs: deps.intercomTimeoutMs,
				isActive: () => isEpochActive(epoch),
				ownsResult: (data) => isEpochActive(epoch) && ownsResult(data),
			});
			const nextEntry = outcome.entry ?? entry;
			if (outcome.status === "status-pending") scheduleStatusRecheck(nextEntry, epoch);
			else if (outcome.status === "delivery-retry") scheduleDeliveryRetry(nextEntry, epoch);
			else { statusRetries.clear(entry); deliveryRetries.clear(entry); }
		} catch (error) {
			if (!isNotFoundError(error)) {
				console.error(`Failed to process subagent result entry '${entry}':`, error);
				if (isEpochActive(epoch) && entryExists(entry)) scheduleDeliveryRetry(entry, epoch);
			}
		} finally {
			inFlight.delete(flightKey);
			if (rerunAfterFlight.delete(flightKey) && entryExists(entry)) scheduleResultEntry(entry, 0, epoch);
		}
	};

	state.resultFileCoalescer = createFileCoalescer((key) => {
		const { epoch, entry } = parseCoalescerKey(key);
		void handleResult(entry, epoch);
	}, 50, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });

	const primeExistingResults = () => {
		if (stopped) return;
		const epoch = processingEpoch;
		try {
			for (const file of fsApi.readdirSync(resultsDir)) if (file.endsWith(".json")) scheduleResultEntry(file, 0, epoch);
			for (const claim of listResultClaims(resultsDir, fsApi)) scheduleResultEntry(claimScheduleKey(claim.id), 0, epoch);
		} catch (error) {
			if (!isNotFoundError(error)) console.error(`Failed to scan subagent result directory '${resultsDir}':`, error);
		}
	};
	const scheduleDirectoryRescan = (epoch: number) => {
		if (!isEpochActive(epoch)) return;
		if (directoryRescanTimer) timers.clearTimeout(directoryRescanTimer);
		directoryRescanTimer = timers.setTimeout(() => {
			directoryRescanTimer = null;
			if (isEpochActive(epoch)) primeExistingResults();
		}, DIRECTORY_RESCAN_DELAY_MS);
		directoryRescanTimer.unref?.();
	};

	const startPollingFallback = (reason: unknown, epoch: number, installation?: number) => {
		if (!isEpochActive(epoch) || (installation !== undefined && installation !== activeWatcherInstallation)) return;
		state.watcher?.close();
		state.watcher = null;
		activeWatcherInstallation = 0;
		if (state.watcherRestartTimer) return;
		console.error(`Subagent result watcher for '${resultsDir}' fell back to polling because native fs.watch is unavailable (${getErrorCode(reason) ?? "unknown error"}).`);
		primeExistingResults();
		state.watcherRestartTimer = timers.setInterval(() => { if (isEpochActive(epoch)) primeExistingResults(); }, POLL_INTERVAL_MS);
		state.watcherRestartTimer.unref?.();
	};

	function scheduleRestart(epoch: number): void {
		if (!isEpochActive(epoch) || state.watcherRestartTimer) return;
		let timer!: ReturnType<typeof setTimeout>;
		timer = timers.setTimeout(() => {
			if (state.watcherRestartTimer !== timer || !isEpochActive(epoch)) return;
			state.watcherRestartTimer = null;
			try { fsApi.mkdirSync(resultsDir, { recursive: true }); openResultWatcher(epoch); }
			catch (error) {
				if (!isEpochActive(epoch)) return;
				if (shouldFallBackToPolling(error)) startPollingFallback(error, epoch);
				else { console.error(`Failed to restart subagent result watcher for '${resultsDir}':`, error); scheduleRestart(epoch); }
			}
		}, WATCHER_RESTART_DELAY_MS);
		state.watcherRestartTimer = timer;
		timer.unref?.();
	}

	function openResultWatcher(epoch: number): void {
		if (!isEpochActive(epoch) || state.watcher) return;
		const installation = ++watcherInstallation;
		let handle: fs.FSWatcher | null = null;
		let pendingSynchronousError: Error | undefined;
		const handleWatcherError = (error: Error) => {
			if (!handle) { pendingSynchronousError = error; return; }
			if (!isEpochActive(epoch) || installation !== activeWatcherInstallation || state.watcher !== handle) return;
			if (shouldFallBackToPolling(error)) { startPollingFallback(error, epoch, installation); return; }
			console.error(`Subagent result watcher failed for '${resultsDir}':`, error);
			handle.close();
			if (state.watcher === handle) state.watcher = null;
			activeWatcherInstallation = 0;
			scheduleRestart(epoch);
		};
		try {
			handle = safeWatch(resultsDir, (_event, file) => {
				if (!isEpochActive(epoch) || installation !== activeWatcherInstallation) return;
				if (file) { const name = file.toString(); if (name.endsWith(".json")) scheduleResultEntry(name, 50, epoch); }
				scheduleDirectoryRescan(epoch);
			}, handleWatcherError, { watch: fsApi.watch, realpathSyncNative: fsApi.realpathSync?.native });
			if (!handle) throw pendingSynchronousError ?? new Error("Result watcher installation returned no handle");
			if (!isEpochActive(epoch)) { handle.close(); return; }
			state.watcher = handle;
			activeWatcherInstallation = installation;
			handle.unref?.();
			if (pendingSynchronousError) handleWatcherError(pendingSynchronousError);
		} catch (error) {
			handle?.close();
			if (state.watcher === handle) state.watcher = null;
			activeWatcherInstallation = 0;
			if (!isEpochActive(epoch)) return;
			if (shouldFallBackToPolling(error)) startPollingFallback(error, epoch);
			else { console.error(`Failed to start subagent result watcher for '${resultsDir}':`, error); scheduleRestart(epoch); }
		}
	}

	const startResultWatcher = () => {
		stopped = false;
		processingEpoch += 1;
		if (state.watcherRestartTimer) {
			timers.clearTimeout(state.watcherRestartTimer); timers.clearInterval(state.watcherRestartTimer); state.watcherRestartTimer = null;
		}
		openResultWatcher(processingEpoch);
	};
	const stopResultWatcher = () => {
		stopped = true;
		processingEpoch += 1;
		state.watcher?.close();
		state.watcher = null;
		activeWatcherInstallation = 0;
		if (state.watcherRestartTimer) { timers.clearTimeout(state.watcherRestartTimer); timers.clearInterval(state.watcherRestartTimer); }
		state.watcherRestartTimer = null;
		if (directoryRescanTimer) timers.clearTimeout(directoryRescanTimer);
		directoryRescanTimer = null;
		statusRetries.clearAll(); deliveryRetries.clearAll(); state.resultFileCoalescer.clear();
	};
	return { startResultWatcher, primeExistingResults, stopResultWatcher };
}
