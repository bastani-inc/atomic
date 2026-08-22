import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import type { AgentConfig, AgentScope } from "../../agents/agents.js";
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
import type { runSync } from "./execution.js";

export const BURST_TASK_DISCOVERY_CWD = Symbol("burstTaskDiscoveryCwd");

export interface TaskParam {
	agent: string;
	task: string;
	cwd?: string;
	count?: number;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | boolean;
	progress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	group?: string | true;
}

export type BurstTaskParam = TaskParam & {
	[BURST_TASK_DISCOVERY_CWD]?: string;
};

export interface SubagentParamsLike {
	action?: (typeof SUBAGENT_ACTIONS)[number];
	id?: string;
	runId?: string;
	index?: number;
	agent?: string;
	task?: string;
	message?: string;
	config?: unknown;
	tasks?: TaskParam[];
	concurrency?: number;
	worktree?: boolean;
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
	tempArtifactsDir: string;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[] };
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
	sessionFileForIndex: (idx?: number) => string | undefined;
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
