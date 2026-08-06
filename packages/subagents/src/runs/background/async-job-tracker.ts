import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import type { AsyncJobState, AsyncStartedEvent, AsyncStatus, SubagentState } from "../../shared/types.ts";
import { renderWidget } from "../../tui/render.ts";
import { listSubagentControls } from "../inprocess/control-registry.ts";

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	resultsDir?: string;
	pollIntervalMs?: number;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

function ctxHasUI(ctx: ExtensionContext | null | undefined): boolean {
	if (!ctx) return false;
	try {
		return ctx.hasUI;
	} catch {
		return false;
	}
}

function liveUiContext(state: SubagentState): ExtensionContext | undefined {
	const ctx = state.lastUiContext;
	if (!ctx) return undefined;
	try {
		void ctx.hasUI;
		return ctx;
	} catch {
		state.lastUiContext = null;
		return undefined;
	}
}

function stateFromStatus(status: AsyncStatus, asyncDir: string): AsyncJobState {
	const steps = (status.steps ?? []).map((step, index) => ({ ...step, index }));
	const completedSteps = steps.filter((step) => step.status === "complete" || step.status === "completed").length;
	return {
		asyncId: status.runId,
		asyncDir,
		status: status.state,
		...(status.sessionId ? { sessionId: status.sessionId } : {}),
		...(status.activityState ? { activityState: status.activityState } : {}),
		...(status.lastActivityAt !== undefined ? { lastActivityAt: status.lastActivityAt } : {}),
		...(status.currentTool ? { currentTool: status.currentTool } : {}),
		...(status.currentToolStartedAt !== undefined ? { currentToolStartedAt: status.currentToolStartedAt } : {}),
		...(status.currentPath ? { currentPath: status.currentPath } : {}),
		...(status.turnCount !== undefined ? { turnCount: status.turnCount } : {}),
		...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
		mode: status.mode,
		agents: steps.map((step) => step.agent),
		currentStep: status.currentStep,
		chainStepCount: status.chainStepCount,
		parallelGroups: status.parallelGroups,
		steps,
		stepsTotal: steps.length,
		runningSteps: steps.filter((step) => step.status === "running").length,
		completedSteps: status.state === "complete" ? steps.length : completedSteps,
		hasParallelGroups: (status.parallelGroups?.length ?? 0) > 0,
		activeParallelGroup: (status.parallelGroups?.length ?? 0) > 0 && status.state === "running",
		startedAt: status.startedAt,
		updatedAt: status.lastUpdate ?? status.startedAt,
		...(status.sessionDir ? { sessionDir: status.sessionDir } : {}),
		...(status.outputFile ? { outputFile: status.outputFile } : {}),
		...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
		...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
	};
}

function readActiveFileJobs(
	asyncDirRoot: string,
	currentSessionId: string | null,
	currentCwd: string,
): Map<string, AsyncJobState> {
	const jobs = new Map<string, AsyncJobState>();
	let entries: string[];
	try {
		entries = fs.readdirSync(asyncDirRoot);
	} catch {
		return jobs;
	}
	for (const entry of entries) {
		const asyncDir = path.join(asyncDirRoot, entry);
		let status: AsyncStatus;
		try {
			if (!fs.statSync(asyncDir).isDirectory()) continue;
			status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as AsyncStatus;
		} catch {
			continue;
		}
		if (status.state !== "queued" && status.state !== "running") continue;
		if (status.sessionId && currentSessionId && status.sessionId !== currentSessionId) continue;
		if (!status.sessionId && status.cwd && path.resolve(status.cwd) !== path.resolve(currentCwd)) continue;
		jobs.set(status.runId || entry, stateFromStatus({ ...status, runId: status.runId || entry }, asyncDir));
	}
	return jobs;
}

function hydrateRegistryJobs(_state: SubagentState, currentSessionId: string | null): Map<string, AsyncJobState> {
	const jobs = new Map<string, AsyncJobState>();
	for (const control of listSubagentControls()) {
		const children = control.listChildren();
		if (children.length === 0) continue;
		const steps = children.map((child, index) => ({
			index,
			agent: child.taskName,
			status:
				child.status === "ok"
					? ("complete" as const)
					: child.status === "error"
						? ("failed" as const)
						: child.status === "interrupted"
							? ("paused" as const)
							: child.status === "running" || child.status === "continued"
								? ("running" as const)
								: ("pending" as const),
		}));
		const status: AsyncJobState["status"] = steps.some(
			(step) => step.status === "running" || step.status === "pending",
		)
			? "running"
			: steps.some((step) => step.status === "failed")
				? "failed"
				: steps.some((step) => step.status === "paused")
					? "paused"
					: "complete";
		if (status !== "running") continue;
		jobs.set(control.parent.path, {
			asyncId: control.parent.path,
			asyncDir: control.parent.path,
			status,
			sessionId: currentSessionId ?? undefined,
			mode: steps.length > 1 ? "parallel" : "single",
			agents: steps.map((step) => step.agent),
			steps,
			stepsTotal: steps.length,
			runningSteps: steps.filter((step) => step.status === "running").length,
			completedSteps: steps.filter((step) => step.status === "complete").length,
			hasParallelGroups: steps.length > 1,
			activeParallelGroup: steps.some((step) => step.status === "running"),
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});
	}
	return jobs;
}

export function createAsyncJobTracker(
	pi: Pick<ExtensionAPI, "events">,
	state: SubagentState,
	asyncDirRoot: string,
	options: AsyncJobTrackerOptions = {},
): {
	ensurePoller: () => void;
	handleStarted: (data: unknown) => void;
	handleComplete: (data: unknown) => void;
	resetJobs: (ctx?: ExtensionContext) => void;
	hydrateActiveJobs: (ctx?: ExtensionContext) => void;
	hydrateActiveJobsDeferred: (ctx?: ExtensionContext) => void;
} {
	const completionRetentionMs = options.completionRetentionMs ?? 10_000;
	const rerender = () => {
		const ctx = liveUiContext(state);
		if (ctxHasUI(ctx)) renderWidget(ctx!, [...state.asyncJobs.values()], pi);
	};
	const scheduleCleanup = (id: string) => {
		const previous = state.cleanupTimers.get(id);
		if (previous) clearTimeout(previous);
		const timer = setTimeout(() => {
			state.cleanupTimers.delete(id);
			state.asyncJobs.delete(id);
			rerender();
		}, completionRetentionMs);
		timer.unref?.();
		state.cleanupTimers.set(id, timer);
	};
	const ensurePoller = () => {
		hydrateActiveJobs();
	};
	const safeCtxCwd = (ctx?: ExtensionContext): string | undefined => {
		if (!ctx) return undefined;
		try {
			return ctx.cwd;
		} catch {
			// The extension ctx goes stale after session replacement or reload; a
			// deferred hydration must degrade to the base cwd, never crash the host.
			return undefined;
		}
	};
	const hydrateActiveJobs = (ctx?: ExtensionContext, cwdOverride?: string) => {
		if (ctxHasUI(ctx)) state.lastUiContext = ctx!;
		const currentCwd = cwdOverride ?? safeCtxCwd(ctx) ?? state.baseCwd;
		const fileJobs = readActiveFileJobs(asyncDirRoot, state.currentSessionId, currentCwd);
		const registryJobs = hydrateRegistryJobs(state, state.currentSessionId);
		const next = new Map([...fileJobs, ...registryJobs]);
		for (const id of state.asyncJobs.keys()) if (!next.has(id)) state.asyncJobs.delete(id);
		for (const [id, job] of next) state.asyncJobs.set(id, job);
		rerender();
	};
	const handleStarted = (data: unknown) => {
		const info = data as AsyncStartedEvent;
		if (!info.id) return;
		const now = Date.now();
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir: info.asyncDir ?? path.join(asyncDirRoot, info.id),
			status: "running",
			sessionId: info.sessionId,
			mode: info.mode ?? (info.chain ? "chain" : "single"),
			agents: info.agents ?? info.chain ?? (info.agent ? [info.agent] : undefined),
			startedAt: now,
			updatedAt: now,
		});
		rerender();
	};
	const handleComplete = (data: unknown) => {
		const result = data as { id?: string; success?: boolean; status?: string };
		if (!result.id) return;
		const job = state.asyncJobs.get(result.id);
		if (job) {
			job.status = result.status === "interrupted" ? "paused" : result.success === false ? "failed" : "complete";
			job.updatedAt = Date.now();
			scheduleCleanup(result.id);
		}
		rerender();
	};
	const resetJobs = (ctx?: ExtensionContext) => {
		for (const timer of state.cleanupTimers.values()) clearTimeout(timer);
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		state.foregroundControls?.clear();
		state.lastForegroundControlId = null;
		state.resultFileCoalescer.clear();
		if (ctxHasUI(ctx)) state.lastUiContext = ctx!;
	};
	let pending: ReturnType<typeof setTimeout> | null = null;
	const hydrateActiveJobsDeferred = (ctx?: ExtensionContext) => {
		if (ctxHasUI(ctx)) state.lastUiContext = ctx!;
		const capturedCwd = safeCtxCwd(ctx);
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => {
			pending = null;
			hydrateActiveJobs(undefined, capturedCwd);
		}, 0);
		pending.unref?.();
	};
	return { ensurePoller, handleStarted, handleComplete, resetJobs, hydrateActiveJobs, hydrateActiveJobsDeferred };
}
