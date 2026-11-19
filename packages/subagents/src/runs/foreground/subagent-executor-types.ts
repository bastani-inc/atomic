import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, SessionManager } from "@bastani/atomic";
import type { AgentConfig, AgentDiscoveryOptions, AgentScope } from "../../agents/agents.js";
import type { IntercomBridgeState } from "../../intercom/intercom-bridge.js";
import type { ModelInfo } from "../../shared/model-info.js";
import type {
	ArtifactConfig,
	ControlConfig,
	MaxOutputConfig,
	ResolvedControlConfig,
	SUBAGENT_ACTIONS,
	SubagentState,
	SubagentToolResult,
} from "../../shared/types.js";
import type { ChildModePolicy } from "../inprocess/child-policy.js";
import type { NamedWorktree, NamedWorktreeRequest } from "../shared/named-worktree.js";
import type { runSync } from "./execution.js";

export const BURST_TASK_DISCOVERY_CWD = Symbol("burstTaskDiscoveryCwd");
/** The caller's tasks[] index before prepending a mixed call's top-level child, for input diagnostics. */
export const BURST_TASK_INPUT_INDEX = Symbol("burstTaskInputIndex");
/** Retain the expanded tasks' actual working directories for call-local output checks if a merged run fails. */
export const BURST_PREPARED_TASKS = Symbol("burstPreparedTasks");
/** Let each caller render its own range of a completed SDK batch; run-wide guidance is not an answer. */
export const BURST_ANSWERS = Symbol("burstAnswers");
/** The named worktree a launch's child runs in, once it exists (#5202). */
export const NAMED_WORKTREE = Symbol("namedWorktree");

/** Bridges and direct model calls have no caller; nested invocations carry their own cancellation lifetime. */
export function isScriptSubagentCall(ctx: ExtensionContext & Pick<ExtensionToolContext, "parentToolCallId">): boolean {
	return ctx.parentToolCallId !== undefined;
}

export interface TaskParam {
	agent: string;
	task: string;
	cwd?: string;
	worktree?: NamedWorktreeRequest;
	[NAMED_WORKTREE]?: NamedWorktree;
	count?: number;
	[BURST_TASK_INPUT_INDEX]?: number;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | boolean;
	progress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	group?: string | true;
	heartbeatMs?: number;
}

export type BurstTaskParam = TaskParam & {
	[BURST_TASK_DISCOVERY_CWD]?: string;
};

export interface SubagentParamsLike {
	[BURST_PREPARED_TASKS]?: (tasks: TaskParam[]) => void;
	[BURST_ANSWERS]?: (render: (start: number, length: number) => string) => void;
	action?: (typeof SUBAGENT_ACTIONS)[number];
	id?: string;
	/** `action: "wait"` only: how long to wait for the task. */
	budgetMs?: number;
	heartbeatMs?: number;
	runId?: string;
	message?: string;
	all?: boolean;
	agent?: string;
	task?: string;
	config?: unknown;
	tasks?: TaskParam[];
	concurrency?: number;
	worktree?: boolean | NamedWorktreeRequest;
	[NAMED_WORKTREE]?: NamedWorktree;
	context?: "fresh" | "fork";
	share?: boolean;
	control?: ControlConfig;
	sessionDir?: string;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifacts?: boolean;
	includeProgress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	group?: string | true;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	progress?: boolean;
	agentScope?: string;
}

export interface SubagentExecutorRuntimeDeps {
	runSync: typeof runSync;
}

export interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: import("../../shared/types.js").ExtensionConfig;
	tempArtifactsDir?: string;
	getSubagentSessionRoot: (parentSessionFile: string | null, parentSessionId: string) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (
		cwd: string,
		scope: AgentScope,
		options: AgentDiscoveryOptions,
	) => { agents: AgentConfig[] } | Promise<{ agents: AgentConfig[] }>;
	allowMutatingManagementActions?: boolean;
	/** Typed admission policy; when present it is authoritative over the legacy boolean. */
	childPolicy?: ChildModePolicy;
	runtime?: Partial<SubagentExecutorRuntimeDeps>;
}

export function isManagementActionsRestricted(
	deps: Pick<ExecutorDeps, "childPolicy" | "allowMutatingManagementActions">,
): boolean {
	return deps.childPolicy
		? deps.childPolicy.managementActions === "restricted"
		: deps.allowMutatingManagementActions === false;
}
export interface ResolvedExecutorDeps extends Omit<ExecutorDeps, "runtime"> {
	runtime: SubagentExecutorRuntimeDeps;
}

export interface ExecutionContextData {
	params: SubagentParamsLike;
	effectiveCwd: string;
	ctx: ExtensionContext;
	signal: AbortSignal;
	onUpdate?: (r: SubagentToolResult) => void;
	agents: AgentConfig[];
	parallelAgentConfigs?: AgentConfig[];
	runId: string;
	shareEnabled: boolean;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionManagerForIndex: (idx?: number) => Promise<SessionManager | undefined>;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	parentDepth?: number;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
}

export interface PreparedExecutionContext {
	effectiveParams: SubagentParamsLike;
	effectiveCwd: string;
	runId: string;
	hasTasks: boolean;
	hasSingle: boolean;
	foregroundMode: "single" | "parallel";
	execData: ExecutionContextData;
	foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
}

export interface ExecutionContextBuildResult {
	prepared?: PreparedExecutionContext;
	error?: SubagentToolResult;
}

export type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
export type AvailableModelInfo = ModelInfo;
