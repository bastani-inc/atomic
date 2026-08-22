/**
 * Foreground run and extension state public types.
 *
 * Delegation is one level deep, so a parent tracks only its own direct children.
 * The multi-level run address, route, and recursive summary types this file once
 * carried are gone with the pipeline that produced them.
 */

import type { ExtensionContext } from "@bastani/atomic";
import type { ParentAskPauseRequest } from "./types-config.js";
import type { ActivityState, SingleResult, SubagentResultStatus, SubagentRunMode } from "./types-results.js";

export interface ForegroundResumeChild {
	agent: string;
	index: number;
	sessionFile?: string;
	status: SubagentResultStatus;
	result?: SingleResult;
}

export interface ForegroundParentAskPause {
	askingChildIndex: number;
	releasedChildIndices: number[];
	unlaunchedChildIndices: number[];
	request: ParentAskPauseRequest;
}

export interface ForegroundResumeRun {
	runId: string;
	mode: SubagentRunMode;
	cwd: string;
	updatedAt: number;
	children: ForegroundResumeChild[];
	parentAsk?: ForegroundParentAskPause;
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
