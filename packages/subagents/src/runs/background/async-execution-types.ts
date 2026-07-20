import type { ExtensionAPI, SessionWorkflowMetadata } from "@bastani/atomic";
import type { AgentConfig } from "../../agents/agents.ts";
import type { ChainStep } from "../../shared/settings.ts";
import type { AvailableModelInfo } from "../shared/model-fallback.ts";
import type { SupervisorAuthorization } from "../../intercom/supervisor-authorization.ts";
import type {
	ArtifactConfig,
	Details,
	MaxOutputConfig,
	NestedRouteInfo,
	ResolvedControlConfig,
	SubagentRunMode,
} from "../../shared/types.ts";

export interface AsyncExecutionContext {
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
	currentModelProvider?: string;
	currentModel?: string;
	workflowSessionMetadata?: SessionWorkflowMetadata;
}

export interface AsyncChainParams {
	chain: ChainStep[];
	task?: string;
	resultMode?: Exclude<SubagentRunMode, "single">;
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	knownModelProviders?: string[];
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	workflowStageSubagentGuard?: boolean;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	supervisorAuthorizations?: Array<SupervisorAuthorization | undefined>;
	dynamicSupervisorAuthorizations?: Record<number, SupervisorAuthorization[]>;
	nestedRoute?: NestedRouteInfo;
}

export interface AsyncSingleParams {
	agent: string;
	task?: string;
	agentConfig: AgentConfig;
	ctx: AsyncExecutionContext;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	sessionFile?: string;
	skills?: string[];
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	progress?: boolean;
	modelOverride?: string;
	availableModels?: AvailableModelInfo[];
	knownModelProviders?: string[];
	maxSubagentDepth: number;
	workflowStageSubagentGuard?: boolean;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	supervisorAuthorization?: SupervisorAuthorization;
	nestedRoute?: NestedRouteInfo;
	/** Internal launch seam used by focused runtime tests. */
	spawnRunner?: (
		config: object,
		suffix: string,
		cwd: string,
		env?: Record<string, string>,
	) => AsyncSpawnResult;
}

export interface AsyncExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

export interface AsyncSpawnResult {
	pid?: number;
	error?: string;
}
