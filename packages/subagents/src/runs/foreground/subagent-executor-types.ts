import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import type { AgentConfig, AgentScope } from "../../agents/agents.ts";
import type { IntercomBridgeState } from "../../intercom/intercom-bridge.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import type { ArtifactConfig, ControlConfig, MaxOutputConfig, NestedRouteInfo, ResolvedControlConfig, SubagentState, SubagentToolResult, SUBAGENT_ACTIONS } from "../../shared/types.ts";
import type { ChainStep } from "../../shared/settings.ts";
import type { executeAsyncChain, executeAsyncSingle, formatAsyncStartedMessage, isAsyncAvailable } from "../background/async-execution.ts";
import type { runSync } from "./execution.ts";

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
}

export interface SubagentParamsLike {
	action?: (typeof SUBAGENT_ACTIONS)[number];
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
	agent?: string;
	task?: string;
	message?: string;
	chainName?: string;
	config?: unknown;
	chain?: ChainStep[];
	tasks?: TaskParam[];
	concurrency?: number;
	worktree?: boolean;
	context?: "fresh" | "fork";
	async?: boolean;
	share?: boolean;
	control?: ControlConfig;
	sessionDir?: string;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifacts?: boolean;
	includeProgress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	agentScope?: string;
	chainDir?: string;
}

export interface SubagentExecutorRuntimeDeps {
	runSync: typeof runSync;
	executeAsyncChain: typeof executeAsyncChain;
	executeAsyncSingle: typeof executeAsyncSingle;
	isAsyncAvailable: typeof isAsyncAvailable;
	formatAsyncStartedMessage: typeof formatAsyncStartedMessage;
}

export interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: import("../../shared/types.ts").ExtensionConfig;
	asyncByDefault: boolean;
	tempArtifactsDir: string;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[] };
	allowMutatingManagementActions?: boolean;
	runtime?: Partial<SubagentExecutorRuntimeDeps>;
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
	runId: string;
	shareEnabled: boolean;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionFileForIndex: (idx?: number) => string | undefined;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	effectiveAsync: boolean;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	nestedRoute?: NestedRouteInfo;
}

export interface PreparedExecutionContext {
	effectiveParams: SubagentParamsLike;
	effectiveCwd: string;
	runId: string;
	hasChain: boolean;
	hasTasks: boolean;
	hasSingle: boolean;
	foregroundMode: "single" | "parallel" | "chain";
	execData: ExecutionContextData;
	foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
	writeNestedForegroundEvent: (type: "subagent.nested.started" | "subagent.nested.completed", result?: SubagentToolResult) => void;
}

export interface ExecutionContextBuildResult {
	prepared?: PreparedExecutionContext;
	error?: SubagentToolResult;
}

export type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
export type AvailableModelInfo = ModelInfo;
