/**
 * Recursion-depth guard helpers for nested subagent execution.
 */

import type { ExtensionContext } from "@bastani/atomic";
import { APP_NAME, getEnvValue, WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import { DEFAULT_SUBAGENT_MAX_DEPTH } from "./types-runtime.ts";

const ENV_PREFIX = APP_NAME.toUpperCase();
const SUBAGENT_MAX_DEPTH_ENV = `${ENV_PREFIX}_SUBAGENT_MAX_DEPTH`;
const SUBAGENT_DEPTH_ENV = `${ENV_PREFIX}_SUBAGENT_DEPTH`;
export { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV };

// ============================================================================

export function normalizeMaxSubagentDepth(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
	return normalizeMaxSubagentDepth(getEnvValue(SUBAGENT_MAX_DEPTH_ENV))
		?? normalizeMaxSubagentDepth(configMaxDepth)
		?? DEFAULT_SUBAGENT_MAX_DEPTH;
}

export function resolveChildMaxSubagentDepth(parentMaxDepth: number, agentMaxDepth?: number): number {
	const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
	return normalizedAgent === undefined ? normalizedParent : Math.min(normalizedParent, normalizedAgent);
}

export function hasWorkflowStageSubagentGuard(): boolean {
	return getEnvValue(WORKFLOW_STAGE_SUBAGENT_GUARD_ENV) === "1";
}

export function isWorkflowStageOrchestrationContext(ctx: Pick<ExtensionContext, "orchestrationContext">): boolean {
	return ctx.orchestrationContext?.kind === "workflow-stage";
}

export function resolveWorkflowStageMaxSubagentDepth(
	ctx: Pick<ExtensionContext, "orchestrationContext">,
	configMaxDepth?: number,
): number {
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
	return isWorkflowStageOrchestrationContext(ctx)
		// Workflow stages use the same two-hop default as main chat. A 0-depth
		// constraint still preserves one child-subagent hop so configured workflow
		// stages can delegate at least once.
		? Math.min(maxDepth, Math.max(1, ctx.orchestrationContext?.constraints.maxSubagentDepth ?? 1))
		: maxDepth;
}

export interface SubagentDepthPolicy {
	maxSubagentDepth: number;
	workflowStageSubagentGuard: boolean;
}

export function resolveSubagentDepthPolicy(
	ctx: Pick<ExtensionContext, "orchestrationContext">,
	configMaxDepth?: number,
): SubagentDepthPolicy {
	return {
		maxSubagentDepth: resolveWorkflowStageMaxSubagentDepth(ctx, configMaxDepth),
		workflowStageSubagentGuard: isWorkflowStageOrchestrationContext(ctx),
	};
}

function workflowStageSubagentDepthMessage(depth: number, maxDepth: number, action: "call" | "resume" = "call"): string {
	return `Nested subagent ${action} blocked (depth=${depth}, max=${maxDepth}). Sub-agents inside workflow stages are running at the maximum nesting depth.`;
}

export function subagentDepthBlockedMessage(
	depth: number,
	maxDepth: number,
	options?: { action?: "call" | "resume"; workflowStageGuard?: boolean },
): string {
	const action = options?.action ?? "call";
	if (options?.workflowStageGuard) {
		return workflowStageSubagentDepthMessage(depth, maxDepth, action);
	}
	if (action === "resume") {
		return `Nested subagent resume blocked (depth=${depth}, max=${maxDepth}). Complete the follow-up directly instead.`;
	}
	return `Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
		"You are running at the maximum subagent nesting depth. " +
		"Complete your current task directly without delegating to further subagents.";
}

export interface SubagentDepthCheck {
	blocked: boolean;
	depth: number;
	maxDepth: number;
	workflowStageGuard: boolean;
}

export function checkSubagentDepth(configMaxDepth?: number): SubagentDepthCheck {
	const depth = Number(getEnvValue(SUBAGENT_DEPTH_ENV) ?? "0");
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
	const blocked = Number.isFinite(depth) && depth >= maxDepth;
	return { blocked, depth, maxDepth, workflowStageGuard: hasWorkflowStageSubagentGuard() };
}

export function getSubagentDepthEnv(maxDepth?: number, options?: { workflowStageSubagentGuard?: boolean }): Record<string, string> {
	const parentDepth = Number(getEnvValue(SUBAGENT_DEPTH_ENV) ?? "0");
	// Preserve an inherited workflow-stage marker for descendants; callers that
	// mutate process.env in tests must clear it to avoid intentional propagation.
	const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
	return {
		[SUBAGENT_DEPTH_ENV]: String(nextDepth),
		[SUBAGENT_MAX_DEPTH_ENV]: String(normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth()),
		...(options?.workflowStageSubagentGuard || hasWorkflowStageSubagentGuard()
			? { [WORKFLOW_STAGE_SUBAGENT_GUARD_ENV]: "1" }
			: {}),
	};
}

// ============================================================================
// Utility Functions
// ============================================================================
