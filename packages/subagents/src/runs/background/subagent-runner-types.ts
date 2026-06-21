import type { Message } from "@earendil-works/pi-ai";
import type {
	ActivityState,
	ArtifactConfig,
	ArtifactPaths,
	AsyncParallelGroupStatus,
	AsyncStatus,
	ChainOutputMap,
	MaxOutputConfig,
	ModelAttempt,
	NestedRouteInfo,
	ResolvedControlConfig,
	SubagentRunMode,
	Usage,
	WorkflowGraphSnapshot,
} from "../../shared/types.ts";
import type { TokenUsage } from "../../shared/types.ts";
import type { RunnerStep, RunnerSubagentStep as SubagentStep } from "../shared/parallel-utils.ts";
import type { WorktreeSetup } from "../shared/worktree.ts";

export interface SubagentRunConfig {
	id: string;
	steps: RunnerStep[];
	resultPath: string;
	cwd: string;
	placeholder: string;
	taskIndex?: number;
	totalTasks?: number;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	share?: boolean;
	sessionDir?: string;
	asyncDir: string;
	sessionId?: string | null;
	piPackageRoot?: string;
	piArgv1?: string;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTargets?: Array<string | undefined>;
	resultMode?: SubagentRunMode;
	dynamicFanoutMaxItems?: number;
	workflowGraph?: WorkflowGraphSnapshot;
	nestedRoute?: NestedRouteInfo;
	workflowStageSubagentGuard?: boolean;
	nestedSelf?: { parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }> };
}

export interface StepResult {
	agent: string;
	output: string;
	error?: string;
	success: boolean;
	exitCode?: number | null;
	skipped?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	model?: string;
	fastMode?: boolean;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	truncated?: boolean;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
}

export interface ChildEventContext {
	eventsPath: string;
	runId: string;
	stepIndex: number;
	agent: string;
}

export interface ChildUsage {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export type ChildMessage = Message & {
	model?: string;
	errorMessage?: string;
	usage?: ChildUsage;
};

export interface ChildEvent {
	type?: string;
	message?: ChildMessage;
	toolName?: string;
	args?: Record<string, unknown>;
}

export interface RunPiStreamingResult {
	stderr: string;
	exitCode: number | null;
	messages: Message[];
	usage: Usage;
	model?: string;
	error?: string;
	finalOutput: string;
	interrupted?: boolean;
	modelFailureSignal?: unknown;
}

export interface SingleStepContext {
	previousOutput: string;
	outputs?: ChainOutputMap;
	placeholder: string;
	cwd: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	id: string;
	flatIndex: number;
	flatStepCount: number;
	outputFile: string;
	piPackageRoot?: string;
	piArgv1?: string;
	registerInterrupt?: (interrupt: (() => void) | undefined) => void;
	childIntercomTarget?: string;
	orchestratorIntercomTarget?: string;
	nestedRoute?: NestedRouteInfo;
	onAttemptStart?: (attempt: { model?: string; thinking?: string; fastMode?: boolean }) => void;
	onChildEvent?: (event: ChildEvent) => void;
	workflowStageSubagentGuard?: boolean;
}

export type RunnerStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
	exitCode?: number | null;
};

export type RunnerStatusPayload = Omit<AsyncStatus, "steps" | "parallelGroups" | "pid" | "cwd" | "currentStep" | "chainStepCount" | "lastUpdate"> & {
	pid: number;
	cwd: string;
	currentStep: number;
	chainStepCount: number;
	parallelGroups: AsyncParallelGroupStatus[];
	steps: RunnerStatusStep[];
	lastUpdate: number;
	artifactsDir?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	error?: string;
};

export interface RunnerExecutionState {
	config: SubagentRunConfig;
	id: string;
	steps: RunnerStep[];
	resultPath: string;
	cwd: string;
	placeholder: string;
	taskIndex?: number;
	totalTasks?: number;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	previousOutput: string;
	outputs: ChainOutputMap;
	results: StepResult[];
	overallStartTime: number;
	shareEnabled: boolean;
	asyncDir: string;
	statusPath: string;
	eventsPath: string;
	logPath: string;
	controlConfig: ResolvedControlConfig;
	activeChildInterrupt?: (() => void) | undefined;
	interrupted: boolean;
	currentActivityState?: ActivityState;
	activityTimer?: NodeJS.Timeout;
	previousCumulativeTokens: TokenUsage;
	latestSessionFile?: string;
	flatSteps: SubagentStep[];
	sessionEnabled: boolean;
	statusPayload: RunnerStatusPayload;
	flatIndex: number;
	mutatingFailureStates: Array<ReturnType<typeof import("../shared/long-running-guard.ts").createMutatingFailureState>>;
	pendingToolResults: Array<{ tool: string; path?: string; mutates: boolean; startedAt?: number } | undefined>;
	emittedControlEventKeys: Set<string>;
	activeLongRunningSteps: Set<number>;
}

export type ParallelGroup = Extract<RunnerStep, { parallel: SubagentStep[] }>;
export type DynamicGroup = Extract<RunnerStep, { collect: { as: string } }>;
export type { SubagentStep, RunnerStep, WorktreeSetup };
