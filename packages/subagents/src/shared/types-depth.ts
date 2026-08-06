/**
 * Recursion-depth guard helpers for nested subagent execution.
 */

import type { ExtensionContext, SessionWorkflowMetadata } from "@bastani/atomic";
import { DEFAULT_SUBAGENT_MAX_DEPTH, MAX_SUBAGENT_NESTING_DEPTH } from "./types-runtime.ts";

// Depth is admission state carried in the typed child policy, not process environment.

// ============================================================================
export function normalizeMaxSubagentDepth(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return Math.min(parsed, MAX_SUBAGENT_NESTING_DEPTH);
}

/**
 * The effective limit is the stricter of the local configuration and any limit
 * inherited through the child policy, both clamped by the global ceiling.
 */
export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number, inheritedMaxDepth?: number): number {
	const local = normalizeMaxSubagentDepth(configMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	const inherited = normalizeMaxSubagentDepth(inheritedMaxDepth);
	return inherited === undefined ? local : Math.min(local, inherited);
}

/** Read the delegation limit a parent admission issued to this child session. */
export function getInheritedMaxSubagentDepth(
	ctx: Partial<Pick<ExtensionContext, "subagentPolicy">>,
): number | undefined {
	return ctx.subagentPolicy?.maxSubagentDepth;
}

export function resolveChildMaxSubagentDepth(parentMaxDepth: number, agentMaxDepth?: number): number {
	const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
	return normalizedAgent === undefined ? normalizedParent : Math.min(normalizedParent, normalizedAgent);
}

export function isWorkflowStageOrchestrationContext(ctx: Pick<ExtensionContext, "orchestrationContext">): boolean {
	return ctx.orchestrationContext?.kind === "workflow-stage";
}

export function workflowSessionMetadataFromContext(
	ctx: Pick<ExtensionContext, "orchestrationContext">,
): SessionWorkflowMetadata | undefined {
	const orchestration = ctx.orchestrationContext;
	if (orchestration?.kind !== "workflow-stage") return undefined;
	return {
		runId: orchestration.workflowRunId,
		stageId: orchestration.workflowStageId,
		stageName: orchestration.workflowStageName,
	};
}

export function resolveWorkflowStageMaxSubagentDepth(
	ctx: Pick<ExtensionContext, "orchestrationContext"> & Partial<Pick<ExtensionContext, "subagentPolicy">>,
	configMaxDepth?: number,
): number {
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth, getInheritedMaxSubagentDepth(ctx));
	return isWorkflowStageOrchestrationContext(ctx)
		? // Workflow stages receive an explicit host constraint, clamped by the
			// inherited/global nesting ceiling. A 0-depth workflow constraint still
			// preserves one child-subagent hop so configured stages can delegate once.
			Math.min(maxDepth, Math.max(1, ctx.orchestrationContext?.constraints.maxSubagentDepth ?? 1))
		: maxDepth;
}

export interface SubagentDepthPolicy {
	maxSubagentDepth: number;
	workflowStageSubagentGuard: boolean;
}

export function resolveSubagentDepthPolicy(
	ctx: Pick<ExtensionContext, "orchestrationContext"> & Partial<Pick<ExtensionContext, "subagentPolicy">>,
	configMaxDepth?: number,
): SubagentDepthPolicy {
	return {
		maxSubagentDepth: resolveWorkflowStageMaxSubagentDepth(ctx, configMaxDepth),
		workflowStageSubagentGuard: isWorkflowStageOrchestrationContext(ctx),
	};
}

function workflowStageSubagentDepthMessage(
	depth: number,
	maxDepth: number,
	action: "call" | "resume" = "call",
): string {
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
	return (
		`Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
		"You are running at the maximum subagent nesting depth. " +
		"Complete your current task directly without delegating to further subagents."
	);
}

export interface SubagentDepthCheck {
	blocked: boolean;
	depth: number;
	maxDepth: number;
}

/** Read the admitted depth carried by an in-process child session. */
export function getCurrentSubagentDepth(ctx: Pick<ExtensionContext, "subagentPolicy">): number {
	const depth = ctx.subagentPolicy?.depth;
	return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : 0;
}

export function checkSubagentDepth(
	ctx: Pick<ExtensionContext, "subagentPolicy">,
	configMaxDepth?: number,
): SubagentDepthCheck {
	const depth = getCurrentSubagentDepth(ctx);
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth, getInheritedMaxSubagentDepth(ctx));
	return { blocked: Number.isFinite(depth) && depth >= maxDepth, depth, maxDepth };
}

// ============================================================================
// Utility Functions
// ============================================================================
