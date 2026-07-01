/**
 * Configuration, execution option, display, and event bus types.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { NestedRouteInfo } from "./types-async.ts";
import type {
	ArtifactConfig,
	ControlConfig,
	ControlEvent,
	Details,
	JsonSchemaObject,
	MaxOutputConfig,
	OutputMode,
	ResolvedControlConfig,
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
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
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
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig?: ResolvedControlConfig;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
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
	workflowStageSubagentGuard?: boolean;
	nestedRoute?: NestedRouteInfo;
	/** Override the agent's default model (format: "provider/id" or just "id") */
	modelOverride?: string;
	/** Registry models available for heuristic bare-model resolution */
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	/** Providers known to the registry before auth filtering */
	knownModelProviders?: string[];
	/** Current parent-session provider to prefer for ambiguous bare model ids */
	preferredModelProvider?: string;
	/** Current parent-session model to try after configured fallback models */
	currentModel?: string;
	/** Skills to inject (overrides agent default if provided) */
	skills?: string[];
	structuredOutput?: {
		schema: JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
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

interface ExtensionChainConfig {
	dynamicFanout?: {
		maxItems?: number;
	};
}

export interface ExtensionConfig {
	asyncByDefault?: boolean;
	forceTopLevelAsync?: boolean;
	defaultSessionDir?: string;
	maxSubagentDepth?: number;
	control?: ControlConfig;
	parallel?: TopLevelParallelConfig;
	chain?: ExtensionChainConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	intercomBridge?: IntercomBridgeConfig;
}
