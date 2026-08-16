/**
 * Configuration, execution option, display, and event bus types.
 */

import type { SessionWorkflowMetadata } from "@bastani/atomic";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CandidateModelResolver } from "./model-resolution.ts";
import type { NestedRouteInfo } from "./types-nested.ts";
import type {
	ArtifactConfig,
	ControlConfig,
	ControlEvent,
	Details,
	MaxOutputConfig,
	OutputMode,
	ResolvedControlConfig,
	SingleResult,
} from "./types-results.ts";

// ============================================================================
// Display
// ============================================================================

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "tool"; name: string; args: Record<string, unknown> };

// ============================================================================
// Error Handling
// ============================================================================

export interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

export interface IntercomEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const SUBAGENT_COMPLETE_EVENT = "subagent:complete";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT = "subagent:terminal-ordering-barrier";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";

// ============================================================================
// Execution Options
// ============================================================================

export interface RunSyncOptions {
	cwd?: string;
	signal?: AbortSignal;
	interruptSignal?: AbortSignal;
	allowIntercomDetach?: boolean;
	intercomEvents?: IntercomEventBus;
	onDetachedExit?: (result: SingleResult) => void;
	/** Shared foreground-group signal used to release sibling supervision after one exact child commits Intercom detach. */
	intercomDetachSignal?: AbortSignal;
	/** Releases every active foreground sibling only after this exact child accepts a detach commit. */
	onIntercomDetachCommit?: () => void;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig?: ResolvedControlConfig;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	/** Typed supervisor capability issued for this child; never read from environment. */
	supervisorAuthorization?: {
		capability: string;
		supervisorSessionId: string;
		childName: string;
	};
	/** Resolved intercom home group for the spawned child (explicit subagent group or inherited stage group). */
	intercomGroup?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
	runId: string;
	index?: number;
	sessionDir?: string;
	sessionFile?: string;
	share?: boolean;
	outputPath?: string;
	outputMode?: OutputMode;
	maxSubagentDepth?: number;
	/** Current session depth passed to the in-process admission door. */
	parentDepth?: number;
	workflowStageSubagentGuard?: boolean;
	workflowSessionMetadata?: SessionWorkflowMetadata;
	nestedRoute?: NestedRouteInfo;
	/** Override the agent's default model (format: "provider/id" or just "id") */
	modelOverride?: string;
	/** Registry models available for heuristic bare-model resolution */
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	/** Providers known to the registry before auth filtering */
	knownModelProviders?: string[];
	/**
	 * Resolve the selected `provider/model[:thinking]` candidate to a concrete
	 * registry model. Without it the child session receives no model and a
	 * fork-context child silently runs on the model restored from the parent's
	 * session file.
	 */
	resolveCandidateModel?: CandidateModelResolver;
	/** Current parent-session provider to prefer for ambiguous bare model ids */
	preferredModelProvider?: string;
	/** Current parent-session model to try after configured fallback models */
	currentModel?: string;
	/**
	 * Current parent-session thinking level. Inherited by a child that pins no
	 * model of its own — no frontmatter `model`, no `fallbackModels`, and no
	 * per-call override — matching upstream pi #7897: a subagent dispatched
	 * without a model runs on the dispatching session's model and thinking
	 * level. An agent whose fallback chain selects its own first candidate
	 * runs on that model, not the parent's, and keeps its own thinking
	 * configuration.
	 */
	currentThinkingLevel?: string;
	/** Skills to inject (overrides agent default if provided) */
	skills?: string[];
	/** Test-only in-process session stub configuration; production runs create a real AgentSession. */
	testSession?:
		| false
		| {
				output?: string;
				promptLogPath?: string;
				/** Hold a test prompt open until the caller releases the supplied promise. */
				promptGate?: Promise<void>;
				/** Match AgentSession.abort() settling an active prompt without throwing. */
				abortResolvesPrompt?: boolean;
				/** Emit a fallback event for tests that exercise live model metadata. */
				fallbackModel?: string;
				/** Emit the effective thinking level applied to the fallback candidate. */
				fallbackThinkingLevel?: string;
				/** Test-only session model exposed through the AgentSession accessors. */
				sessionModel?: string;
				/** Test-only effective thinking level exposed through the AgentSession accessors. */
				sessionThinkingLevel?: string;
		  };
}

export type IntercomBridgeMode = "off" | "fork-only" | "always";

export interface IntercomBridgeConfig {
	mode?: IntercomBridgeMode;
	instructionFile?: string;
}

interface TopLevelParallelConfig {
	maxTasks?: number;
	concurrency?: number;
}

export interface ExtensionConfig {
	defaultSessionDir?: string;
	maxSubagentDepth?: number;
	control?: ControlConfig;
	parallel?: TopLevelParallelConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	intercomBridge?: IntercomBridgeConfig;
}
