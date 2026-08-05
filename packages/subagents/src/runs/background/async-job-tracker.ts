import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import type { AsyncJobState, AsyncStartedEvent, SubagentState } from "../../shared/types.ts";
import { renderWidget, widgetRenderKey } from "../../tui/render.ts";
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

function hydrateRegistryJobs(state: SubagentState, currentSessionId: string | null): boolean {
	let changed = false;
	for (const control of listSubagentControls()) {
		const children = control.listChildren();
		if (children.length === 0) continue;
		const asyncId = control.parent.path;
		const existing = state.asyncJobs.get(asyncId);
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
			path: child.path,
		}));
		const status = steps.some((step) => step.status === "running" || step.status === "pending")
			? "running"
			: steps.some((step) => step.status === "failed")
				? "failed"
				: steps.some((step) => step.status === "paused")
					? "paused"
					: "complete";
		const next: AsyncJobState = {
			...(existing ?? {}),
			asyncId,
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
			startedAt: existing?.startedAt ?? Date.now(),
			updatedAt: Date.now(),
		};
		if (!existing || widgetRenderKey(existing) !== widgetRenderKey(next)) changed = true;
		state.asyncJobs.set(asyncId, next);
	}
	return changed;
}

export function createAsyncJobTracker(
	pi: Pick<ExtensionAPI, "events">,
	state: SubagentState,
	_asyncDirRoot: string,
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
		// The Rust control registry is the live source of truth. There is no PID or
		// status-file poller in the in-process runtime.
		hydrateRegistryJobs(state, state.currentSessionId);
		rerender();
	};
	const hydrateActiveJobs = (ctx?: ExtensionContext) => {
		if (ctxHasUI(ctx)) state.lastUiContext = ctx!;
		hydrateRegistryJobs(state, state.currentSessionId);
		rerender();
	};
	const handleStarted = (data: unknown) => {
		const info = data as AsyncStartedEvent;
		if (!info.id) return;
		const now = Date.now();
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir: info.asyncDir ?? info.id,
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
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => {
			pending = null;
			hydrateActiveJobs(ctx);
		}, 0);
		pending.unref?.();
	};
	return { ensurePoller, handleStarted, handleComplete, resetJobs, hydrateActiveJobs, hydrateActiveJobsDeferred };
}
