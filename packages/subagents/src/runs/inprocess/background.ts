import type { ExtensionAPI, SessionWorkflowMetadata } from "@bastani/atomic";
import type { AgentConfig } from "../../agents/agents.ts";
import type { SupervisorAuthorization } from "../../intercom/supervisor-authorization.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import type { RunSyncOptions } from "../../shared/types.ts";

export interface AsyncExecutionContext {
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
	currentModelProvider?: string;
	currentModel?: string;
	intercomGroup?: string;
	workflowSessionMetadata?: SessionWorkflowMetadata;
}

export interface AsyncSingleParams {
	agent: string;
	task?: string;
	group?: string | true;
	agentConfig: AgentConfig;
	ctx: AsyncExecutionContext;
	cwd?: string;
	maxOutput?: { bytes?: number; lines?: number };
	artifactsDir?: string;
	artifactConfig: {
		enabled: boolean;
		includeInput: boolean;
		includeOutput: boolean;
		includeJsonl: boolean;
		includeMetadata: boolean;
		cleanupDays: number;
	};
	shareEnabled: boolean;
	sessionRoot?: string;
	sessionFile?: string;
	skills?: string[];
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	progress?: boolean;
	modelOverride?: string;
	availableModels?: ModelInfo[];
	knownModelProviders?: string[];
	maxSubagentDepth: number;
	workflowStageSubagentGuard?: boolean;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: import("../../shared/types.ts").ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	supervisorAuthorization?: SupervisorAuthorization;
	nestedRoute?: import("../../shared/types.ts").NestedRouteInfo;
	/** Internal seam used by focused runtime tests. */
	testSession?: RunSyncOptions["testSession"];
}

export interface AsyncExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: import("../../shared/types.ts").Details;
	isError?: boolean;
}

export function formatAsyncStartedMessage(headline: string): string {
	return [
		`Launched: ${headline}`,
		"Completion pending; Atomic will deliver the result when the in-process child finishes.",
		"",
		"The async child is tied to the current parent process and does not survive parent exit.",
		'Use subagent({ action: "status", id: "..." }) when you need the current status/result.',
	].join("\n");
}

/** Async execution is always available because it no longer depends on a jiti child process. */
export function isAsyncAvailable(): boolean {
	return true;
}

export function formatAsyncStartError(mode: "single" | "parallel" | "chain", message: string): AsyncExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}

export const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: subagent";

export class UnavailableSubagentSkillError extends Error {}
export class AsyncStartValidationError extends Error {}
