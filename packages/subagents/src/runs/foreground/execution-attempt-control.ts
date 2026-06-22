import type { AgentConfig } from "../../agents/agents.ts";
import type { AgentProgress, ControlEvent, RunSyncOptions, SingleResult } from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	claimControlNotification,
	deriveActivityState,
	shouldNotifyControlEvent,
} from "../shared/subagent-control.ts";
import { nextLongRunningTrigger } from "../shared/long-running-guard.ts";

export type NeedsAttentionInput = {
	message?: string;
	reason?: ControlEvent["reason"];
	recentFailureSummary?: string;
	currentTool?: string;
	currentPath?: string;
	currentToolDurationMs?: number;
};

export type AttemptControlRuntime = {
	config: NonNullable<RunSyncOptions["controlConfig"]>;
	allControlEvents: ControlEvent[];
	drainPendingControlEvents(): ControlEvent[] | undefined;
	emitNeedsAttention(now: number, input?: NeedsAttentionInput): boolean;
	updateActivityState(now: number): boolean;
};

export function createAttemptControlRuntime(input: {
	options: RunSyncOptions;
	agent: AgentConfig;
	result: SingleResult;
	progress: AgentProgress;
	startTime: number;
}): AttemptControlRuntime {
	const controlConfig = input.options.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	const allControlEvents: ControlEvent[] = [];
	let pendingControlEvents: ControlEvent[] = [];
	const emittedControlEventKeys = new Set<string>();
	let activeLongRunningNotified = false;

	const currentToolDurationMs = (now: number) =>
		input.progress.currentToolStartedAt ? Math.max(0, now - input.progress.currentToolStartedAt) : undefined;

	const emitControlEvent = (event: ControlEvent) => {
		if (!shouldNotifyControlEvent(controlConfig, event)) return;
		if (!claimControlNotification(controlConfig, event, emittedControlEventKeys)) return;
		allControlEvents.push(event);
		pendingControlEvents.push(event);
		input.options.onControlEvent?.(event);
	};

	const emitNeedsAttention = (now: number, details: NeedsAttentionInput = {}): boolean => {
		if (!controlConfig.enabled) return false;
		const previous = input.progress.activityState;
		input.progress.activityState = "needs_attention";
		emitControlEvent(buildControlEvent({
			type: "needs_attention",
			from: previous,
			to: "needs_attention",
			runId: input.options.runId,
			agent: input.agent.name,
			index: input.options.index,
			ts: now,
			lastActivityAt: input.progress.lastActivityAt,
			message: details.message,
			reason: details.reason ?? "idle",
			turns: input.result.usage.turns,
			tokens: input.progress.tokens,
			toolCount: input.progress.toolCount,
			currentTool: details.currentTool ?? input.progress.currentTool,
			currentToolDurationMs: details.currentToolDurationMs ?? currentToolDurationMs(now),
			currentPath: details.currentPath ?? input.progress.currentPath,
			recentFailureSummary: details.recentFailureSummary,
		}));
		return previous !== "needs_attention";
	};

	const emitActiveLongRunning = (now: number, reason: ControlEvent["reason"]): boolean => {
		if (!controlConfig.enabled || activeLongRunningNotified || input.progress.activityState === "needs_attention") return false;
		activeLongRunningNotified = true;
		const previous = input.progress.activityState;
		input.progress.activityState = "active_long_running";
		emitControlEvent(buildControlEvent({
			type: "active_long_running",
			from: previous,
			to: "active_long_running",
			runId: input.options.runId,
			agent: input.agent.name,
			index: input.options.index,
			ts: now,
			message: `${input.agent.name} is still active but long-running`,
			reason,
			turns: input.result.usage.turns,
			tokens: input.progress.tokens,
			toolCount: input.progress.toolCount,
			currentTool: input.progress.currentTool,
			currentToolDurationMs: currentToolDurationMs(now),
			currentPath: input.progress.currentPath,
			elapsedMs: now - input.startTime,
		}));
		return true;
	};

	return {
		config: controlConfig,
		allControlEvents,
		drainPendingControlEvents: () => {
			if (pendingControlEvents.length === 0) return undefined;
			const events = pendingControlEvents;
			pendingControlEvents = [];
			return events;
		},
		emitNeedsAttention,
		updateActivityState: (now: number) => {
			if (!controlConfig.enabled) return false;
			const idleState = deriveActivityState({
				config: controlConfig,
				startedAt: input.startTime,
				lastActivityAt: input.progress.lastActivityAt,
				now,
			});
			if (idleState === "needs_attention") {
				return input.progress.activityState === "needs_attention" ? false : emitNeedsAttention(now);
			}
			const activeReason = nextLongRunningTrigger(controlConfig, {
				startedAt: input.startTime,
				now,
				turns: input.result.usage.turns,
				tokens: input.progress.tokens,
			});
			return activeReason ? emitActiveLongRunning(now, activeReason) : false;
		},
	};
}
