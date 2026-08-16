/**
 * Nested foreground run and extension state public types.
 */

import type { ExtensionContext } from "@bastani/atomic";
import type {
	ActivityState,
	SingleResult,
	SubagentResultStatus,
	SubagentRunMode,
	TokenUsage,
} from "./types-results.js";

export type NestedRunState = "queued" | "running" | "complete" | "failed" | "paused";
export type NestedOwnerState = "live" | "gone" | "unknown";

export interface NestedRunAddress {
	id: string;
	parentRunId: string;
	parentStepIndex?: number;
	parentAgent?: string;
	depth: number;
	path: Array<{ runId: string; stepIndex?: number; agent?: string }>;
}

export interface NestedStepSummary {
	agent: string;
	status: "pending" | "running" | "complete" | "completed" | "failed" | "paused";
	sessionFile?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	startedAt?: number;
	endedAt?: number;
	error?: string;
	children?: NestedRunSummary[];
}

export interface NestedRunSummary extends NestedRunAddress {
	sessionId?: string;
	sessionFile?: string;
	intercomTarget?: string;
	ownerIntercomTarget?: string;
	leafIntercomTarget?: string;
	ownerState?: NestedOwnerState;
	controlInbox?: string;
	capabilityToken?: string;
	mode?: SubagentRunMode;
	state: NestedRunState;
	agent?: string;
	agents?: string[];
	steps?: NestedStepSummary[];
	children?: NestedRunSummary[];
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	totalTokens?: TokenUsage;
	startedAt?: number;
	endedAt?: number;
	lastUpdate?: number;
	error?: string;
}

export interface NestedRouteInfo {
	rootRunId: string;
	eventSink: string;
	controlInbox: string;
	capabilityToken: string;
}

export interface ForegroundResumeChild {
	agent: string;
	index: number;
	sessionFile?: string;
	status: SubagentResultStatus;
	result?: SingleResult;
	/** Effective delegation limit retained for a resumed child. */
	maxSubagentDepth?: number;
}

export interface ForegroundResumeRun {
	runId: string;
	mode: SubagentRunMode;
	cwd: string;
	updatedAt: number;
	children: ForegroundResumeChild[];
}

export interface SubagentState {
	baseCwd: string;
	currentSessionId: string | null;
	subagentInProgress?: boolean;
	foregroundRuns?: Map<string, ForegroundResumeRun>;
	foregroundControls: Map<
		string,
		{
			runId: string;
			mode: SubagentRunMode;
			startedAt: number;
			updatedAt: number;
			currentAgent?: string;
			currentIndex?: number;
			currentActivityState?: ActivityState;
			lastActivityAt?: number;
			currentTool?: string;
			currentToolStartedAt?: number;
			currentPath?: string;
			turnCount?: number;
			tokens?: number;
			toolCount?: number;
			nestedRoute?: NestedRouteInfo;
			nestedChildren?: NestedRunSummary[];
			interrupt?: () => boolean;
		}
	>;
	lastForegroundControlId: string | null;
	pendingForegroundControlNotices?: Map<string, ReturnType<typeof setTimeout>>;
	lastUiContext: ExtensionContext | null;
}
