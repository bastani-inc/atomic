/**
 * Foreground run and extension state public types.
 *
 * Delegation is one level deep, so a parent tracks only its own direct children.
 * The multi-level run address, route, and recursive summary types this file once
 * carried are gone with the pipeline that produced them.
 */

import type { ExtensionContext } from "@bastani/atomic";
import type { ParentAskPauseRequest, RunSyncOptions } from "./types-config.js";
import type { ActivityState, SingleResult, SubagentResultStatus, SubagentRunMode } from "./types-results.js";

type RetainedRunSyncOptionKeys = Exclude<
	keyof RunSyncOptions,
	| "signal"
	| "interruptSignal"
	| "intercomEvents"
	| "onDetachedExit"
	| "intercomDetachSignal"
	| "onIntercomDetachCommit"
	| "onParentAskClaim"
	| "onUpdate"
	| "onControlEvent"
	| "supervisorAuthorization"
>;

export type RetainedRunSyncOptions = Pick<RunSyncOptions, RetainedRunSyncOptionKeys>;

export interface ForegroundChildExecution {
	runtimeCwd: string;
	agentScope?: string;
	options: RetainedRunSyncOptions;
}

export interface ForegroundResumeChild {
	agent: string;
	index: number;
	sessionFile?: string;
	status: SubagentResultStatus;
	result?: SingleResult;
	execution: ForegroundChildExecution;
}

export interface ForegroundParentAskPause {
	askingChildIndex: number;
	releasedChildIndices: number[];
	unlaunchedChildIndices: number[];
	request: ParentAskPauseRequest;
}

export interface ForegroundRunCleanup {
	finalize(): string;
	defer(indices: number[]): boolean;
	recover(index: number): void;
}

export interface ForegroundResumeRun {
	runId: string;
	mode: SubagentRunMode;
	cwd: string;
	updatedAt: number;
	children: ForegroundResumeChild[];
	parentAsk?: ForegroundParentAskPause;
	cleanup?: ForegroundRunCleanup;
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
			interrupt?: () => boolean;
		}
	>;
	lastForegroundControlId: string | null;
	pendingForegroundControlNotices?: Map<string, ReturnType<typeof setTimeout>>;
	lastUiContext: ExtensionContext | null;
}
