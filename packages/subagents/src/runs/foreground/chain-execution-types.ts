import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@bastani/atomic";
import type { AgentConfig } from "../../agents/agents.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import type {
	ChainStep,
	ParallelStep,
	ResolvedStepBehavior,
} from "../../shared/settings.ts";
import type {
	ActivityState,
	AgentProgress,
	ArtifactConfig,
	ArtifactPaths,
	ControlEvent,
	Details,
	IntercomEventBus,
	NestedRouteInfo,
	ResolvedControlConfig,
	SingleResult,
} from "../../shared/types.ts";
import type { ChainOutputMap } from "../../shared/types.ts";
import type { WorktreeSetup } from "../shared/worktree.ts";
import type { runSync } from "./execution.ts";

export type RunSyncDependency = typeof runSync;

export type ChainForegroundControl = {
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
};

export interface ChainExecutionDetailsInput {
	results: SingleResult[];
	includeProgress?: boolean;
	allProgress: AgentProgress[];
	allArtifactPaths: ArtifactPaths[];
	artifactsDir: string;
	chainAgents: string[];
	chainSteps: ChainStep[];
	totalSteps: number;
	currentStepIndex?: number;
	runId: string;
	outputs?: ChainOutputMap;
	currentFlatIndex?: number;
	dynamicChildren?: Record<number, Array<{ agent: string; label?: string; flatIndex: number; itemKey: string; outputName?: string; structured?: boolean; error?: string }>>;
	dynamicGroupStatuses?: Record<number, { status: "pending" | "running" | "completed" | "failed" | "paused" | "detached"; error?: string }>;
}

export interface ChainExecutionParams {
	chain: ChainStep[];
	task?: string;
	agents: AgentConfig[];
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	signal?: AbortSignal;
	runId: string;
	cwd?: string;
	shareEnabled: boolean;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	artifactsDir: string;
	artifactConfig: ArtifactConfig;
	includeProgress?: boolean;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: ChainForegroundControl;
	chainSkills?: string[];
	chainDir?: string;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	workflowStageSubagentGuard?: boolean;
	nestedRoute?: NestedRouteInfo;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	runSync?: RunSyncDependency;
}

export interface ChainExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

export interface ParallelChainRunInput {
	step: ParallelStep;
	parallelTemplates: string[];
	parallelBehaviors: ResolvedStepBehavior[];
	agents: AgentConfig[];
	stepIndex: number;
	availableModels: ModelInfo[];
	knownModelProviders: string[];
	chainDir: string;
	prev: string;
	originalTask: string;
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	cwd?: string;
	runId: string;
	globalTaskIndex: number;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	shareEnabled: boolean;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	signal?: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: ChainForegroundControl;
	results: SingleResult[];
	allProgress: AgentProgress[];
	outputs: ChainOutputMap;
	chainAgents: string[];
	chainSteps: ChainStep[];
	totalSteps: number;
	dynamicChildren?: ChainExecutionDetailsInput["dynamicChildren"];
	dynamicGroupStatuses?: ChainExecutionDetailsInput["dynamicGroupStatuses"];
	worktreeSetup?: WorktreeSetup;
	maxSubagentDepth: number;
	workflowStageSubagentGuard?: boolean;
	nestedRoute?: NestedRouteInfo;
	runSync: RunSyncDependency;
}

export interface ChainExecutionMutableState {
	results: SingleResult[];
	outputs: ChainOutputMap;
	dynamicChildren: NonNullable<ChainExecutionDetailsInput["dynamicChildren"]>;
	dynamicGroupStatuses: NonNullable<ChainExecutionDetailsInput["dynamicGroupStatuses"]>;
	allProgress: AgentProgress[];
	allArtifactPaths: ArtifactPaths[];
	prev: string;
	globalTaskIndex: number;
	progressCreated: boolean;
}

export interface ChainRuntimeContext {
	params: ChainExecutionParams;
	agents: AgentConfig[];
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	signal?: AbortSignal;
	runId: string;
	cwd?: string;
	shareEnabled: boolean;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	artifactsDir: string;
	artifactConfig: ArtifactConfig;
	includeProgress?: boolean;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: ChainForegroundControl;
	chainSkills: string[];
	chainDir: string;
	availableModels: ModelInfo[];
	knownModelProviders: string[];
	originalTask: string;
	chainAgents: string[];
	chainSteps: ChainStep[];
	totalSteps: number;
	executeRunSync: RunSyncDependency;
	makeDetailsInput(overrides?: Pick<Partial<ChainExecutionDetailsInput>, "currentStepIndex" | "currentFlatIndex">): ChainExecutionDetailsInput;
}
