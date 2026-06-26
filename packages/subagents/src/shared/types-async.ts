/**
 * Async job, nested run, and extension state public types.
 */

import type { FSWatcher } from "node:fs";
import type { ExtensionContext } from "@bastani/atomic";
import type {
	ActivityState,
	ChainOutputMap,
	ModelAttempt,
	SubagentResultStatus,
	SubagentRunMode,
	TokenUsage,
	WorkflowGraphSnapshot,
} from "./types-results.ts";

// ============================================================================
// Async Execution
// ============================================================================

export interface AsyncParallelGroupStatus {
	start: number;
	count: number;
	stepIndex: number;
}

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
	asyncDir?: string;
	pid?: number;
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
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
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

export interface AsyncStartedEvent {
	id?: string;
	asyncDir?: string;
	pid?: number;
	sessionId?: string;
	mode?: SubagentRunMode;
	agent?: string;
	agents?: string[];
	chain?: string[];
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	workflowGraph?: WorkflowGraphSnapshot;
	nestedRoute?: NestedRouteInfo;
}

export interface AsyncStatus {
	runId: string;
	sessionId?: string;
	mode: SubagentRunMode;
	state: "queued" | "running" | "complete" | "failed" | "paused";
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	pid?: number;
	cwd?: string;
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	workflowGraph?: WorkflowGraphSnapshot;
	steps?: Array<{
		agent: string;
		phase?: string;
		label?: string;
		outputName?: string;
		structured?: boolean;
		status: "pending" | "running" | "complete" | "completed" | "failed" | "paused";
		children?: NestedRunSummary[];
		sessionFile?: string;
		activityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolArgs?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		recentTools?: Array<{ tool: string; args: string; endMs: number }>;
		recentOutput?: string[];
		turnCount?: number;
		toolCount?: number;
		startedAt?: number;
		endedAt?: number;
		durationMs?: number;
		exitCode?: number | null;
		tokens?: TokenUsage;
		skills?: string[];
		model?: string;
		thinking?: string;
		fastMode?: boolean;
		attemptedModels?: string[];
		modelAttempts?: ModelAttempt[];
		error?: string;
		structuredOutput?: unknown;
		structuredOutputPath?: string;
		structuredOutputSchemaPath?: string;
	}>;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
	outputs?: ChainOutputMap;
}

export type AsyncJobStep = NonNullable<AsyncStatus["steps"]>[number] & {
	index?: number;
};

export interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	status: "queued" | "running" | "complete" | "failed" | "paused";
	pid?: number;
	sessionId?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	mode?: SubagentRunMode;
	agents?: string[];
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: AsyncJobStep[];
	stepsTotal?: number;
	runningSteps?: number;
	completedSteps?: number;
	hasParallelGroups?: boolean;
	activeParallelGroup?: boolean;
	startedAt?: number;
	updatedAt?: number;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
	controlEventCursor?: number;
	nestedRoute?: NestedRouteInfo;
	nestedChildren?: NestedRunSummary[];
}

export interface ForegroundResumeChild {
	agent: string;
	index: number;
	sessionFile?: string;
	status: SubagentResultStatus;
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
	asyncJobs: Map<string, AsyncJobState>;
	subagentInProgress?: boolean;
	foregroundRuns?: Map<string, ForegroundResumeRun>;
	foregroundControls: Map<string, {
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
	}>;
	lastForegroundControlId: string | null;
	pendingForegroundControlNotices?: Map<string, ReturnType<typeof setTimeout>>;
	cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
	lastUiContext: ExtensionContext | null;
	poller: NodeJS.Timeout | null;
	completionSeen: Map<string, number>;
	watcher: FSWatcher | null;
	watcherRestartTimer: ReturnType<typeof setTimeout> | null;
	resultFileCoalescer: {
		schedule(file: string, delayMs?: number): boolean;
		clear(): void;
	};
}
