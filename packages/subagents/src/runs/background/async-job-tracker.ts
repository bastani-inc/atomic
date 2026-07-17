import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderWidget, widgetRenderKey } from "../../tui/render.ts";
import { formatControlNoticeMessage } from "../shared/subagent-control.ts";
import {
	type AsyncJobState,
	type AsyncStartedEvent,
	type ControlEvent,
	type SubagentState,
	POLL_INTERVAL_MS,
	RESULTS_DIR,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
} from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import { hasLiveNestedDescendants, updateAsyncJobNestedProjection } from "../shared/nested-events.ts";

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	pollIntervalMs?: number;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

const ACTIVE_HYDRATION_STATES: Array<AsyncRunSummary["state"]> = ["queued", "running"];

/** Only eagerly hydrate runs touched within the last 7 days; older runs stay on-demand. */
const ACTIVE_HYDRATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cwdMatches(summaryCwd: string | undefined, currentCwd: string | undefined): boolean {
	return Boolean(summaryCwd && currentCwd && path.resolve(summaryCwd) === path.resolve(currentCwd));
}

function shouldHydrateRunForCurrentUi(summary: AsyncRunSummary, currentSessionId: string | null, currentCwd: string | undefined): boolean {
	if (summary.sessionId && currentSessionId) return summary.sessionId === currentSessionId;
	return cwdMatches(summary.cwd, currentCwd);
}

/**
 * Extension contexts captured for timer-driven work (deferred hydration and
 * state.lastUiContext) go stale after ctx.newSession(), ctx.fork(),
 * ctx.switchSession(), or ctx.reload(); every accessor on a stale context
 * throws. Probe defensively so an unref'd timer can never crash the host
 * process with an unhandled stale-context error.
 */
function ctxHasUI(ctx: ExtensionContext | null | undefined): boolean {
	if (!ctx) return false;
	try {
		return ctx.hasUI;
	} catch {
		return false;
	}
}

function ctxCwd(ctx: ExtensionContext | null | undefined): string | undefined {
	if (!ctx) return undefined;
	try {
		return ctx.cwd;
	} catch {
		return undefined;
	}
}

function asyncRunSummaryToJobState(summary: AsyncRunSummary, existing?: AsyncJobState): AsyncJobState {
	const chainStepCount = summary.chainStepCount ?? summary.steps.length;
	const groups = normalizeParallelGroups(summary.parallelGroups, summary.steps.length, chainStepCount);
	const activeGroup = summary.currentStep !== undefined
		? groups.find((group) => summary.currentStep! >= group.start && summary.currentStep! < group.start + group.count)
		: undefined;
	const steps = activeGroup
		? summary.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count).map((step, index) => ({ ...step, index: activeGroup.start + index }))
		: summary.steps.map((step, index) => ({ ...step, index: step.index ?? index }));
	const agents = steps.map((step) => step.agent);
	const stepsTotal = steps.length > 0 ? steps.length : existing?.stepsTotal ?? (agents.length > 0 ? agents.length : undefined);
	const completedSteps = summary.state === "complete"
		? steps.length
		: steps.filter((step) => step.status === "complete" || step.status === "completed").length;
	return {
		...existing,
		asyncId: summary.id,
		asyncDir: summary.asyncDir,
		status: summary.state,
		sessionId: summary.sessionId ?? existing?.sessionId,
		activityState: summary.activityState,
		lastActivityAt: summary.lastActivityAt,
		currentTool: summary.currentTool,
		currentToolStartedAt: summary.currentToolStartedAt,
		currentPath: summary.currentPath,
		turnCount: summary.turnCount,
		toolCount: summary.toolCount,
		mode: summary.mode,
		agents: agents.length > 0 ? agents : existing?.agents,
		currentStep: summary.currentStep,
		chainStepCount: summary.chainStepCount ?? existing?.chainStepCount,
		parallelGroups: groups,
		steps: steps.length > 0 ? steps : existing?.steps,
		stepsTotal,
		runningSteps: steps.filter((step) => step.status === "running").length,
		completedSteps,
		hasParallelGroups: groups.length > 0,
		activeParallelGroup: Boolean(activeGroup),
		startedAt: summary.startedAt,
		updatedAt: summary.lastUpdate ?? summary.startedAt,
		sessionDir: summary.sessionDir ?? existing?.sessionDir,
		outputFile: summary.outputFile ?? existing?.outputFile,
		totalTokens: summary.totalTokens,
		sessionFile: summary.sessionFile ?? existing?.sessionFile,
		nestedChildren: summary.nestedChildren,
	};
}

export function createAsyncJobTracker(pi: Pick<ExtensionAPI, "events">, state: SubagentState, asyncDirRoot: string, options: AsyncJobTrackerOptions = {}): {
	ensurePoller: () => void;
	handleStarted: (data: unknown) => void;
	handleComplete: (data: unknown) => void;
	resetJobs: (ctx?: ExtensionContext) => void;
	hydrateActiveJobs: (ctx?: ExtensionContext) => void;
	hydrateActiveJobsDeferred: (ctx?: ExtensionContext) => void;
} {
	const completionRetentionMs = options.completionRetentionMs ?? 10000;
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const resultsDir = options.resultsDir ?? RESULTS_DIR;
	const rerenderWidget = (ctx: ExtensionContext, jobs = Array.from(state.asyncJobs.values())) => {
		renderWidget(ctx, jobs, pi);
	};
	/** Return the retained UI context when it is still usable; drop it once stale. */
	const liveUiContext = (): ExtensionContext | undefined => {
		const ctx = state.lastUiContext;
		if (!ctx) return undefined;
		try {
			void ctx.hasUI;
			return ctx;
		} catch {
			state.lastUiContext = null;
			return undefined;
		}
	};
	const cancelCleanup = (asyncId: string) => {
		const existingTimer = state.cleanupTimers.get(asyncId);
		if (!existingTimer) return;
		clearTimeout(existingTimer);
		state.cleanupTimers.delete(asyncId);
	};
	const scheduleCleanup = (asyncId: string) => {
		cancelCleanup(asyncId);
		const timer = setTimeout(() => {
			state.cleanupTimers.delete(asyncId);
			state.asyncJobs.delete(asyncId);
			const uiCtx = liveUiContext();
			if (uiCtx) {
				rerenderWidget(uiCtx);
			}
		}, completionRetentionMs);
		state.cleanupTimers.set(asyncId, timer);
	};
	const emitNewControlEvents = (job: AsyncJobState) => {
		const eventsPath = path.join(job.asyncDir, "events.jsonl");
		let fd: number;
		try {
			fd = fs.openSync(eventsPath, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			console.error(`Failed to open async control events for '${job.asyncDir}':`, error);
			return;
		}
		try {
			const stat = fs.fstatSync(fd);
			const cursor = stat.size < (job.controlEventCursor ?? 0) ? 0 : (job.controlEventCursor ?? 0);
			if (stat.size <= cursor) return;
			const buffer = Buffer.alloc(stat.size - cursor);
			fs.readSync(fd, buffer, 0, buffer.length, cursor);
			const lastNewline = buffer.lastIndexOf(0x0a);
			if (lastNewline === -1) return;
			job.controlEventCursor = cursor + lastNewline + 1;
			for (const line of buffer.subarray(0, lastNewline).toString("utf-8").split("\n")) {
				if (!line.trim()) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch (error) {
					console.error(`Ignoring malformed async control event in '${eventsPath}':`, error);
					continue;
				}
				if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "subagent.control") continue;
				const record = parsed as { event?: ControlEvent; channels?: string[]; childIntercomTarget?: string; noticeText?: string; intercom?: { to?: string; message?: string } };
				if (!record.event || !Array.isArray(record.channels)) continue;
				const payload = {
					event: record.event,
					source: "async" as const,
					asyncDir: job.asyncDir,
					childIntercomTarget: record.childIntercomTarget,
					noticeText: record.noticeText ?? formatControlNoticeMessage(record.event, record.childIntercomTarget),
				};
				if (record.channels.includes("event")) {
					pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
				}
				if (record.event.type !== "active_long_running" && record.channels.includes("intercom") && record.intercom?.to && record.intercom.message) {
					pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
						...payload,
						to: record.intercom.to,
						message: record.intercom.message,
					});
				}
			}
		} catch (error) {
			console.error(`Failed to read async control events for '${job.asyncDir}':`, error);
		} finally {
			fs.closeSync(fd);
		}
	};

	const ensurePoller = () => {
		if (state.poller) return;
		state.poller = setInterval(() => {
			if (state.asyncJobs.size === 0) {
				const idleUiCtx = liveUiContext();
				if (ctxHasUI(idleUiCtx)) rerenderWidget(idleUiCtx!, []);
				if (state.poller) {
					clearInterval(state.poller);
					state.poller = null;
				}
				return;
			}

			let widgetChanged = false;
			for (const job of state.asyncJobs.values()) {
				const widgetStateBefore = widgetRenderKey(job);
				let nestedRefreshFailed = false;
				const refreshNestedProjection = () => {
					try {
						updateAsyncJobNestedProjection(job);
					} catch (error) {
						nestedRefreshFailed = true;
						console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
					}
				};
				const reconcileNestedDescendants = () => {
					try {
						if (job.nestedRoute) reconcileNestedAsyncDescendants(job.nestedRoute, { resultsDir, kill: options.kill, now: options.now });
					} catch (error) {
						nestedRefreshFailed = true;
						console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
					}
					refreshNestedProjection();
				};
				try {
					emitNewControlEvents(job);
					reconcileNestedDescendants();
					const reconciliation = reconcileAsyncRun(job.asyncDir, {
						resultsDir,
						kill: options.kill,
						now: options.now,
						startedRun: {
							runId: job.asyncId,
							pid: job.pid,
							sessionId: job.sessionId,
							mode: job.mode,
							agents: job.agents,
							chainStepCount: job.chainStepCount,
							parallelGroups: job.parallelGroups,
							startedAt: job.startedAt,
							sessionFile: job.sessionFile,
						},
					});
					const status = reconciliation.status ?? readStatus(job.asyncDir);
					if (status) {
						const previousStatus = job.status;
						job.status = status.state;
						if (job.status !== "complete" && job.status !== "failed" && job.status !== "paused") cancelCleanup(job.asyncId);
						job.sessionId = status.sessionId ?? job.sessionId;
						job.activityState = status.activityState;
						job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
						job.currentTool = status.currentTool;
						job.currentToolStartedAt = status.currentToolStartedAt;
						job.currentPath = status.currentPath;
						job.turnCount = status.turnCount ?? job.turnCount;
						job.toolCount = status.toolCount ?? job.toolCount;
						job.mode = status.mode;
						job.currentStep = status.currentStep ?? job.currentStep;
						job.chainStepCount = status.chainStepCount ?? job.chainStepCount;
						job.startedAt = status.startedAt ?? job.startedAt;
						if (status.lastUpdate !== undefined) job.updatedAt = status.lastUpdate;
						if (status.steps?.length) {
							const groups = normalizeParallelGroups(status.parallelGroups, status.steps.length, status.chainStepCount ?? status.steps.length);
							job.parallelGroups = groups.length ? groups : job.parallelGroups;
							job.hasParallelGroups = groups.length > 0 || job.hasParallelGroups;
							const activeGroup = status.currentStep !== undefined
								? groups.find((group) => status.currentStep! >= group.start && status.currentStep! < group.start + group.count)
								: undefined;
							const visibleSteps = activeGroup
								? status.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count).map((step, index) => ({ ...step, index: activeGroup.start + index }))
								: status.steps.map((step, index) => ({ ...step, index }));
							job.activeParallelGroup = Boolean(activeGroup);
							job.agents = visibleSteps.map((step) => step.agent);
							job.steps = visibleSteps;
							refreshNestedProjection();
							job.stepsTotal = visibleSteps.length;
							job.runningSteps = visibleSteps.filter((step) => step.status === "running").length;
							job.completedSteps = visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length;
							if (status.state === "complete") job.completedSteps = visibleSteps.length;
						}
						job.sessionDir = status.sessionDir ?? job.sessionDir;
						job.outputFile = status.outputFile ?? job.outputFile;
						job.totalTokens = status.totalTokens ?? job.totalTokens;
						job.sessionFile = status.sessionFile ?? job.sessionFile;
						if ((job.status === "complete" || job.status === "failed" || job.status === "paused") && !nestedRefreshFailed && !hasLiveNestedDescendants(job.nestedChildren) && (previousStatus !== job.status || !state.cleanupTimers.has(job.asyncId))) {
							scheduleCleanup(job.asyncId);
						}
						if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
						continue;
					}
					if (job.status === "queued") {
						job.status = "running";
						job.updatedAt = Date.now();
					}
				} catch (error) {
					if (job.status !== "failed") {
						console.error(`Failed to read async status for '${job.asyncDir}':`, error);
						job.status = "failed";
						job.updatedAt = Date.now();
					}
					if (!hasLiveNestedDescendants(job.nestedChildren) && !state.cleanupTimers.has(job.asyncId)) {
						scheduleCleanup(job.asyncId);
					}
				}
				if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
			}

			const pollUiCtx = liveUiContext();
			if (widgetChanged && ctxHasUI(pollUiCtx)) rerenderWidget(pollUiCtx!);
		}, pollIntervalMs);
		state.poller.unref?.();
	};

	const hydrateActiveJobs = (ctx?: ExtensionContext) => {
		if (ctxHasUI(ctx)) state.lastUiContext = ctx!;
		const retainedCtx = liveUiContext();
		const renderCtx = ctxHasUI(retainedCtx) ? retainedCtx : undefined;
		const currentCwd = (ctxCwd(ctx) ?? ctxCwd(retainedCtx) ?? state.baseCwd) || undefined;
		let summaries: AsyncRunSummary[];
		try {
			summaries = listAsyncRuns(asyncDirRoot, {
				states: ACTIVE_HYDRATION_STATES,
				resultsDir,
				kill: options.kill,
				now: options.now,
				maxAgeMs: ACTIVE_HYDRATION_MAX_AGE_MS,
			});
		} catch (error) {
			console.error(`Failed to hydrate active async jobs from '${asyncDirRoot}':`, error);
			if (renderCtx) rerenderWidget(renderCtx);
			return;
		}

		for (const summary of summaries) {
			if (!shouldHydrateRunForCurrentUi(summary, state.currentSessionId, currentCwd)) continue;
			cancelCleanup(summary.id);
			state.asyncJobs.set(summary.id, asyncRunSummaryToJobState(summary, state.asyncJobs.get(summary.id)));
		}

		if (state.asyncJobs.size > 0) ensurePoller();
		if (renderCtx) rerenderWidget(renderCtx);
	};

	const handleStarted = (data: unknown) => {
		const info = data as AsyncStartedEvent;
		if (!info.id) return;
		const now = Date.now();
		const asyncDir = info.asyncDir ?? path.join(asyncDirRoot, info.id);
		let rawAgents: string[] | undefined;
		if (info.agents?.length) {
			rawAgents = info.agents;
		} else if (info.chain && info.chain.length > 0) {
			rawAgents = info.chain;
		} else if (info.agent) {
			rawAgents = [info.agent];
		}
		const validParallelGroups = normalizeParallelGroups(info.parallelGroups, Number.MAX_SAFE_INTEGER, info.chainStepCount ?? Number.MAX_SAFE_INTEGER);
		const firstGroup = validParallelGroups.find((group) => group.start === 0);
		const firstGroupCount = firstGroup?.count;
		const agents = firstGroupCount && firstGroupCount > 0
			? rawAgents?.slice(0, firstGroupCount)
			: rawAgents;
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			pid: typeof info.pid === "number" ? info.pid : undefined,
			...(typeof info.sessionId === "string" ? { sessionId: info.sessionId } : {}),
			mode: info.mode ?? (info.chain ? "chain" : "single"),
			agents,
			chainStepCount: info.chainStepCount,
			parallelGroups: validParallelGroups,
			nestedRoute: info.nestedRoute,
			stepsTotal: firstGroupCount ?? agents?.length,
			hasParallelGroups: validParallelGroups.length > 0,
			activeParallelGroup: Boolean(firstGroupCount && firstGroupCount > 0),
			startedAt: now,
			updatedAt: now,
		});
		ensurePoller();
		const startedUiCtx = liveUiContext();
		if (startedUiCtx) {
			rerenderWidget(startedUiCtx);
		}
	};

	const handleComplete = (data: unknown) => {
		const result = data as { id?: string; success?: boolean; asyncDir?: string };
		const asyncId = result.id;
		if (!asyncId) return;
		const job = state.asyncJobs.get(asyncId);
		let nestedRefreshFailed = false;
		if (job) {
			job.status = result.success ? "complete" : "failed";
			job.updatedAt = Date.now();
			if (result.asyncDir) job.asyncDir = result.asyncDir;
			try {
				updateAsyncJobNestedProjection(job);
			} catch (error) {
				nestedRefreshFailed = true;
				console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
			}
		}
		const completeUiCtx = liveUiContext();
		if (completeUiCtx) {
			rerenderWidget(completeUiCtx);
		}
		if (!nestedRefreshFailed && !hasLiveNestedDescendants(job?.nestedChildren)) scheduleCleanup(asyncId);
	};

	const resetJobs = (ctx?: ExtensionContext) => {
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		state.foregroundControls?.clear();
		state.lastForegroundControlId = null;
		state.resultFileCoalescer.clear();
		if (ctxHasUI(ctx)) state.lastUiContext = ctx!;
	};

	// Hydration scans the async run root synchronously; deferring it off the
	// session_start hot path keeps startup latency independent of run history.
	let pendingDeferredHydration: ReturnType<typeof setTimeout> | null = null;
	const hydrateActiveJobsDeferred = (ctx?: ExtensionContext) => {
		if (ctxHasUI(ctx)) state.lastUiContext = ctx!;
		if (pendingDeferredHydration !== null) clearTimeout(pendingDeferredHydration);
		const timer = setTimeout(() => {
			pendingDeferredHydration = null;
			hydrateActiveJobs(ctx);
		}, 0);
		timer.unref?.();
		pendingDeferredHydration = timer;
	};

	return { ensurePoller, handleStarted, handleComplete, resetJobs, hydrateActiveJobs, hydrateActiveJobsDeferred };
}
