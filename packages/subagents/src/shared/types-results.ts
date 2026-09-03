/**
 * Result, progress, and core subagent public types.
 */

import type { SessionStats } from "@bastani/atomic";
import type { Message } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export interface MaxOutputConfig {
	bytes?: number;
	lines?: number;
}

export type OutputMode = "inline" | "file-only";

export interface SavedOutputReference {
	path: string;
	bytes: number;
	lines: number;
	message: string;
}

interface TruncationResult {
	text: string;
	truncated: boolean;
	originalBytes?: number;
	originalLines?: number;
	artifactPath?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

export type ActivityState = "active_long_running" | "needs_attention";
export type ControlEventType = "active_long_running" | "needs_attention";
export type ControlNotificationChannel = "event" | "intercom";

export interface ControlConfig {
	enabled?: boolean;
	needsAttentionAfterMs?: number;
	activeNoticeAfterMs?: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention?: number;
	progressScores?: number[];
	notifyOn?: ControlEventType[];
	notifyChannels?: ControlNotificationChannel[];
}

export interface ResolvedControlConfig {
	enabled: boolean;
	needsAttentionAfterMs: number;
	activeNoticeAfterMs: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention: number;
	progressScores?: number[];
	notifyOn: ControlEventType[];
	notifyChannels: ControlNotificationChannel[];
}

export interface ControlEvent {
	type: ControlEventType;
	from?: ActivityState;
	to: ActivityState;
	ts: number;
	agent: string;
	index?: number;
	runId: string;
	message: string;
	reason?: "idle" | "active_long_running" | "tool_failures" | "time_threshold" | "turn_threshold" | "token_threshold";
	turns?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	elapsedMs?: number;
	recentFailureSummary?: string;
}

export type SubagentResultStatus = "completed" | "failed" | "interrupted" | "detached";
export type SubagentRunMode = "single" | "parallel";

export interface SubagentResultIntercomChild {
	agent: string;
	status: SubagentResultStatus;
	summary: string;
	index?: number;
	cause?: string;
	artifactPath?: string;
	sessionPath?: string;
	intercomTarget?: string;
}

export interface SubagentResultIntercomPayload {
	to: string;
	message: string;
	requestId?: string;
	runId: string;
	mode: SubagentRunMode;
	status: SubagentResultStatus;
	summary: string;
	children: SubagentResultIntercomChild[];
	agent?: string;
	index?: number;
	artifactPath?: string;
	sessionPath?: string;
}

// ============================================================================
// Progress Tracking
// ============================================================================

export interface AgentProgress {
	index: number;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "detached" | "interrupted";
	activityState?: ActivityState;
	task: string;
	/** Effective model for this live attempt, including fallback changes. */
	model?: string;
	/** Effective thinking level for this live attempt. */
	thinking?: string;
	skills?: string[];
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	turnCount?: number;
	tokens: number;
	durationMs: number;
	error?: string;
	/** Terminal abort cause, when progress is an interrupted parent cancellation. */
	cause?: string;
	failedTool?: string;
}

export interface ToolCallSummary {
	text: string;
	expandedText: string;
}

interface ProgressSummary {
	toolCount: number;
	tokens: number;
	durationMs: number;
}

// ============================================================================
// Results
// ============================================================================

export interface ModelAttempt {
	model: string;
	reasoningLevel?: string;
	success: boolean;
	error?: string;
	usage?: Usage;
}

export type SubagentAttemptStatus = "ok" | "error" | "skipped" | "interrupted" | "continued";

export interface SingleResult {
	agent: string;
	task: string;
	/** Typed terminal outcome; this is the only result discriminator. */
	status: SubagentAttemptStatus;
	cause?: string;
	stats?: SessionStats;
	path?: string;
	envelope?: string;
	detached?: boolean;
	detachedReason?: string;
	interrupted?: boolean;
	messages?: Message[];
	usage: Usage;
	model?: string;
	thinking?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	controlEvents?: ControlEvent[];
	error?: string;
	sessionFile?: string;
	skills?: string[];
	skillsWarning?: string;
	progress?: AgentProgress;
	progressSummary?: ProgressSummary;
	toolCalls?: ToolCallSummary[];
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
	finalOutput?: string;
	outputMode?: OutputMode;
	savedOutputPath?: string;
	outputReference?: SavedOutputReference;
	outputSaveError?: string;
}

export interface Details {
	mode: SubagentRunMode | "management";
	runId?: string;
	context?: "fresh" | "fork";
	results: SingleResult[];
	controlEvents?: ControlEvent[];
	progress?: AgentProgress[];
	totalSteps?: number;
	/** Parent ask ended the current child and returned a fresh-subagent handoff. */
	parentAskYielded?: boolean;
	progressSummary?: ProgressSummary;
	artifacts?: {
		dir: string;
		files: ArtifactPaths[];
	};
	truncation?: {
		truncated: boolean;
		originalBytes?: number;
		originalLines?: number;
		artifactPath?: string;
	};
}

// Upstream AgentToolResult omits the runtime isError flag that subagent tool results still emit/read.
export type SubagentToolResult = AgentToolResult<Details> & { isError?: boolean };

// ============================================================================
// Artifacts
// ============================================================================

export interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	metadataPath: string;
}

export interface ArtifactConfig {
	enabled: boolean;
	includeInput: boolean;
	includeOutput: boolean;
	includeJsonl: boolean;
	includeMetadata: boolean;
	cleanupDays: number;
}
